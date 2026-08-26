/**
 * FIX 4 / FIX 5 regression tests — extension/lib/cursor-overlay-controller.js
 * and extension/lib/handlers.js.
 *
 * FIX 4 [P3]: incrementActiveRequests 曾对每个入站 RPC 都 ensureSession
 * (json-rpc 生命周期钩子对 ping/navigate/evaluate… 全部触发),制造出永久残留的
 * 幽灵 session(空 tabIds、无人清理)。修复选 (a):恢复无 session 时直接返回,
 * 与 decrement 侧「容忍缺失」对称;真实 cursor 流程由 moveMouse 处理器内的
 * startSession 负责建 session。
 *
 * FIX 5 [P3]:到达等待器超时分支曾无条件 _cursorArrivalWaiters.delete(key),
 * key 复用时会删掉新等待器的条目。修复:get(key) === waiter 才删。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

const bust = () => `?t=${Date.now()}-${Math.random().toString(36).slice(2)}`;
const controllerUrl = () =>
  pathToFileURL(path.join(root, 'extension/lib/cursor-overlay-controller.js')).href + bust();
const handlersUrl = () =>
  pathToFileURL(path.join(root, 'extension/lib/handlers.js')).href + bust();

function installMinimalChrome() {
  const reg = () => ({ addListener() {} });
  globalThis.chrome = {
    tabs: {
      query: async () => [],
      onActivated: reg(),
      onCreated: reg(),
      onRemoved: reg(),
      onReplaced: reg(),
    },
    windows: { onFocusChanged: reg() },
  };
}

async function loadController() {
  installMinimalChrome(); // constructor queries chrome.tabs synchronously via refreshActiveTabs
  const { CursorOverlayController } = await import(controllerUrl());
  return new CursorOverlayController();
}

const drainMicrotasks = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};

// --- FIX 4 ---

test('non-cursor RPC lifecycle pair leaves no phantom session behind', async () => {
  const controller = await loadController();

  // json-rpc fires the lifecycle hooks for EVERY inbound RPC; params without
  // session_id map to "default". ping/navigate/evaluate all take this path.
  await controller.incrementActiveRequests('default');
  await controller.decrementActiveRequests('default');

  assert.equal(
    controller.sessions.has('default'),
    false,
    'a non-cursor RPC must not materialize a permanent untracked session record',
  );
});

test('real cursor flow still balances counters and keeps its session', async () => {
  const controller = await loadController();

  await controller.startSession('sess-1', 'turn-1', { publishTabs: false });
  await controller.trackTab('sess-1', 7, { publish: false });
  await controller.incrementActiveRequests('sess-1');
  assert.equal(controller.sessions.get('sess-1').activeRequests, 1);
  await controller.decrementActiveRequests('sess-1');

  const session = controller.sessions.get('sess-1');
  assert.equal(session.activeRequests, 0, 'counter must return to zero');
  assert.equal(session.isRunning, true, 'session stays running through the request');
  assert.ok(session.tabIds.has(7), 'tracked tab is preserved');
  await controller.stopSession('sess-1'); // clears the idle-hide timer
});

test('lifecycle hooks firing before moveMouse startSession leave no residue', async () => {
  // Production ordering: onRequestStarted fires before the moveMouse handler's
  // startSession creates the session; onRequestCompleted fires after it exists.
  const controller = await loadController();

  await controller.incrementActiveRequests('sess-9'); // pre-session hook call
  await controller.startSession('sess-9', 'turn-1', { publishTabs: false });
  await controller.trackTab('sess-9', 3, { publish: false });
  await controller.decrementActiveRequests('sess-9'); // post-session hook call

  const session = controller.sessions.get('sess-9');
  assert.equal(session.activeRequests, 0);
  assert.equal(session.isRunning, true);
  await controller.stopSession('sess-9');
});

// --- FIX 5 ---
// Runs last: it swaps in a fake cursor controller for the handlers module.

test('arrival-waiter timeout keeps a newer waiter registered under the same key', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  installMinimalChrome();
  const mod = await import(handlersUrl());
  mod.setCursorOverlayController({
    startSession: async () => {},
    trackTab: async () => {},
    setCursorState: async () => true,
    isObserved: () => true,
  });
  const registered = new Map();
  mod.registerHandlers({ registerRequestHandler: (m, f) => registered.set(m, f) });
  const moveMouse = registered.get('moveMouse');
  const params = { tabId: 11, x: 1, y: 2, session_id: 's', turn_id: 'tn', move_sequence: 1 };

  t.mock.timers.tick(0); // establish the mocked clock
  const first = moveMouse({ ...params }).catch((e) => e); // waiter A, deadline ≈ t+1500
  await drainMicrotasks();
  t.mock.timers.tick(1000); // clock ≈ 1000; A still pending
  const second = moveMouse({ ...params }); // waiter B reuses A's key, deadline ≈ 2500
  await drainMicrotasks();

  t.mock.timers.tick(500); // clock ≈ 1500 → A's timeout fires
  const firstOutcome = await first;
  assert.match(
    String(firstOutcome?.message ?? firstOutcome),
    /Cursor arrival timeout/,
    'the superseded waiter still rejects on its own deadline',
  );

  // Arrival notification must resolve B — unless A's timeout wrongly deleted B's entry.
  let outcome = 'NOT-SETTLED';
  second.then(
    (v) => {
      outcome = v;
    },
    (e) => {
      outcome = e;
    },
  );
  mod.notifyCursorArrived({ sessionId: 's', turnId: 'tn', moveSequence: 1 });
  for (let i = 0; i < 30 && outcome === 'NOT-SETTLED'; i++) {
    t.mock.timers.tick(100);
    await drainMicrotasks();
  }
  assert.deepEqual(outcome, { ok: true, arrived: true });
});
