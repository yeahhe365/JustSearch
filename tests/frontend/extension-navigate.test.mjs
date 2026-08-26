/**
 * FIX 2 [P2] regression tests — extension/lib/handlers.js waitForTabComplete,
 * exercised end-to-end through the registered "navigate" RPC handler.
 *
 * 此前 waitForTabComplete 要求先观察到 status:"loading" 才接受 "complete":
 * hash-only 导航(#frag)和超快加载不会发出 loading 迁移 → 每次导航必然
 * 干等满 20s 超时。修复设计:用初始 chrome.tabs.get 抓 initialUrl 作为基线,
 * `complete 且携带不同 url` 视为已确认的 different-document 导航;sawLoading
 * 路径保留给同 URL 重载;超时语义不变(超时也放行)。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

function handlersUrl() {
  return (
    pathToFileURL(path.join(root, 'extension/lib/handlers.js')).href +
    `?t=${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

const TAB = 42;
const PAGE = 'https://example.com/page';

function installFakeChrome() {
  const updatedListeners = [];
  let tabSnapshot = { status: 'complete', url: PAGE }; // what chrome.tabs.get returns
  globalThis.chrome = {
    tabs: {
      update: async (tabId, props) => ({ id: tabId, ...tabSnapshot, ...props }),
      get: async (tabId) => ({ id: tabId, ...tabSnapshot }),
      onUpdated: {
        addListener: (fn) => updatedListeners.push(fn),
        removeListener: (fn) => {
          const i = updatedListeners.indexOf(fn);
          if (i >= 0) updatedListeners.splice(i, 1);
        },
      },
    },
  };
  return {
    setTabSnapshot: (patch) => {
      tabSnapshot = { ...tabSnapshot, ...patch };
    },
    emitFromTab: (info) => {
      for (const fn of [...updatedListeners]) fn(TAB, info);
    },
    listenerCount: () => updatedListeners.length,
  };
}

async function loadNavigateHandler() {
  // chrome must exist on globalThis BEFORE the module under test is imported.
  const env = installFakeChrome();
  const mod = await import(handlersUrl());
  const registered = new Map();
  mod.registerHandlers({ registerRequestHandler: (m, f) => registered.set(m, f) });
  return { env, navigate: registered.get('navigate') };
}

// Let the awaited chrome.tabs.update / tabs.get chains settle so the
// onUpdated listener is registered and initialUrl captured before we emit.
async function settle() {
  for (let i = 0; i < 25; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

test('(a) hash-only navigation without any loading transition resolves before the timeout', async () => {
  const { env, navigate } = await loadNavigateHandler();
  env.setTabSnapshot({ status: 'complete', url: PAGE }); // pre-navigation snapshot

  const startedAt = Date.now();
  const done = navigate({ tabId: TAB, url: `${PAGE}#frag`, timeoutMs: 1000 });
  await settle();

  assert.equal(env.listenerCount(), 1);
  env.emitFromTab({ url: `${PAGE}#frag` }); // url-only changeInfo: no status events ever

  await done;
  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed < 800,
    `hash-only navigation resolved only via timeout (${elapsed}ms elapsed, guard is <800ms of a 1000ms budget)`,
  );
});

test('(b) classic loading→complete timeline still resolves quickly', async () => {
  const { env, navigate } = await loadNavigateHandler();
  env.setTabSnapshot({ status: 'complete', url: PAGE });

  const startedAt = Date.now();
  const done = navigate({ tabId: TAB, url: 'https://example.com/other', timeoutMs: 1000 });
  await settle();

  env.emitFromTab({ status: 'loading' });
  env.emitFromTab({ status: 'complete' });

  await done;
  assert.ok(
    Date.now() - startedAt < 800,
    'observed loading→complete must resolve well before the timeout',
  );
});

test('(c) stale complete with SAME url before any loading must not confirm the wait', async () => {
  const { env, navigate } = await loadNavigateHandler();
  env.setTabSnapshot({ status: 'complete', url: PAGE });

  const done = navigate({ tabId: TAB, url: `${PAGE}#later`, timeoutMs: 240 });
  await settle();

  env.emitFromTab({ status: 'complete' }); // stale leftover from the old page, no url
  env.emitFromTab({ status: 'complete', url: PAGE }); // stale leftover carrying SAME url

  let settled = false;
  done.then(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 120)); // half of the injected short timeout
  assert.equal(settled, false, 'a stale complete must not end the wait early');
  await done; // finishes via the injected timeout (timeout-as-success semantics kept)
});

test('(d) listener is removed once the wait finishes', async () => {
  const { env, navigate } = await loadNavigateHandler();
  env.setTabSnapshot({ status: 'complete', url: PAGE });

  const done = navigate({ tabId: TAB, url: `${PAGE}#x`, timeoutMs: 1000 });
  await settle();
  env.emitFromTab({ url: `${PAGE}#x` });
  await done;

  assert.equal(env.listenerCount(), 0, 'onUpdated listener must be detached after finish');
});
