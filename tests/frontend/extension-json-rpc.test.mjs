/**
 * FIX 6 [P3 dead code] — extension/lib/json-rpc.js
 *
 * 复核确认:sendRequest / _pending / _nextId / 超时扫描 / _rejectAll 在整个仓库
 * 零调用方(grep 证据见提交说明);扩展 → 后端只发通知(ws-transport 的
 * hello/心跳均为无 id 通知)。整套 pending-call 机制删除,构造器保持精简。
 * 本文件同时守住入站请求/通知/生命周期钩子的既有行为不回退。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

function jsonRpcUrl() {
  return (
    pathToFileURL(path.join(root, 'extension/lib/json-rpc.js')).href +
    `?t=${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function makeTransport({ withDisconnect = true } = {}) {
  const sent = [];
  let messageCb = null;
  const transport = {
    sent,
    onMessage(cb) {
      messageCb = cb;
    },
    sendMessage(msg) {
      sent.push(msg);
    },
    deliver(msg) {
      return messageCb?.(msg);
    },
  };
  if (withDisconnect) transport.onDisconnect = () => {};
  return transport;
}

async function loadClass() {
  const { JsonRpcBridge } = await import(jsonRpcUrl());
  return JsonRpcBridge;
}

const drain = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};

// --- FIX 6 structural guards ---

test('pending-call machinery (sendRequest/_pending/_nextId) is deleted', async () => {
  const JsonRpcBridge = await loadClass();
  const bridge = new JsonRpcBridge(makeTransport());

  assert.equal(typeof bridge.sendRequest, 'undefined', 'sendRequest must be gone');
  assert.equal(bridge._pending, undefined, '_pending map must be gone');
  assert.equal(bridge._nextId, undefined, '_nextId counter must be gone');
});

test('constructor no longer requires transport.onDisconnect', async () => {
  const JsonRpcBridge = await loadClass();

  assert.doesNotThrow(() => {
    new JsonRpcBridge(makeTransport({ withDisconnect: false }));
  }, 'a notification-only transport without onDisconnect must be enough');
});

// --- inbound behavior guards (must not regress with the deletion) ---

test('inbound request with unknown method answers a JSON-RPC error response', async () => {
  const JsonRpcBridge = await loadClass();
  const transport = makeTransport();
  new JsonRpcBridge(transport);

  transport.deliver({ jsonrpc: '2.0', id: 5, method: 'nope', params: {} });
  await drain();

  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].id, 5);
  assert.equal(transport.sent[0].error.code, -32603);
});

test('inbound request runs its handler and sends the result keyed by id', async () => {
  const JsonRpcBridge = await loadClass();
  const transport = makeTransport();
  const bridge = new JsonRpcBridge(transport);
  bridge.registerRequestHandler('ping', async () => ({ ok: true }));

  transport.deliver({ jsonrpc: '2.0', id: 9, method: 'ping', params: { session_id: 'web' } });
  await drain();

  assert.deepEqual(transport.sent, [{ jsonrpc: '2.0', id: 9, result: { ok: true } }]);
});

test('notifications run handlers without sending anything back', async () => {
  const JsonRpcBridge = await loadClass();
  const transport = makeTransport();
  const bridge = new JsonRpcBridge(transport);
  let seen = 0;
  bridge.registerRequestHandler('notify-me', async () => {
    seen += 1;
    return 123;
  });

  transport.deliver({ jsonrpc: '2.0', method: 'notify-me' });
  await drain();

  assert.equal(seen, 1);
  assert.equal(transport.sent.length, 0);
});

test('response-shaped messages for unknown ids are ignored silently', async () => {
  const JsonRpcBridge = await loadClass();
  const transport = makeTransport();
  new JsonRpcBridge(transport);

  transport.deliver({ jsonrpc: '2.0', id: 77, result: { stray: true } });
  await drain();

  assert.equal(transport.sent.length, 0);
});

test('lifecycle hooks fire exactly once per inbound call with extracted session_id', async () => {
  const JsonRpcBridge = await loadClass();
  const transport = makeTransport();
  const bridge = new JsonRpcBridge(transport);
  bridge.registerRequestHandler('m', async () => null);
  const started = [];
  const completed = [];
  bridge.setRequestLifecycleHandlers({
    onRequestStarted: (sid) => started.push(sid),
    onRequestCompleted: (sid) => completed.push(sid),
  });

  transport.deliver({ jsonrpc: '2.0', method: 'm', params: { session_id: 'abc' } }); // notification
  transport.deliver({ jsonrpc: '2.0', id: 1, method: 'm' }); // request, no session_id
  await drain();

  assert.deepEqual(started, ['abc', 'default']);
  assert.deepEqual(completed, ['abc', 'default']);
});
