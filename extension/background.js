// Service worker 入口:组装 transport + bridge + handlers + 光标控制器 + 标签分组,启心跳。
// 仿 browser-control-bridge 的 entrypoints/background.ts,复刻光标 + tab group 效果。

import { WebSocketTransport, startHeartbeat } from "./lib/ws-transport.js";
import { JsonRpcBridge } from "./lib/json-rpc.js";
import { registerHandlers, setCursorOverlayController, notifyCursorArrived } from "./lib/handlers.js";
import { registerDetachListener, detachAll } from "./lib/debugger-api.js";
import { publishStatus } from "./popup/status-store.js";
import { CursorOverlayController } from "./lib/cursor-overlay-controller.js";
import { TabGroupStore } from "./lib/tab-groups.js";

const HEARTBEAT_TIMEOUT_ALARM = "justsearch-heartbeat-watchdog";

registerDetachListener();

// MV3 同步注册规则:tabGroups 事件监听必须在 SW 首次求值的同步栈里注册,
// 否则唤醒挂起 SW 的事件会在异步 init 完成前被丢弃。状态加载仍在
// TabGroupStore#ensureInit 里异步进行。
TabGroupStore.getInstance().registerEventListeners();

const transport = new WebSocketTransport();
const bridge = new JsonRpcBridge(transport);

// 光标叠加层控制器:管理多 session 光标状态 + 活跃标签页观察 + idle-hide。
const cursorOverlays = new CursorOverlayController();
setCursorOverlayController(cursorOverlays);

registerHandlers(bridge);

// 请求生命周期钩子:每个 RPC 请求开始/结束追踪 session 活跃度,驱动光标 idle-hide。
bridge.setRequestLifecycleHandlers({
  onRequestStarted: (sessionId) => {
    void cursorOverlays.incrementActiveRequests(sessionId);
  },
  onRequestCompleted: (sessionId) => {
    void cursorOverlays.decrementActiveRequests(sessionId);
  },
});

// 状态变化时同步到 storage(popup 读)。
transport.onStatusChange((status) => {
  publishStatus(status).catch(() => {});
});

// 扩展实例 ID。
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("extensionInstanceId").then((stored) => {
    if (!stored.extensionInstanceId) {
      chrome.storage.local.set({ extensionInstanceId: crypto.randomUUID() });
    }
  });
});

// 启心跳:每 30s 发 ping;若 ping 长时间发不出(WS 断),detach 所有 debugger + 停所有 session。
startHeartbeat();
chrome.alarms.create(HEARTBEAT_TIMEOUT_ALARM, { periodInMinutes: 2 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_TIMEOUT_ALARM) return;
  return (async () => {
    // 注意用严格比较:"disconnected".includes("connected") === true,
    // 用 includes 会让断连状态跳过清理。
    if (transport.getStatus().state !== "connected") {
      // WS 不通:停所有光标 session(隐藏光标)+ 清掉残留 debugger attach。
      await cursorOverlays.stopActiveSessions().catch(() => {});
      await detachAll().catch(() => {});
    }
  })();
});

// content script → background 消息:光标到达查询 + 到达上报。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // content script 启动时查询当前光标状态(GET_AGENT_CURSOR_STATE)。
  if (msg?.type === "GET_AGENT_CURSOR_STATE") {
    const tabId = sender.tab?.id;
    const state =
      typeof tabId === "number"
        ? cursorOverlays.readCursorOverlayState(tabId)
        : cursorOverlays.readCursorOverlayState(-1);
    sendResponse({ ok: true, state });
    return true;
  }

  // content script 上报光标动画到达终点 → 进程内 resolve 对应的 moveMouse 等待器。
  if (msg?.type === "AGENT_CURSOR_ARRIVED") {
    const tabId = sender.tab?.id;
    if (
      typeof tabId !== "number" ||
      typeof msg.sessionId !== "string" ||
      typeof msg.turnId !== "string" ||
      !Number.isInteger(msg.moveSequence)
    ) {
      sendResponse({ ok: false });
      return true;
    }
    notifyCursorArrived({
      sessionId: msg.sessionId,
      turnId: msg.turnId,
      moveSequence: msg.moveSequence,
    });
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

// 扩展卸载/更新时清场。
chrome.runtime.onSuspend.addListener(() => {
  detachAll().catch(() => {});
});
