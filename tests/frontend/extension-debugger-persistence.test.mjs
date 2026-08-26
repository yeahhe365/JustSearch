/**
 * FIX 1 [P1] regression tests — extension/lib/debugger-api.js
 *
 * attachedTabs 的持久化镜像必须在模块初始化时一次性水合(hydrate)。此前
 * loadPersistedAttachedTabs 只在 detachAll 里执行,而每个 attach 路径都会用纯内存
 * 集合覆写 storage:SW 重启后(内存为空、标签实际仍附着),下一次 attach 会把
 * 持久化记录覆写成 [newTab],抹掉旧 id → 之后 detachAll 清不掉残留附着,
 * DevTools 被占用直到关闭标签。
 *
 * Fake-chrome harness:不需要 jsdom,直接用普通 stub 对象。被测模块通过裸全局
 * `chrome` 访问 API,因此必须在动态 import 之前装好 globalThis.chrome。
 * 用 cache-bust query 模拟「service worker 重启」(全新模块实例、保留 storage)。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

let bustCounter = 0;
function debuggerApiUrl() {
  return (
    pathToFileURL(path.join(root, 'extension/lib/debugger-api.js')).href +
    `?t=${Date.now()}-${++bustCounter}`
  );
}

const STORAGE_KEY = 'jsAttachedTabIds';

/**
 * Install a fake chrome exposing chrome.debugger + chrome.storage.local.
 * `stored` seeds the backing store — i.e. the state a previous service-worker
 * life left behind.
 */
function installFakeChrome({ stored = {} } = {}) {
  const storageData = { ...stored };
  const calls = { attach: [], detach: [], sendCommand: [] };
  globalThis.chrome = {
    runtime: {},
    storage: {
      local: {
        get: async (key) => ({ [key]: storageData[key] }),
        set: async (obj) => {
          Object.assign(storageData, structuredClone(obj));
        },
        remove: async (...keys) => {
          for (const k of keys.flat()) delete storageData[k];
        },
      },
    },
    debugger: {
      attach: async (target) => {
        calls.attach.push(target.tabId);
      },
      detach: async (target) => {
        calls.detach.push(target.tabId);
      },
      sendCommand: async (target, method) => {
        calls.sendCommand.push({ tabId: target.tabId, method });
        return {};
      },
      onDetach: { addListener() {} },
    },
  };
  return { storageData, calls };
}

test('attach after SW restart preserves previously persisted attached tab ids', async () => {
  // Restart simulation: storage still lists ids attached by the previous SW life,
  // while a brand-new module instance (= fresh service worker) starts empty.
  const { storageData } = installFakeChrome({ stored: { [STORAGE_KEY]: [101, 102] } });
  const mod = await import(debuggerApiUrl());

  await mod.executeCdp({ tabId: 999, method: 'Runtime.evaluate', params: {} });

  const persisted = [...storageData[STORAGE_KEY]].sort((a, b) => a - b);
  assert.deepEqual(
    persisted,
    [101, 102, 999],
    'persistence after attach must merge with hydrated ids, not overwrite them',
  );
});

test('attach persists correctly when the previous life attached nothing', async () => {
  const { storageData } = installFakeChrome();
  const mod = await import(debuggerApiUrl());

  await mod.executeCdp({ tabId: 5, method: 'Runtime.evaluate', params: {} });

  assert.deepEqual(storageData[STORAGE_KEY], [5]);
});

test('detachAll after restart detaches every persisted id and clears storage', async () => {
  const { storageData, calls } = installFakeChrome({ stored: { [STORAGE_KEY]: [201, 202] } });
  const mod = await import(debuggerApiUrl());

  await mod.detachAll();

  assert.deepEqual([...calls.detach].sort((a, b) => a - b), [201, 202]);
  assert.ok(!(STORAGE_KEY in storageData), 'storage key must be removed after detachAll');
});

test('hydration failure must not wedge persistence', async () => {
  // Belt-and-braces: even if reading storage rejects, persist must stay usable.
  const { storageData } = installFakeChrome();
  globalThis.chrome.storage.local.get = async () => {
    throw new Error('storage unavailable');
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...parts) => warnings.push(parts.map(String).join(' '));
  let mod;
  try {
    mod = await import(debuggerApiUrl());
    await mod.executeCdp({ tabId: 7, method: 'Runtime.evaluate', params: {} });
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(storageData[STORAGE_KEY], [7]);
  assert.ok(
    warnings.some((w) => w.includes('读取 attachedTabs 失败')),
    'hydration failure is reported via console.warn',
  );
});
