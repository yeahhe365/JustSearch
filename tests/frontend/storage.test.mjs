import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function installBrowserGlobals() {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });

    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.NodeFilter = dom.window.NodeFilter;
    Object.defineProperty(globalThis, 'navigator', {
        value: dom.window.navigator,
        configurable: true,
    });
    window.markdownit = () => ({
        render: value => String(value || ''),
        utils: { escapeHtml: value => String(value || '') },
    });
    window.DOMPurify = { sanitize: value => String(value || '') };
    window.hljs = { getLanguage: () => false };
    window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
}

function replaceLocalStorage(storage) {
    Object.defineProperty(globalThis, 'localStorage', {
        value: storage,
        configurable: true,
    });
    Object.defineProperty(window, 'localStorage', {
        value: storage,
        configurable: true,
    });
}

test('sidebar and settings storage helpers tolerate unavailable localStorage', async () => {
    installBrowserGlobals();

    const failingStorage = {
        getItem() {
            throw new Error('storage unavailable');
        },
        setItem() {
            throw new Error('storage unavailable');
        },
    };
    replaceLocalStorage(failingStorage);

    const { __sidebarTestHooks } = await import('../../backend/static/js/modules/sidebar.js?v=21&test=storage-guard');
    const { __settingsModalTestHooks } = await import('../../backend/static/js/modules/settings-modal.js?test=storage-guard');

    assert.equal(__sidebarTestHooks.safeGetLocalStorageItem('sidebarCollapsed', 'false'), 'false');
    assert.doesNotThrow(() => __sidebarTestHooks.safeSetLocalStorageItem('sidebarCollapsed', true));
    assert.equal(__settingsModalTestHooks.safeGetLocalStorageItem('justsearch_settings_last_tab', 'general'), 'general');
    assert.doesNotThrow(() => __settingsModalTestHooks.safeSetLocalStorageItem('justsearch_settings_last_tab', 'models'));
});
