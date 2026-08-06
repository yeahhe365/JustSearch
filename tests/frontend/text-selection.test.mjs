/**
 * text-selection: floating Copy / Quote / Search toolbar over chat messages.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

const HARNESS_HTML = `<!doctype html><html><body>
    <div id="chat-container">
        <div class="message assistant">
            <div class="message-content markdown-body">
                <p>Selectable answer text with citations.</p>
            </div>
        </div>
    </div>
    <textarea id="user-input"></textarea>
    <div id="text-selection-toolbar" class="text-selection-toolbar" hidden>
        <button class="text-selection-btn text-selection-copy"></button>
        <button class="text-selection-btn text-selection-quote"></button>
        <button class="text-selection-btn text-selection-search"></button>
    </div>
</body></html>`;

function installBrowserGlobals(html = HARNESS_HTML) {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(html, { url: 'http://localhost/' });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.localStorage = dom.window.localStorage;
    globalThis.sessionStorage = dom.window.sessionStorage;
    globalThis.location = dom.window.location;
    globalThis.Event = dom.window.Event;
    window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
    window.innerWidth = 800;
    window.innerHeight = 600;
    return dom;
}

function moduleUrl() {
    return pathToFileURL(path.join(root, 'backend/static/js/modules/text-selection.js')).href + `?t=${Date.now()}`;
}

test('toolbar shows/hides and quote fills the composer', async () => {
    installBrowserGlobals();
    const containerEl = document.getElementById('chat-container');
    const inputEl = document.getElementById('user-input');
    const toolbar = document.getElementById('text-selection-toolbar');
    const { setupTextSelectionToolbar } = await import(moduleUrl());

    const handle = setupTextSelectionToolbar({ containerEl, inputEl });
    assert.ok(handle, 'setup returned a handle');

    handle.show('selected words', { left: 100, top: 100, width: 80, height: 20 });
    assert.equal(handle.isVisible(), true, 'toolbar visible after show');

    document.querySelector('.text-selection-quote').click();
    assert.match(inputEl.value, /^> selected words$/);
    assert.equal(handle.isVisible(), false, 'toolbar hides after quote');

    handle.show('again', { left: 50, top: 50, width: 40, height: 16 });
    handle.hide();
    assert.equal(handle.isVisible(), false);
    assert.equal(toolbar.hidden, false, 'hidden attribute kept false so CSS transition runs');
});

test('search button opens Google with the selected text', async () => {
    installBrowserGlobals();
    const opened = [];
    window.open = (url) => opened.push(url);
    const containerEl = document.getElementById('chat-container');
    const { setupTextSelectionToolbar } = await import(moduleUrl());
    const handle = setupTextSelectionToolbar({ containerEl, inputEl: document.getElementById('user-input') });

    handle.show('transformer 架构', { left: 0, top: 0, width: 40, height: 16 });
    document.querySelector('.text-selection-search').click();
    assert.equal(opened.length, 1);
    assert.ok(opened[0].includes('transformer%20%E6%9E%B6%E6%9E%84'), opened[0]);
});
