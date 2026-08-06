import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Must match history-view.js import: `./ui.js?v=41` so both share one `elements` object.
const UI_MODULE = '../../backend/static/js/modules/ui.js?v=41';

function installBrowserGlobals() {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(`
        <!doctype html>
        <body>
            <button id="history-search-open-btn"></button>
            <div id="history-search-box"></div>
            <input id="history-search-input">
            <button id="history-search-close-btn"></button>
            <div id="history-list"></div>
        </body>
    `, { url: 'http://localhost/' });

    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;
    globalThis.HTMLElement = dom.window.HTMLElement;
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

    return dom;
}

test('history search uses backend full-text results without replacing cached history', async () => {
    const dom = installBrowserGlobals();
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const requests = [];

    globalThis.setTimeout = (callback) => {
        if (typeof callback === 'function') callback();
        return 0;
    };
    globalThis.clearTimeout = () => {};
    try {
        const { elements, initUI } = await import(UI_MODULE);
        const historyView = await import('../../backend/static/js/modules/history-view.js?test=fts-search');
        initUI();

        globalThis.fetch = async (input) => {
            requests.push(String(input));
            return new Response(JSON.stringify([
                {
                    id: 'body-hit',
                    title: 'Unrelated visible title',
                    timestamp: '2026-01-01T00:00:00Z',
                },
            ]), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        };

        const callbacks = { onSelect: () => {}, onDelete: () => {} };
        historyView.renderHistory(
            [{ id: 'cached-chat', title: 'Cached title', timestamp: '2026-01-02T00:00:00Z' }],
            '',
            callbacks,
            [],
        );
        historyView.setupHistorySearch(callbacks);

        elements.historySearchInput.value = 'hidden body text';
        elements.historySearchInput.dispatchEvent(new Event('input', { bubbles: true }));

        await new Promise(resolve => originalSetTimeout(resolve, 0));

        assert.equal(requests[0], '/api/history/search?q=hidden%20body%20text');
        assert.match(elements.historyList.textContent, /Unrelated visible title/);
        assert.equal(historyView.getCachedHistory()[0].id, 'cached-chat');
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
        dom.window.close();
    }
});

test('history item export opens in an isolated new window', async () => {
    const dom = installBrowserGlobals();
    const openedWindows = [];

    window.open = (...args) => {
        openedWindows.push(args);
        return null;
    };

    try {
        const { initUI } = await import(UI_MODULE);
        const historyView = await import('../../backend/static/js/modules/history-view.js?test=export-window');
        initUI();

        historyView.renderHistory(
            [{ id: 'chat id?x=1', title: 'Export target', timestamp: '2026-01-03T00:00:00Z' }],
            '',
            { onSelect: () => {}, onDelete: () => {} },
            [],
        );

        document.querySelector('.history-export-btn').click();

        assert.deepEqual(openedWindows, [[
            '/api/history/chat%20id%3Fx%3D1/export',
            '_blank',
            'noopener,noreferrer',
        ]]);
    } finally {
        dom.window.close();
    }
});
