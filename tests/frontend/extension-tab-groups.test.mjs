/**
 * FIX 3 [P2] — extension/lib/tab-groups.js + extension/background.js
 *
 * MV3 规定事件监听必须在 service worker 首次求值的同步栈里注册;此前
 * tabGroups 的三个监听只在 ensureInit 的 await 链(loadFromStorage 之后)里注册,
 * 唤醒挂起 SW 的事件会在异步 init 完成前被丢弃。修复:registerEventListeners
 * 从 ensureInit 拆出,由 background.js 顶层同步调用,状态加载保持异步。
 *
 * 关键测试:让 chrome.storage.local.get 返回永不 settle 的 promise(模拟异步
 * init 卡住),然后 import background.js —— 模块求值是同步的,监听必须在求值
 * 结束时就已注册。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

function moduleUrl(rel) {
  return pathToFileURL(path.join(root, rel)).href + `?t=${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Fake chrome covering everything background.js touches at import time.
 * `hangStorageLoad`: storage.local.get never settles → any async init chain
 * that still gates listener registration can never complete.
 */
function makeChrome({ hangStorageLoad = false } = {}) {
  const listeners = {
    tgOnCreated: [],
    tgOnUpdated: [],
    tgOnRemoved: [],
    debuggerDetach: [],
  };
  const noopReg = () => ({ addListener() {} });
  globalThis.chrome = {
    tabGroups: {
      onCreated: { addListener: (fn) => listeners.tgOnCreated.push(fn) },
      onUpdated: { addListener: (fn) => listeners.tgOnUpdated.push(fn) },
      onRemoved: { addListener: (fn) => listeners.tgOnRemoved.push(fn) },
      get: async () => undefined,
      update: async () => ({}),
    },
    debugger: { onDetach: { addListener: (fn) => listeners.debuggerDetach.push(fn) } },
    alarms: {
      create: async () => {},
      get: async () => undefined,
      clear: async () => {},
      onAlarm: noopReg(),
    },
    storage: {
      local: {
        get: hangStorageLoad ? () => new Promise(() => {}) : async (key) => ({ [key]: undefined }),
        set: async () => {},
        remove: async () => {},
      },
      onChanged: noopReg(),
    },
    runtime: {
      onInstalled: noopReg(),
      onMessage: noopReg(),
      onSuspend: noopReg(),
    },
    tabs: {
      query: async () => [],
      get: async (tabId) => ({ id: tabId }),
      group: async () => 1,
      ungroup: async () => {},
      onActivated: noopReg(),
      onCreated: noopReg(),
      onRemoved: noopReg(),
      onReplaced: noopReg(),
    },
    windows: { onFocusChanged: noopReg() },
  };
  return listeners;
}

test('registerEventListeners wires tabGroups listeners synchronously and is re-entrant safe', async () => {
  const listeners = makeChrome({ hangStorageLoad: true });
  const { TabGroupStore } = await import(moduleUrl('extension/lib/tab-groups.js'));

  TabGroupStore.getInstance().registerEventListeners();

  assert.equal(listeners.tgOnCreated.length, 1);
  assert.equal(listeners.tgOnUpdated.length, 1);
  assert.equal(listeners.tgOnRemoved.length, 1);

  // A second registration call must not double-register.
  TabGroupStore.getInstance().registerEventListeners();
  assert.equal(listeners.tgOnCreated.length, 1, 'no duplicate listener after re-registration');
});

test('background.js registers tabGroups listeners during synchronous SW evaluation', async () => {
  const listeners = makeChrome({ hangStorageLoad: true });
  // WebSocketTransport constructor connects immediately; stub the global so no
  // real socket is opened and the transport stays "disconnected" harmlessly.
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor() {
      this.readyState = 0;
    }
    close() {}
    send() {}
  };

  await import(moduleUrl('extension/background.js')); // module evaluation is synchronous

  assert.ok(
    listeners.tgOnRemoved.length > 0,
    'tabGroups.onRemoved must be registered at SW evaluation time, not after the async init chain',
  );
  assert.ok(listeners.tgOnCreated.length > 0);
  assert.ok(listeners.tgOnUpdated.length > 0);
});
