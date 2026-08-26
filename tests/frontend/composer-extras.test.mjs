/**
 * composer-extras: slash-command menu and the generation status pill —
 * AMC-aligned composer interactions. (Suggestion chips were removed.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

const HARNESS_HTML = `<!doctype html><html><body>
    <div id="input-area">
        <div id="generation-status" hidden>
            <span id="generation-status-title"></span>
            <span id="generation-status-subtitle"></span>
            <button id="generation-status-stop"></button>
        </div>
        <div class="input-box">
            <div id="slash-command-menu" hidden>
                <div id="slash-command-list"></div>
            </div>
            <textarea id="user-input"></textarea>
        </div>
    </div>
    <button id="send-btn"></button>
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
    globalThis.KeyboardEvent = dom.window.KeyboardEvent;
    globalThis.MutationObserver = dom.window.MutationObserver;
    globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
    globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
    return dom;
}

function extrasModuleUrl() {
    return pathToFileURL(path.join(root, 'backend/static/js/modules/composer-extras.js')).href + `?t=${Date.now()}`;
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test('suggestion chips code is fully removed from composer-extras', async () => {
    installBrowserGlobals();
    const js = readFileSync(path.join(root, 'backend/static/js/modules/composer-extras.js'), 'utf8');
    assert.doesNotMatch(js, /SUGGESTIONS/, 'no SUGGESTIONS export');
    assert.doesNotMatch(js, /suggestion/i, 'no suggestion remnants');
});

test('slash menu opens on "/", keyboard select applies intensity and strips the token', async () => {
    installBrowserGlobals();
    const inputEl = document.getElementById('user-input');
    const applied = [];
    const { setupComposerExtras, SLASH_COMMANDS } = await import(extrasModuleUrl());
    setupComposerExtras({
        inputEl,
        sendBtn: document.getElementById('send-btn'),
        onApplyIntensity: (id) => applied.push(id),
    });

    inputEl.value = '/';
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    assert.equal(document.getElementById('slash-command-menu').hidden, false, 'menu opens on slash');
    const items = document.querySelectorAll('.slash-command-item');
    assert.equal(items.length, SLASH_COMMANDS.length, 'all commands listed');

    // ArrowDown selects the second command, Enter applies it.
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.deepEqual(applied, [SLASH_COMMANDS[1].id], 'selected command applied');
    assert.equal(document.getElementById('slash-command-menu').hidden, true, 'menu closes after apply');

    // The "/token" is stripped; typed text after it is kept.
    inputEl.value = '/深入 关于 AI 的问题';
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.equal(inputEl.value, '关于 AI 的问题');
});

test('slash menu filters by latin command id under zh labels', async () => {
    installBrowserGlobals();
    const inputEl = document.getElementById('user-input');
    const { setupComposerExtras } = await import(extrasModuleUrl());
    setupComposerExtras({
        inputEl,
        sendBtn: document.getElementById('send-btn'),
        onApplyIntensity: () => {},
    });

    // Default locale is zh, so the visible label is 快速 — the latin id "quick"
    // must still match (ids are stable even when labels are translated).
    inputEl.value = '/quick';
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    assert.equal(document.getElementById('slash-command-menu').hidden, false, 'menu opens on slash');
    const items = Array.from(document.querySelectorAll('.slash-command-item'));
    assert.equal(items.length, 1, 'only the matching command remains');
    assert.equal(items[0].dataset.commandId, 'quick', 'matched by latin id');
    assert.match(items[0].querySelector('.slash-command-label').textContent, /快速/);
});

test('generation status pill mirrors the send button processing state', async () => {
    installBrowserGlobals();
    const inputEl = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    const pill = document.getElementById('generation-status');
    const { setupComposerExtras } = await import(extrasModuleUrl());
    setupComposerExtras({
        inputEl,
        sendBtn,
        onApplyIntensity: () => {},
        getStatusText: () => ({ title: '正在搜索', subtitle: '均衡 · Google' }),
    });

    assert.equal(pill.hidden, true, 'hidden while idle');
    sendBtn.classList.add('processing');
    await tick();
    assert.equal(pill.hidden, false, 'shown while processing');
    assert.equal(document.getElementById('generation-status-subtitle').textContent, '均衡 · Google');

    sendBtn.classList.remove('processing');
    await tick();
    assert.equal(pill.hidden, true, 'hidden again after processing');
});
