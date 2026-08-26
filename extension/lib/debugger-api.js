// chrome.debugger 封装:attach / sendCommand / detach,按 tabId 串行。
// 仿 browser-control-bridge 的 src/background/debuggerApi.ts,简化。

const attachedTabs = new Set();
const tabQueues = new Map();   // tabId -> Promise chain
const DEFAULT_CDP_TIMEOUT_MS = 10000;
// attachedTabs 的持久化镜像:SW 重启后内存集合为空,而 chrome.debugger 没有
// 枚举接口,detachAll 只能靠这份记录清掉重启前的残留附着。
const ATTACHED_STORAGE_KEY = "jsAttachedTabIds";
export function registerDetachListener() {
  chrome.debugger.onDetach.addListener((source) => {
    if (typeof source.tabId === "number") {
      attachedTabs.delete(source.tabId);
      void persistAttachedTabs();
    }
  });
}

// 持久化失败只记日志:内存态仍是权威,不能因为 storage 问题影响爬取。
// 写入必须排在 hydration 之后:否则 SW 重启后第一次 attach 会用纯内存集合
// (不含重启前残留)覆写存储,旧附着 id 被抹掉 → detachAll 清不掉残留。
const hydration = loadPersistedAttachedTabs()
  .then((ids) => {
    for (const id of ids) attachedTabs.add(id);
  })
  .catch((err) => {
    // 水合失败只记日志;catch 确保 persist 的 await(hydration)永不悬挂。
    console.warn("debugger-api: 恢复 attachedTabs 失败:", err?.message ?? err);
  });

async function persistAttachedTabs() {
  await hydration;
  try {
    await chrome.storage.local.set({ [ATTACHED_STORAGE_KEY]: [...attachedTabs] });
  } catch (err) {
    console.warn("debugger-api: 持久化 attachedTabs 失败:", err?.message ?? err);
  }
}

async function loadPersistedAttachedTabs() {
  try {
    const stored = (await chrome.storage.local.get(ATTACHED_STORAGE_KEY))[ATTACHED_STORAGE_KEY];
    return Array.isArray(stored) ? stored.filter((id) => typeof id === "number") : [];
  } catch (err) {
    console.warn("debugger-api: 读取 attachedTabs 失败:", err?.message ?? err);
    return [];
  }
}

/**
 * Attach the debugger to ``tabId`` (idempotent), recovering from a stale
 * already-attached state. Must be called from within a ``withQueue(tabId)``
 * scope — it never queues itself, so executeCdp can reuse it without a
 * re-entrant withQueue deadlock.
 */
async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedTabs.add(tabId);
    await persistAttachedTabs();
  } catch (err) {
    // 重复 attach:若我们未登记但 Chrome 认为已附着,可能是自己残留,尝试当成功。
    // 若是「另一个扩展/工具」占着 debugger,绝不能假成功,否则 sendCommand 会挂死。
    if (isAlreadyAttachedError(err)) {
      // 只有确认是本扩展会话时才登记;否则抛出,让调用方重试/降级。
      // Chrome 无法区分「自己 vs 他人」,保守策略:先 detach 再 attach 一次。
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        /* ignore */
      }
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
        attachedTabs.add(tabId);
        await persistAttachedTabs();
        return;
      } catch (err2) {
        attachedTabs.delete(tabId);
        throw new Error(
          `Cannot attach debugger to tab ${tabId}: ${err2?.message ?? err2} ` +
            `(original: ${err?.message ?? err}). Another tool may hold the debugger.`
        );
      }
    }
    attachedTabs.delete(tabId);
    throw err;
  }
}

export async function detachTab(tabId) {
  await withQueue(tabId, async () => {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      /* already detached */
    } finally {
      attachedTabs.delete(tabId);
      await persistAttachedTabs();
    }
  });
}

export async function detachAll() {
  // 水合在模块初始化时已完成(见顶部 hydration):内存集合即权威,含重启前
  // 的残留附着。直接逐个 detach,最后清掉存储键;storage 失败不影响 detach 本身。
  await hydration;
  const ids = [...attachedTabs];
  await Promise.allSettled(ids.map((t) => detachTab(t)));
  try {
    await chrome.storage.local.remove(ATTACHED_STORAGE_KEY);
  } catch (err) {
    console.warn("debugger-api: 清理 attachedTabs 失败:", err?.message ?? err);
  }
}

/**
 * 执行任意 CDP 命令,带超时。
 * - 整个 attach+sendCommand 按 tab 串行,避免同 tab 命令交错挂起
 * - 超时后 detach,清掉假 attached 状态,便于下次重建
 */
export async function executeCdp({ tabId, method, params = {}, timeoutMs }) {
  const timeout = normalizeTimeout(timeoutMs);
  return withQueue(tabId, async () => {
    await ensureAttached(tabId);

    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`CDP command "${method}" timed out after ${timeout}ms`));
      }, timeout);
    });
    try {
      return await Promise.race([
        chrome.debugger.sendCommand({ tabId }, method, params),
        timeoutPromise,
      ]);
    } catch (err) {
      // 超时或 debugger 异常:释放 attach,避免后续假成功挂死
      if (isTimeoutError(err) || isDebuggerGoneError(err)) {
        try {
          await chrome.debugger.detach({ tabId });
        } catch {
          /* ignore */
        }
        attachedTabs.delete(tabId);
        await persistAttachedTabs();
      }
      throw err;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  });
}

function normalizeTimeout(ms) {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_CDP_TIMEOUT_MS;
}

function isAlreadyAttachedError(err) {
  const msg = String(err?.message ?? err);
  return (
    msg.includes("Another debugger is already attached") ||
    msg.includes("already attached")
  );
}

function isTimeoutError(err) {
  return /timed out after/i.test(String(err?.message ?? err));
}

function isDebuggerGoneError(err) {
  const msg = String(err?.message ?? err);
  return (
    msg.includes("Debugger is not attached") ||
    msg.includes("Detached while") ||
    msg.includes("not attached to the tab")
  );
}

/**
 * 按 tabId 串行化操作。attach / sendCommand / detach 共用同一条链。
 */
async function withQueue(tabId, operation) {
  const previous = tabQueues.get(tabId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const chained = previous.catch(() => {}).then(() => current);
  tabQueues.set(tabId, chained);
  try {
    await previous.catch(() => {});
    return await operation();
  } finally {
    release();
    if (tabQueues.get(tabId) === chained) tabQueues.delete(tabId);
  }
}
