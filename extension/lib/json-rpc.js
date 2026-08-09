// JSON-RPC 2.0 编解码。
// 请求:{ jsonrpc:"2.0", id, method, params }
// 响应:{ jsonrpc:"2.0", id, result | error }
// 通知:{ jsonrpc:"2.0", method, params }  (无 id)

export class JsonRpcBridge {
  constructor(transport) {
    this.transport = transport;
    this._nextId = 1;
    this._pending = new Map();        // id -> { resolve, reject, timeoutId }
    this._requestHandlers = new Map();   // method -> async fn(params) -> result
    this._onRequestStarted = null;
    this._onRequestCompleted = null;

    transport.onMessage((msg) => this._onMessage(msg));
    transport.onDisconnect(() => this._rejectAll("bridge disconnected"));
  }

  // 后端 → 扩展:注册本地能处理的请求方法。
  registerRequestHandler(method, fn) {
    this._requestHandlers.set(method, fn);
  }

  // 请求生命周期钩子:每个进入的 RPC 请求开始/结束时触发,用于追踪 session 活跃度
  // (驱动光标 idle-hide)。sessionId 从 params.session_id 读取,缺省 "default"。
  setRequestLifecycleHandlers({ onRequestStarted, onRequestCompleted } = {}) {
    this._onRequestStarted = onRequestStarted ?? null;
    this._onRequestCompleted = onRequestCompleted ?? null;
  }

  // 扩展 → 后端:发送请求,等响应。
  async sendRequest(method, params = {}, timeoutMs = 30000) {
    const id = this._nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`JSON-RPC request "${method}" timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timeoutId });
      try {
        this.transport.sendMessage(message);
      } catch (err) {
        clearTimeout(timeoutId);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  async _onMessage(msg) {
    if (!msg || typeof msg !== "object") return;

    // 响应:匹配 pending 请求。
    if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timeoutId);
      this._pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
      return;
    }

    // 请求:调用本地 handler,回响应。
    if (typeof msg.method === "string") {
      const sessionId = extractSessionId(msg.params);
      if (this._onRequestStarted) this._onRequestStarted(sessionId);
      const completion = this._onRequestCompleted;
      try {
        const handler = this._requestHandlers.get(msg.method);
        if (!handler) throw new Error(`No handler for method "${msg.method}"`);
        const result = await handler(msg.params ?? {});
        if (typeof msg.id === "number") {
          this.transport.sendMessage({ jsonrpc: "2.0", id: msg.id, result: result ?? null });
        }
      } catch (err) {
        if (typeof msg.id === "number") {
          this.transport.sendMessage({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          });
        }
      } finally {
        if (completion) completion(sessionId);
      }
      return;
    }
  }

  _rejectAll(reason) {
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(reason));
    }
    this._pending.clear();
  }
}

function extractSessionId(params) {
  const id = params?.session_id;
  return typeof id === "string" && id ? id : "default";
}
