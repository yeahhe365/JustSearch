/**
 * settings-search: AMC-aligned search over all settings tabs.
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
    <div id="settings-modal">
        <div class="settings-search">
            <input id="settings-search-input" type="search" />
            <button id="settings-search-clear" hidden></button>
        </div>
        <div id="settings-search-results" hidden></div>
        <button class="settings-tab-btn" data-tab="general"><span>常规设置</span></button>
        <button class="settings-tab-btn" data-tab="api"><span>模型设置</span></button>
        <div id="tab-general" class="settings-panel">
            <div class="settings-section-heading"><div class="panel-header-title">常规设置</div></div>
            <div class="settings-field-row">
                <div class="settings-field-copy"><label for="theme">主题</label><span class="field-desc">切换浅色深色</span></div>
            </div>
            <div class="settings-field-row">
                <div class="settings-field-copy"><label for="font">阅读字号</label><span class="field-desc">调整正文大小</span></div>
            </div>
        </div>
        <div id="tab-api" class="settings-panel">
            <div class="settings-section-heading"><div class="panel-header-title">模型设置</div></div>
            <div class="settings-field-row">
                <div class="settings-field-copy"><label for="key">API Key</label><span class="field-desc">模型服务密钥</span></div>
            </div>
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
    window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
    if (!dom.window.HTMLElement.prototype.scrollIntoView) {
        dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
    }
    return dom;
}

function moduleUrl() {
    return pathToFileURL(path.join(root, 'backend/static/js/modules/settings-search.js')).href + `?t=${Date.now()}`;
}

function activateTab(modal, tabId) {
    // Minimal version of settings-modal.js switchTab
    modal.querySelectorAll('.settings-tab-btn').forEach((t) => {
        t.classList.toggle('active', t.dataset.tab === tabId);
    });
    modal.querySelectorAll('.settings-panel').forEach((p) => {
        p.classList.toggle('active', p.id === `tab-${tabId}`);
    });
}

test('settings search finds labels across tabs and jumps on click', async () => {
    installBrowserGlobals();
    const modal = document.getElementById('settings-modal');
    const input = document.getElementById('settings-search-input');
    const results = document.getElementById('settings-search-results');
    // wire tab buttons to a switchTab-like handler so clicks activate panels
    modal.querySelectorAll('.settings-tab-btn').forEach((t) => {
        t.addEventListener('click', () => activateTab(modal, t.dataset.tab));
    });
    activateTab(modal, 'general');

    const { setupSettingsSearch } = await import(moduleUrl());
    const handle = setupSettingsSearch({ modalEl: modal });
    assert.ok(handle, 'setup returned a handle');

    input.value = 'api key';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const rows = results.querySelectorAll('.settings-search-result');
    assert.equal(rows.length, 1, 'matches the API Key label');
    assert.match(rows[0].textContent, /模型设置/);
    assert.match(rows[0].textContent, /API Key/);

    // Clicking the result should activate the api tab and reveal the field.
    rows[0].click();
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(document.getElementById('tab-api').classList.contains('active'), 'jumped to api tab');
    assert.equal(results.hidden, true, 'results cleared after jump');
    const field = document.querySelector('#tab-api .settings-field-row');
    assert.ok(field.classList.contains('settings-search-flash'), 'target flashed');
});

test('no match shows the empty state and clear resets', async () => {
    installBrowserGlobals();
    const modal = document.getElementById('settings-modal');
    const input = document.getElementById('settings-search-input');
    const results = document.getElementById('settings-search-results');
    const clearBtn = document.getElementById('settings-search-clear');

    const { setupSettingsSearch } = await import(moduleUrl());
    setupSettingsSearch({ modalEl: modal });

    input.value = 'zzz-no-such-setting';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    assert.equal(results.hidden, false);
    assert.ok(results.querySelector('.settings-search-empty'), 'empty state shown');
    assert.equal(clearBtn.hidden, false, 'clear button shown');

    clearBtn.click();
    assert.equal(input.value, '');
    assert.equal(results.hidden, true);
    assert.equal(clearBtn.hidden, true);
});
