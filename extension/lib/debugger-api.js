// chrome.debugger 封装:attach / sendCommand / detach,按 tabId 串行。
// 仿 browser-control-bridge 的 src/background/debuggerApi.ts,简化。

const attachedTabs = new Set();
const tabQueues = new Map();   // tabId -> Promise chain
const DEFAULT_CDP_TIMEOUT_MS = 10000;

export function registerDetachListener() {
  chrome.debugger.onDetach.addListener((source) => {
    if (typeof source.tabId === "number") attachedTabs.delete(source.tabId);
  });
}

export async function attachTab(tabId) {
  await withQueue(tabId, () => ensureAttached(tabId));
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
    }
  });
}

export async function detachAll() {
  const ids = [...attachedTabs];
  await Promise.allSettled(ids.map((t) => detachTab(t)));
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
