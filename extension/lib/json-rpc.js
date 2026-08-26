// JSON-RPC 2.0 编解码(入站方向)。
// 后端 → 扩展:带 id 的 request:{ jsonrpc:"2.0", id, method, params },本地
// handler 执行后回 { jsonrpc:"2.0", id, result | error }。
// 通知:{ jsonrpc:"2.0", method, params }(无 id),执行但不回包。
// 扩展 → 后端只发通知(hello / 心跳 ping 均无 id,见 ws-transport.js),
// 因此这里没有出站 pending-call 机制(原 sendRequest/_pending/_nextId 已删)。

export class JsonRpcBridge {
  constructor(transport) {
    this.transport = transport;
    this._requestHandlers = new Map();   // method -> async fn(params) -> result
    this._onRequestStarted = null;
    this._onRequestCompleted = null;

    transport.onMessage((msg) => this._onMessage(msg));
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

  async _onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (typeof msg.method !== "string") return; // 无方法的杂散消息(如孤儿响应):忽略

    // 请求/通知:调用本地 handler,带 id 时回响应。
    const sessionId = extractSessionId(msg.params);
    if (this._onRequestStarted) this._onRequestStarted(sessionId);
    const completion = this._onRequestCompleted;
    try {
      const handler = this._requestHandlers.get(msg.method);
      if (!handler) throw new Error(`No handler for method "${msg.method}"`);
      const result = await handler(msg.params ?? {});
      if (typeof msg.id === "number") {
        // WS 可能在 handler 成功后、发送前断开:发送失败只记日志并吞掉。
        // 若不捕获,catch 分支还会再发一次错误响应(同样会抛),未处理的
        // rejection 会从 _onMessage 逃逸。
        try {
          this.transport.sendMessage({ jsonrpc: "2.0", id: msg.id, result: result ?? null });
        } catch (sendErr) {
          console.warn("JSON-RPC: 响应发送失败(连接已断开):", sendErr?.message ?? sendErr);
        }
      }
    } catch (err) {
      if (typeof msg.id === "number") {
        try {
          this.transport.sendMessage({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          });
        } catch (sendErr) {
          // 断连时响应发不出去是正常的,吞掉即可。
          console.warn("JSON-RPC: 错误响应发送失败(连接已断开):", sendErr?.message ?? sendErr);
        }
      }
    } finally {
      if (completion) completion(sessionId);
    }
  }
}

function extractSessionId(params) {
  const id = params?.session_id;
  return typeof id === "string" && id ? id : "default";
}
