/**
 * shortcuts-help: AMC-aligned keyboard shortcuts modal.
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
    <div class="sidebar-header-buttons">
        <button id="shortcuts-help-btn" class="icon-btn" aria-label="键盘快捷键">?</button>
    </div>
    <div id="shortcuts-help-modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="shortcuts-help-title">
        <div class="modal-content shortcuts-help-content">
            <div class="modal-header">
                <h2 id="shortcuts-help-title">键盘快捷键</h2>
                <span class="close-btn shortcuts-help-close" role="button" tabindex="0">&times;</span>
            </div>
            <div class="shortcuts-help-search">
                <input type="search" id="shortcuts-help-search-input" aria-label="搜索快捷键">
            </div>
            <div class="modal-body" id="shortcuts-help-list"></div>
        </div>
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
    globalThis.KeyboardEvent = dom.window.KeyboardEvent;
    globalThis.MutationObserver = dom.window.MutationObserver || class { observe() {} disconnect() {} };
    globalThis.Element = dom.window.Element;
    return dom;
}

function moduleUrl() {
    return pathToFileURL(path.join(root, 'backend/static/js/modules/shortcuts-help.js')).href + `?t=${Date.now()}`;
}

function dispatchKey(target, key, opts = {}) {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
    target.dispatchEvent(ev);
}

test('help modal lists all shortcuts with groups and filters by search', async () => {
    installBrowserGlobals();
    const modal = document.getElementById('shortcuts-help-modal');
    const list = document.getElementById('shortcuts-help-list');
    const searchInput = document.getElementById('shortcuts-help-search-input');

    const { setupShortcutsHelp, SHORTCUTS } = await import(moduleUrl());
    assert.ok(SHORTCUTS.length >= 10, 'shortcut catalog is populated');

    const handle = setupShortcutsHelp();
    assert.ok(handle, 'setup returned a handle');

    handle.open();
    assert.ok(modal.classList.contains('active'), 'modal opened');
    assert.ok(searchInput === document.activeElement, 'search input focused');

    // All shortcuts rendered under their group titles.
    const rows = list.querySelectorAll('.shortcuts-help-row');
    assert.equal(rows.length, SHORTCUTS.length);
    const titles = Array.from(list.querySelectorAll('.shortcuts-help-group-title')).map((t) => t.textContent);
    assert.ok(titles.includes('输入') && titles.includes('生成'), 'group titles rendered');

    // Filter by description keyword.
    searchInput.value = '重新生成';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    assert.equal(list.querySelectorAll('.shortcuts-help-row').length, 1);
    assert.match(list.querySelector('.shortcuts-help-desc').textContent, /重新生成/);

    // Filter by key fragment too.
    searchInput.value = 'enter';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    assert.ok(list.querySelectorAll('.shortcuts-help-row').length >= 2, 'matches by key');

    // No match → empty state.
    searchInput.value = 'zzz-nope';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    assert.ok(list.querySelector('.shortcuts-help-empty'), 'empty state shown');
});

test('? key toggles the modal but not while typing or with another modal open', async () => {
    installBrowserGlobals();
    const modal = document.getElementById('shortcuts-help-modal');
    const { setupShortcutsHelp } = await import(moduleUrl());
    const handle = setupShortcutsHelp();

    // Plain document focus: `?` opens.
    dispatchKey(document.body, '?', { shiftKey: true });
    assert.ok(modal.classList.contains('active'), 'opened via ?');
    // Pressing `?` again closes.
    dispatchKey(document.body, '?', { shiftKey: true });
    assert.ok(!modal.classList.contains('active'), 'toggled closed');

    // Focus inside an editable element: `?` does nothing.
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    dispatchKey(input, '?', { shiftKey: true });
    assert.ok(!modal.classList.contains('active'), 'ignored while typing');

    // Another modal open (e.g. settings): `?` does nothing.
    input.blur();
    const other = document.createElement('div');
    other.className = 'modal active';
    other.id = 'settings-modal';
    document.body.appendChild(other);
    dispatchKey(document.body, '?', { shiftKey: true });
    assert.ok(!modal.classList.contains('active'), 'ignored when another modal is open');
    other.remove();
});

test('button opens, close button closes, Esc and backdrop close', async () => {
    installBrowserGlobals();
    const modal = document.getElementById('shortcuts-help-modal');
    const btn = document.getElementById('shortcuts-help-btn');
    const closeBtn = modal.querySelector('.shortcuts-help-close');
    const { setupShortcutsHelp } = await import(moduleUrl());
    const handle = setupShortcutsHelp();

    btn.click();
    assert.ok(modal.classList.contains('active'), 'button opens');

    closeBtn.click();
    assert.ok(!modal.classList.contains('active'), 'close button closes');

    // Backdrop mousedown closes.
    btn.click();
    modal.dispatchEvent(new Event('mousedown', { bubbles: true }));
    assert.ok(!modal.classList.contains('active'), 'backdrop click closes');
    assert.equal(handle.isOpen(), false, 'handle state tracked');
});
