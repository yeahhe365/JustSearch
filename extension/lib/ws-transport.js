// WebSocket 出站连接到 JustSearch 后端,带自动重连。
// 仿 browser-control-bridge 的 src/background/webSocketTransport.ts,简化。

const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:8000/justsearch";
export const BRIDGE_URL_KEY = "JUSTSEARCH_BRIDGE_URL";
const RECONNECT_DELAY_MS = 2000;
// chrome.alarms 最小 0.5 分钟,这里用 1 分钟做兜底重连。
const RECONNECT_ALARM_NAME = "justsearch-ws-reconnect";
const RECONNECT_ALARM_MINUTES = 1;
const HEARTBEAT_ALARM_NAME = "justsearch-heartbeat";
const HEARTBEAT_PERIOD_MINUTES = 0.5; // 30s

export class WebSocketTransport {
  constructor() {
    this.socket = null;
    this._messageCallback = null;
    this._disconnectCallback = null;
    this._statusCallback = null;
    this._resolvedUrl = DEFAULT_BRIDGE_URL;
    this._reconnectTimeoutId = null;
    this._reconnectPending = false;
    this._reconnectAttempt = 0;
    this._status = { state: "disconnected", url: this._resolvedUrl, reconnectAttempt: 0, error: null };

    chrome.alarms.onAlarm.addListener(this._handleAlarm);
    chrome.storage.onChanged.addListener(this._handleStorageChanged);

    // 立即用默认 URL 连一次;若 storage 里有覆盖,applyConfiguredUrl 会换上并重连。
    this._connect() || this._scheduleReconnect();
    this._applyConfiguredUrl().then((changed) => { if (changed) this._reconnectForNewUrl(); });
  }

  onMessage(cb) { this._messageCallback = cb; }
  onDisconnect(cb) { this._disconnectCallback = cb; }
  onStatusChange(cb) { this._statusCallback = cb; }

  sendMessage(message) {
    if (!this._isConnected()) {
      this._scheduleReconnect();
      throw new Error("JustSearch bridge is disconnected; reconnect is pending");
    }
    this.socket.send(JSON.stringify(message));
  }

  getStatus() { return { ...this._status }; }

  // -------------------------------------------------------------------------

  _connect(failureState = "disconnected") {
    if (this.socket) return true;
    let socket;
    try {
      socket = new WebSocket(this._resolvedUrl);
    } catch (err) {
      this._updateStatus(failureState, { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this._reconnectPending = false;
      this._reconnectAttempt = 0;
      this._clearReconnectTimeout();
      this._clearReconnectAlarm();
      this._updateStatus("connected");
      // 连上后立刻上报扩展版本/实例 ID,供后端 / 设置页展示。
      this._sendHello().catch(() => {});
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this._reconnectAttempt = 0;
      this._updateStatus("connected");
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg && typeof msg === "object") this._messageCallback?.(msg);
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      this._updateStatus(failureState, { error: "WebSocket error" });
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this._updateStatus("disconnected", { error: "WebSocket closed" });
      this._disconnectCallback?.();
      this._scheduleReconnect();
    };
    return true;
  }

  _scheduleReconnect() {
    if (this._isConnected()) return;
    if (!this._reconnectPending) {
      this._reconnectPending = true;
      this._reconnectAttempt += 1;
    }
    if (this._reconnectTimeoutId == null) {
      this._reconnectTimeoutId = setTimeout(() => {
        this._reconnectTimeoutId = null;
        this._runReconnectAttempt();
      }, RECONNECT_DELAY_MS);
    }
    this._ensureReconnectAlarm().catch(() => {});
    this._updateStatus("reconnecting", { error: this._status.error });
  }

  _runReconnectAttempt() {
    if (this._isConnected()) return;
    this._clearReconnectTimeout();
    this._reconnectPending = true;
    this._reconnectAttempt += 1;
    this._connect("reconnecting") || this._scheduleReconnect();
  }

  async _ensureReconnectAlarm() {
    if (this._isConnected()) return;
    const existing = await chrome.alarms.get(RECONNECT_ALARM_NAME);
    if (!this._isConnected() && !existing) {
      await chrome.alarms.create(RECONNECT_ALARM_NAME, { periodInMinutes: RECONNECT_ALARM_MINUTES });
    }
  }

  _clearReconnectTimeout() {
    if (this._reconnectTimeoutId == null) return;
    clearTimeout(this._reconnectTimeoutId);
    this._reconnectTimeoutId = null;
  }

  _clearReconnectAlarm() {
    chrome.alarms.clear(RECONNECT_ALARM_NAME).catch(() => {});
  }

  _handleAlarm = (alarm) => {
    if (alarm.name === RECONNECT_ALARM_NAME) {
      if (this._isConnected()) { this._clearReconnectAlarm(); return; }
      this._runReconnectAttempt();
    } else if (alarm.name === HEARTBEAT_ALARM_NAME) {
      this._heartbeat();
    }
  };

  async _collectIdentity() {
    const manifest = chrome.runtime.getManifest?.() || {};
    let instanceId = null;
    try {
      const stored = await chrome.storage.local.get("extensionInstanceId");
      instanceId = stored.extensionInstanceId || null;
    } catch {
      // storage 可能暂不可用
    }
    return {
      name: typeof manifest.name === "string" ? manifest.name : "JustSearch Bridge",
      version: typeof manifest.version === "string" ? manifest.version : "0.0.0",
      instance_id: instanceId,
      ts: Date.now(),
    };
  }

  async _sendHello() {
    if (!this._isConnected()) return;
    const identity = await this._collectIdentity();
    this.sendMessage({ jsonrpc: "2.0", method: "hello", params: identity });
  }

  async _heartbeat() {
    // WS 活跃时 service worker 不会被回收,但仍定期 ping 让后端知道扩展还在。
    if (!this._isConnected()) return;
    try {
      const identity = await this._collectIdentity();
      // 直接发一个 ping 通知,不等响应;顺带刷新版本元数据。
      this.sendMessage({ jsonrpc: "2.0", method: "ping", params: identity });
    } catch {
      // 忽略:下一轮重连会处理。
    }
  }

  _handleStorageChanged = (changes, areaName) => {
    if (areaName !== "local" || !changes[BRIDGE_URL_KEY]) return;
    this._applyConfiguredUrl().then((changed) => { if (changed) this._reconnectForNewUrl(); });
  };

  async _applyConfiguredUrl() {
    const next = await getConfiguredBridgeUrl();
    if (next === this._resolvedUrl) return false;
    this._resolvedUrl = next;
    return true;
  }

  _reconnectForNewUrl() {
    this._clearReconnectTimeout();
    if (this.socket) {
      try { this.socket.onclose = null; this.socket.close(); } catch {}
      this.socket = null;
      this._disconnectCallback?.();
    }
    this._reconnectPending = false;
    this._reconnectAttempt = 0;
    this._connect() || this._scheduleReconnect();
    this._updateStatus(this._isConnected() ? "connected" : "reconnecting");
  }

  _updateStatus(state, extra = {}) {
    this._status = {
      state,
      url: this._resolvedUrl,
      reconnectAttempt: this._reconnectAttempt,
      ...(extra.error ? { error: extra.error } : {}),
    };
    this._statusCallback?.(this.getStatus());
  }

  _isConnected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }
}

export async function getConfiguredBridgeUrl() {
  const stored = await chrome.storage.local.get(BRIDGE_URL_KEY);
  const value = stored[BRIDGE_URL_KEY];
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_BRIDGE_URL;
}

export function startHeartbeat() {
  chrome.alarms.create(HEARTBEAT_ALARM_NAME, { periodInMinutes: HEARTBEAT_PERIOD_MINUTES });
}
