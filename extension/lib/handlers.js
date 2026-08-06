// RPC 方法实现:JustSearch 后端通过 JSON-RPC 调用这些方法驱动真实 Chrome。
// 注册到 JsonRpcBridge。

import { detachTab, executeCdp } from "./debugger-api.js";
import { TabGroupStore } from "./tab-groups.js";

// 光标到达等待器:moveSequence -> { resolve, timer }。
// moveMouse(waitForArrival=true) 注册一个,AGENT_CURSOR_ARRIVED 到达时 resolve。
const _cursorArrivalWaiters = new Map();
const CURSOR_ARRIVAL_TIMEOUT_MS = 1500;

// 注入点:由 background.js 在注册 handler 前设置,避免循环依赖。
let _cursorOverlays = null;
let _nextCursorMoveSequence = 1;

export function setCursorOverlayController(controller) {
  _cursorOverlays = controller;
}

export function getCursorOverlayController() {
  return _cursorOverlays;
}

// content script 上报光标到达 → 直接 resolve 对应的 moveMouse 等待器(进程内,不发回后端)。
export function notifyCursorArrived({ sessionId, turnId, moveSequence } = {}) {
  const key = `${sessionId ?? ""}:${turnId ?? ""}:${moveSequence ?? ""}`;
  const waiter = _cursorArrivalWaiters.get(key);
  if (waiter) waiter.resolve();
}

// 所有 agent 标签归入同一个全局分组,而不是按 session 分多组(多组占地方)。
// 光标 controller 仍按真实 session_id 运作(动画/turn 去重不受影响)。
const AGENT_GROUP_SESSION = "justsearch-agent";

// 全局 agent 标签集合(不按 session 分桶,因为分组是全局的)。
const _allAgentTabs = new Set();

// 分组操作的串行锁:并发 createTab 时,避免多个请求同时判定"无组存在"
// 而各自 createGroup 导致出现多个分组。所有 ensureAgentTabGroup 调用
// 必须排队执行,这样第一个请求建组后,后续请求能复用它。
let _groupOpChain = Promise.resolve();
function serializeGroupOp(fn) {
  const run = _groupOpChain.then(fn, fn);
  // 吞掉异常,保证链不断;调用方自己 try/catch。
  _groupOpChain = run.then(() => {}, () => {});
  return run;
}

export function registerHandlers(bridge) {
  const tabGroups = TabGroupStore.getInstance();

  bridge.registerRequestHandler("ping", async () => {
    const manifest = chrome.runtime.getManifest?.() || {};
    let instanceId = null;
    try {
      const stored = await chrome.storage.local.get("extensionInstanceId");
      instanceId = stored.extensionInstanceId || null;
    } catch {
      // ignore
    }
    return {
      ok: true,
      ts: Date.now(),
      name: typeof manifest.name === "string" ? manifest.name : "JustSearch Bridge",
      version: typeof manifest.version === "string" ? manifest.version : "0.0.0",
      instance_id: instanceId,
    };
  });

  bridge.registerRequestHandler("createTab", async ({ url, session_id } = {}) => {
    const sessionId = typeof session_id === "string" && session_id ? session_id : "default";
    const tab = await chrome.tabs.create({ url: url ?? "about:blank", active: false });
    // 归入唯一的全局 agent 分组。串行化 + 先登记 tab,保证并发 createTab
    // 复用同一组而非各建新组(SW 重启后还能从持久化的 groupMetadata 复用)。
    try {
      await serializeGroupOp(async () => {
        _allAgentTabs.add(tab.id);
        await tabGroups.ensureAgentTabGroup(AGENT_GROUP_SESSION, tab.id, [..._allAgentTabs]);
      });
    } catch (err) {
      // tabGroups API 可能不可用(权限/版本),降级为不分组,但仍登记 tab。
      _allAgentTabs.add(tab.id);
    }
    return { tabId: tab.id, url: tab.url ?? url ?? "about:blank" };
  });

  bridge.registerRequestHandler("closeTab", async ({ tabId, session_id } = {}) => {
    requireInt(tabId, "tabId");
    const sessionId = typeof session_id === "string" && session_id ? session_id : "default";
    try { await chrome.tabs.remove(tabId); } catch (err) {
      // 标签已不存在,忽略。
    }
    try { await detachTab(tabId); } catch {}
    try { await _cursorOverlays?.untrackTab(sessionId, tabId); } catch {}
    try { await tabGroups.refreshManagedGroupsFromChrome(); } catch {}
    _allAgentTabs.delete(tabId);
    return { ok: true };
  });

  bridge.registerRequestHandler("finalizeTabs", async ({ tabIds, session_id } = {}) => {
    if (!Array.isArray(tabIds)) throw new Error("finalizeTabs requires tabIds array");
    const sessionId = typeof session_id === "string" && session_id ? session_id : "default";
    await Promise.allSettled(tabIds.map((id) => {
      if (typeof id !== "number") return Promise.resolve();
      return chrome.tabs.remove(id).catch(() => {}).then(() => detachTab(id).catch(() => {}));
    }));
    // 关闭的标签从 managed group 移除(refresh 会清理空组)。
    try { await tabGroups.releaseTabsFromManagedGroups(tabIds); } catch {}
    try { await tabGroups.refreshManagedGroupsFromChrome(); } catch {}
    for (const id of tabIds) {
      if (typeof id === "number") {
        _allAgentTabs.delete(id);
        try { await _cursorOverlays?.untrackTab(sessionId, id); } catch {}
      }
    }
    return { ok: true };
  });

  bridge.registerRequestHandler("navigate", async ({ tabId, url, timeoutMs = 20000 } = {}) => {
    requireInt(tabId, "tabId");
    requireStr(url, "url");
    await chrome.tabs.update(tabId, { url });
    await waitForTabComplete(tabId, url, timeoutMs);
    const updated = await chrome.tabs.get(tabId);
    return { tabId, url: updated.url ?? url };
  });

  bridge.registerRequestHandler("getTabUrl", async ({ tabId } = {}) => {
    requireInt(tabId, "tabId");
    const t = await chrome.tabs.get(tabId);
    return { url: t.url ?? "" };
  });

  // 核心:在 tab 里跑任意 JS,返回 Runtime.evaluate 的 value。
  bridge.registerRequestHandler("evaluate", async ({ tabId, expression, awaitPromise = true, returnByValue = true, timeoutMs = 30000 } = {}) => {
    requireInt(tabId, "tabId");
    requireStr(expression, "expression");
    const result = await executeCdp({
      tabId,
      method: "Runtime.evaluate",
      params: { expression, awaitPromise, returnByValue, allowUnsafeEvalBlocking: false },
      timeoutMs,
    });
    // Runtime.evaluate 返回 { result: { type, value, ... }, exceptionDetails }
    if (!result) return { value: null };
    if (result.exceptionDetails) {
      const ex = result.exceptionDetails;
      const text = ex.exception?.description ?? ex.text ?? "eval error";
      throw new Error(`Runtime.evaluate failed: ${text}`);
    }
    return { value: result.result?.value ?? null, type: result.result?.type };
  });

  // Defuddle 正文抽取(ToMarkdown 同款引擎):scripting 注入 isolated world,不走 CDP evaluate。
  // 返回 { ok, text, strategy, useful, title, author, thin, ... } 供后端 extract_page_content 使用。
  bridge.registerRequestHandler("extractContent", async ({ tabId, timeoutMs = 45000 } = {}) => {
    requireInt(tabId, "tabId");
    const ms = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 45000;
    return withTimeout(extractWithDefuddle(tabId), ms, "extractContent");
  });

  bridge.registerRequestHandler("clickAt", async ({ tabId, x, y, button = "left", clickCount = 1 } = {}) => {
    requireInt(tabId, "tabId");
    requireNum(x, "x"); requireNum(y, "y");
    // Slightly longer than before: parallel crawls still stress debugger; 10s reduces flaky timeouts.
    const mouseTimeoutMs = 10000;
    await executeCdp({
      tabId,
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseMoved", x, y },
      timeoutMs: mouseTimeoutMs,
    });
    await executeCdp({
      tabId,
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x, y, button, clickCount },
      timeoutMs: mouseTimeoutMs,
    });
    await executeCdp({
      tabId,
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseReleased", x, y, button, clickCount },
      timeoutMs: mouseTimeoutMs,
    });
    return { ok: true };
  });

  bridge.registerRequestHandler("scrollBy", async ({ tabId, deltaX = 0, deltaY = 0, x = 0, y = 0 } = {}) => {
    requireInt(tabId, "tabId");
    await executeCdp({
      tabId,
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseWheel", x, y, deltaX, deltaY, button: "none" },
      timeoutMs: 5000,
    });
    return { ok: true };
  });

  // 虚拟光标:驱动 content script 把光标动画移到 (x,y),到达后返回。
  // 完整复刻 BCB:走 CursorOverlayController.setCursorState(spring 物理 + bezier),
  // 可选 waitForArrival 等待 content script 上报到达。
  bridge.registerRequestHandler("moveMouse", async ({
    tabId, x, y,
    session_id = "default", turn_id, move_sequence = 0,
    wait_for_arrival = true,
  } = {}) => {
    requireInt(tabId, "tabId");
    requireNum(x, "x"); requireNum(y, "y");
    const sessionId = typeof session_id === "string" && session_id ? session_id : "default";
    const turnId = typeof turn_id === "string" && turn_id ? turn_id : `${sessionId}:${move_sequence}`;
    const moveSequence = Number.isInteger(move_sequence) ? move_sequence : 0;

    if (!_cursorOverlays) {
      // 控制器未注入(理论上不会发生),降级:直接发消息。
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: "AGENT_CURSOR_STATE",
          state: { cursor: { x, y, visible: true, moveSequence }, isVisible: false, sessionId, turnId },
        });
      } catch {}
      return { ok: true, arrived: false };
    }

    // 确保 session 处于 running 态并跟踪该 tab(发布光标状态前)。
    await _cursorOverlays.startSession(sessionId, turnId, { publishTabs: false });
    await _cursorOverlays.trackTab(sessionId, tabId, { publish: false });

    const tabVisible = _cursorOverlays.isObserved(tabId);
    const canWaitForArrival = wait_for_arrival !== false && tabVisible;

    const waiter = canWaitForArrival
      ? createCursorArrivalWaiter({ sessionId, turnId, moveSequence })
      : null;

    const published = await _cursorOverlays.setCursorState(
      sessionId,
      tabId,
      turnId,
      {
        // tab 不可见时不动画(snap),与 BCB 一致。
        ...(tabVisible ? {} : { animateMovement: false }),
        moveSequence,
        visible: true,
        x,
        y,
      },
      { publish: tabVisible },
    );

    if (!waiter) return { ok: true, arrived: false };
    if (!published) {
      waiter.cancel();
      return { ok: true, arrived: false };
    }
    await waiter.promise;
    return { ok: true, arrived: true };
  });

  // content script 上报光标到达(notification:后端→扩展)。本地等待器也由
  // background.js 的 AGENT_CURSOR_ARRIVED 直接 resolve,此处保持通知通道对称。
  bridge.registerNotificationHandler("cursorArrived", async ({ sessionId, turnId, moveSequence } = {}) => {
    notifyCursorArrived({ sessionId, turnId, moveSequence });
  });

  bridge.registerRequestHandler("detachTab", async ({ tabId } = {}) => {
    requireInt(tabId, "tabId");
    await detachTab(tabId);
    return { ok: true };
  });
}

// --- helpers ---

function requireInt(v, name) {
  if (!Number.isInteger(v)) throw new Error(`Expected integer for ${name}, got: ${v}`);
}
function requireStr(v, name) {
  if (typeof v !== "string" || !v) throw new Error(`Expected non-empty string for ${name}`);
}
function requireNum(v, name) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`Expected number for ${name}, got: ${v}`);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Inject Defuddle full bundle + extractor into the tab (isolated world).
 * Same pattern as ToMarkdown: files run in order; last file's result is returned.
 */
async function extractWithDefuddle(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    files: ["lib/defuddle.full.js", "content/defuddle-extract.js"],
  });
  const payload = results && results[0] && results[0].result;
  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      text: "",
      strategy: "defuddle-empty",
      useful: 0,
      title: "",
      error: "No extraction result returned (page may block scripting)",
    };
  }
  return payload;
}

// 等待 tab 加载到 complete 状态。
// 只在 info.status === "complete" 时 resolve,不在 URL 变化时提前返回。
// 旧版在 info.url 变化时就 resolve,导致 navigate() 在页面 DOM 还没就绪时返回,
// 后续 evaluate() 执行 document.body.cloneNode() 报 null 错误。
function waitForTabComplete(tabId, expectedUrl, timeoutMs) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // 超时也视为完成(让调用方继续)。
    const timer = setTimeout(finish, timeoutMs);
    // 若已经是 complete,立即返回。
    chrome.tabs.get(tabId).then((t) => {
      if (t && t.status === "complete") finish();
    }).catch(finish);
  });
}

// 光标到达等待器工厂。
function createCursorArrivalWaiter({ sessionId, turnId, moveSequence }) {
  const key = `${sessionId}:${turnId}:${moveSequence}`;
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  const timer = setTimeout(() => {
    _cursorArrivalWaiters.delete(key);
    reject(new Error(`Cursor arrival timeout for ${key}`));
  }, CURSOR_ARRIVAL_TIMEOUT_MS);
  const cancel = () => {
    clearTimeout(timer);
    _cursorArrivalWaiters.delete(key);
  };
  const waiter = { promise, resolve, cancel };
  _cursorArrivalWaiters.set(key, waiter);
  return waiter;
}
