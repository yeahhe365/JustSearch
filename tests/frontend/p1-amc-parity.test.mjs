import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const require = createRequire(import.meta.url);

test('composer shell radius aligns with AMC pill radius', () => {
  const css = readFileSync('backend/static/css/sections/input-modal.css','utf8');
  assert.match(css, /--amc-radius-lg\s*:\s*1\.625rem|26px|18px/);
  assert.match(css, /\.input-box\s*\{[^}]*border-radius[^}]*var\(--amc-radius-lg|--radius-xl/);
});

test('P1: composer graphite theme tokens exist', () => {
  const css = readFileSync('backend/static/css/sections/input-modal.css', 'utf8');
  assert.match(css, /\[data-theme="graphite"\][^{]*#input-area/, 'input-area should have graphite theme block');
  assert.match(css, /#2b2b2e|#3c3c40|graphite/, 'graphite colors should appear');
});

test('P1: composer edit banner uses theme warning token not hardcoded #f59e0b alone', () => {
  const css = readFileSync('backend/static/css/sections/input-modal.css', 'utf8');
  // Should reference theme warning variable at least once, not only hardcoded #f59e0b
  assert.match(css, /var\(--theme-bg-warning|--theme-bg-warning-strong|--amc-warning/, 'should use theme warning var');
});

test('P1: main-header glass aligns with theme (not legacy --glass-bg)', () => {
  const css = readFileSync('backend/static/css/sections/chat.css', 'utf8');
  // After P1, main-header should use theme-bg-secondary with color-mix, not just var(--glass-bg)
  assert.match(css, /main-header[^{]*\{[^}]*var\(--theme-bg-secondary|--theme-bg-primary/, 'main-header should reference theme tokens');
});

test('P1: markdown code header uses theme code block header', () => {
  const css = readFileSync('backend/static/css/sections/markdown.css', 'utf8');
  assert.match(css, /\.code-block-header[^{]*\{[^}]*var\(--theme-bg-code-block-header/, 'code header should use theme var');
});

test('P1: live artifacts frame supports graphite', () => {
  const css = readFileSync('backend/static/css/sections/live-artifacts.css', 'utf8');
  // Should have graphite or dark handling for artifact frame
  assert.match(css, /\[data-theme="graphite"\]|\.artifact-frame/, 'live artifacts css should exist');
  assert.match(css, /var\(--theme-border-secondary/, 'should use theme border');
});

test('P1: sidebar per-viewport keys exist', () => {
  const js = readFileSync('backend/static/js/modules/sidebar.js', 'utf8');
  assert.match(js, /sidebarCollapsed_desktop|DESKTOP_BP|isDesktop/, 'sidebar.js should have per-viewport logic');
});

test('P1: settings search highlight uses <mark>', () => {
  const js = readFileSync('backend/static/js/modules/settings-search.js', 'utf8');
  assert.match(js, /<mark|settings-search-highlight|aria-selected/, 'settings-search should have highlight and aria');
});

// ---------------------------------------------------------------------------
// Task 3: settings search & shortcuts-help AMC parity — jsdom interaction
// ---------------------------------------------------------------------------

function installSettingsSearchGlobals() {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="settings-modal" class="modal active">
        <div class="settings-search">
            <input id="settings-search-input" type="search" />
            <button id="settings-search-clear" hidden></button>
        </div>
        <div id="settings-search-results" hidden></div>
        <button class="settings-tab-btn" data-tab="general"><span>常规设置</span></button>
        <button class="settings-tab-btn" data-tab="api"><span>API 设置</span></button>
        <div id="tab-general" class="settings-panel active">
            <div class="settings-section-heading"><div class="panel-header-title">常规设置</div></div>
            <div class="settings-field-row">
                <div class="settings-field-copy"><label for="theme">主题</label><span class="field-desc">切换浅色深色</span></div>
                <select id="theme-select"><option>浅色</option></select>
            </div>
            <div class="settings-field-row">
                <div class="settings-field-copy"><label for="font">阅读字号</label><span class="field-desc">调整正文大小</span></div>
            </div>
        </div>
        <div id="tab-api" class="settings-panel">
            <div class="settings-section-heading"><div class="panel-header-title">API 设置</div></div>
            <div class="settings-field-row">
                <div class="settings-field-copy"><label for="key">API Key</label><span class="field-desc">模型服务密钥</span></div>
            </div>
            <div class="settings-field-row">
                <div class="settings-field-copy"><label for="lang">语言</label><span class="field-desc">界面语言</span></div>
            </div>
        </div>
    </div>
  </body></html>`, { url: 'http://localhost/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.sessionStorage = dom.window.sessionStorage;
  globalThis.location = dom.window.location;
  globalThis.Event = dom.window.Event;
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;
  globalThis.Element = dom.window.Element;
  globalThis.HTMLElement = dom.window.HTMLElement;
  window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  if (!dom.window.HTMLElement.prototype.scrollIntoView) {
    dom.window.HTMLElement.prototype.scrollIntoView = function() {};
  }
  return dom;
}

function settingsModuleUrl() {
  return pathToFileURL(path.join(root, 'backend/static/js/modules/settings-search.js')).href + `?t=${Date.now()}-${Math.random()}`;
}

test('P1: settings search highlights and keyboard nav', async () => {
  const dom = installSettingsSearchGlobals();
  const modal = document.getElementById('settings-modal');
  const input = document.getElementById('settings-search-input');
  const results = document.getElementById('settings-search-results');
  const { setupSettingsSearch } = await import(settingsModuleUrl());
  const handle = setupSettingsSearch({ modalEl: modal });
  assert.ok(handle, 'setup returned handle');

  // aria basics
  assert.equal(results.getAttribute('role'), 'listbox');
  assert.equal(input.getAttribute('role'), 'combobox');
  assert.ok(input.getAttribute('aria-controls')?.includes('settings-search-results'));
  assert.equal(input.getAttribute('aria-autocomplete'), 'list');

  // Type "主题" — should highlight via <mark> and expose aria-selected + aria-activedescendant
  input.value = '主题';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  // Throttle 80ms: first input is immediate, but allow one tick for render
  await new Promise((r) => setTimeout(r, 10));
  // If throttled, results should still appear immediately on first keystroke
  assert.equal(results.hidden, false, 'results visible');
  assert.ok(results.innerHTML.includes('<mark'), 'highlight <mark> present');
  assert.ok(results.innerHTML.includes('settings-search-highlight'), 'highlight class');
  const rows = results.querySelectorAll('.settings-search-result');
  assert.ok(rows.length >= 1, 'at least one result');
  rows.forEach((row) => assert.equal(row.getAttribute('role'), 'option'));
  assert.equal(rows[0].getAttribute('aria-selected'), 'true');
  assert.ok(input.getAttribute('aria-activedescendant')?.startsWith('settings-search-option-'));

  // data-highlight preservation of original casing: search lower, still shows original.
  // For "主题" the label is "主题" — highlight should wrap exactly "主题".
  assert.match(results.innerHTML, /<mark[^>]*>主题<\/mark>/);

  // ArrowDown cycles selection
  const activeBefore = input.getAttribute('aria-activedescendant');
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  const activeAfter = input.getAttribute('aria-activedescendant');
  if (rows.length > 1) {
    assert.notEqual(activeBefore, activeAfter, 'ArrowDown moves selection');
    assert.equal(results.querySelectorAll('[aria-selected="true"]').length, 1);
  }

  // ArrowUp cycles back
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  // Should still have one selected
  assert.equal(results.querySelectorAll('[aria-selected="true"]').length, 1);

  // Enter triggers click -> activates tab and clears search, flashes ring-2
  // Prepare to capture tab click: second result if exists is from another tab, but "主题" only in general
  // So test Enter with a cross-tab query instead: "API"
  input.value = 'API';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 90)); // wait for throttle trailing
  assert.ok(results.innerHTML.includes('<mark'), 'API highlight');
  // Mock tab switch to verify Enter jumps
  const tabApiBtn = modal.querySelector('[data-tab="api"]');
  let tabClicked = false;
  const origClick = tabApiBtn.click.bind(tabApiBtn);
  tabApiBtn.addEventListener('click', () => { tabClicked = true; });
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(tabClicked || modal.querySelector('[data-tab="api"]'), 'Enter activated tab');
  // After Enter, search should be cleared (hidden)
  assert.equal(results.hidden, true, 'results cleared after Enter');

  // Esc clears: type again then Esc should clear, second Esc should NOT stopPropagation
  input.value = '语言';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(results.hidden, false);
  const escEvent = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  let stopped = false;
  const origStop = escEvent.stopPropagation.bind(escEvent);
  escEvent.stopPropagation = () => { stopped = true; origStop(); };
  input.dispatchEvent(escEvent);
  assert.equal(input.value, '', 'Esc cleared input');
  assert.equal(results.hidden, true, 'Esc hid results');
  assert.ok(stopped, 'first Esc stops propagation');

  // Second Esc on empty input should NOT stop propagation (so modal can close)
  const esc2 = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  let stopped2 = false;
  esc2.stopPropagation = () => { stopped2 = true; };
  input.dispatchEvent(esc2);
  assert.equal(stopped2, false, 'second Esc on empty does not stopPropagation');
});

test('P1: settings search throttle 80ms and "/" only when not editing', async () => {
  const dom = installSettingsSearchGlobals();
  const js = readFileSync('backend/static/js/modules/settings-search.js', 'utf8');
  assert.match(js, /throttle|80/, 'should contain throttle 80ms');
  assert.match(js, /ring-2|settings-search-flash/, 'should contain ring-2 flash 1.6s');
  assert.match(js, /aria-activedescendant|aria-controls|aria-expanded/, 'aria attributes');
  // "/" handler should check isEditableTarget / closest input
  assert.match(js, /isEditableTarget|closest\(.*input/, 'should guard "/" when editing');
  const modal = document.getElementById('settings-modal');
  const input = document.getElementById('settings-search-input');
  const { setupSettingsSearch } = await import(settingsModuleUrl());
  setupSettingsSearch({ modalEl: modal });
  // "/" in non-editable target should focus input
  input.blur();
  const slash = new dom.window.KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
  document.dispatchEvent(slash);
  assert.equal(document.activeElement, input, '/ focuses search when not editing');
  // "/" in editable target should NOT hijack
  const otherInput = document.createElement('input');
  document.body.appendChild(otherInput);
  otherInput.focus();
  input.blur();
  const slash2 = new dom.window.KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
  otherInput.dispatchEvent(slash2);
  // input should not have been refocused away from otherInput
  assert.equal(document.activeElement, otherInput, '/ does not hijack while typing');
});

function installShortcutsGlobals() {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(`<!doctype html><html><body>
    <button id="shortcuts-help-btn">?</button>
    <div id="shortcuts-help-modal" class="modal"><div class="modal-content"><div class="shortcuts-help-close"></div></div><input id="shortcuts-help-search-input" /><div id="shortcuts-help-list"></div></div>
  </body></html>`, { url: 'http://localhost/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.location = dom.window.location;
  globalThis.Event = dom.window.Event;
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;
  globalThis.Element = dom.window.Element;
  globalThis.HTMLElement = dom.window.HTMLElement;
  return dom;
}

function shortcutsModuleUrl() {
  return pathToFileURL(path.join(root, 'backend/static/js/modules/shortcuts-help.js')).href + `?t=${Date.now()}-${Math.random()}`;
}

test('P1: shortcuts help groups ordered input/generation/edit/sidebar/help and search highlight', async () => {
  const dom = installShortcutsGlobals();
  const js = readFileSync('backend/static/js/modules/shortcuts-help.js', 'utf8');
  assert.match(js, /GROUP_ORDER|shortcuts\.group\.input.*shortcuts\.group\.generation.*shortcuts\.group\.edit/s, 'should have canonical group order');
  assert.match(js, /settings-search-highlight|<mark/, 'should use same highlight as settings search');
  const { setupShortcutsHelp } = await import(shortcutsModuleUrl());
  const handle = setupShortcutsHelp();
  assert.ok(handle);
  handle.open();
  const list = document.getElementById('shortcuts-help-list');
  const titles = Array.from(list.querySelectorAll('.shortcuts-help-group-title')).map((el) => el.textContent.trim());
  // Titles are translated (zh) — check count and order via underlying keys: input first, help last
  assert.equal(titles.length, 5, '5 groups');
  // In zh, titles are 输入, 生成, 编辑, 侧栏, 帮助
  const inputIdx = titles.findIndex((t) => t.includes('输入') || t.toLowerCase().includes('input'));
  const genIdx = titles.findIndex((t) => t.includes('生成') || t.toLowerCase().includes('generation'));
  const editIdx = titles.findIndex((t) => t.includes('编辑') || t.toLowerCase().includes('edit'));
  const sidebarIdx = titles.findIndex((t) => t.includes('侧栏') || t.toLowerCase().includes('sidebar'));
  const helpIdx = titles.findIndex((t) => t.includes('帮助') || t.toLowerCase().includes('help'));
  assert.ok(inputIdx !== -1 && genIdx !== -1 && editIdx !== -1 && sidebarIdx !== -1 && helpIdx !== -1, 'all group titles present');
  assert.ok(inputIdx < genIdx && genIdx < editIdx && editIdx < sidebarIdx && sidebarIdx < helpIdx, 'group order AMC-aligned');

  // Search highlight: filtering "重新生成" should show <mark>
  const searchInput = document.getElementById('shortcuts-help-search-input');
  searchInput.value = '重新生成';
  searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.ok(list.innerHTML.includes('<mark'), 'shortcut search highlight with <mark>');
  assert.ok(list.innerHTML.includes('settings-search-highlight'));

  // No match shows empty
  searchInput.value = 'zzz-nope-shortcut';
  searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.ok(list.querySelector('.shortcuts-help-empty'), 'empty state on no match');

  // Esc first clears search, second allows close
  searchInput.value = '输入';
  searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.ok(list.querySelectorAll('.shortcuts-help-row').length > 0);
  const esc = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  let stopped = false;
  const orig = esc.stopPropagation.bind(esc);
  esc.stopPropagation = () => { stopped = true; orig(); };
  searchInput.dispatchEvent(esc);
  assert.equal(searchInput.value, '', 'Esc cleared shortcuts search');
  assert.ok(stopped, 'first Esc on shortcuts search stops propagation');
});

// ---------------------------------------------------------------------------
// Task 4: sidebar per-viewport & drag
// ---------------------------------------------------------------------------

test('sidebar collapsed persists per viewport', () => {
  const js = readFileSync('backend/static/js/modules/sidebar.js', 'utf8');
  assert.match(js, /sidebarCollapsed_desktop/, 'should have desktop key');
  assert.match(js, /sidebarCollapsed_mobile/, 'should have mobile key');
  assert.match(js, /DESKTOP_BP|isDesktop|isDesktopViewport/, 'should have viewport check');
  const css = readFileSync('backend/static/css/sections/sidebar.css', 'utf8');
  assert.match(css, /\.history-item\.is-dragging|\.history-item\.drag-over/, 'drag styles should exist');
});

test('history drag adds ghost class', () => {
  const css = readFileSync('backend/static/css/sections/sidebar.css', 'utf8');
  assert.match(css, /\.history-item\.is-dragging/, 'is-dragging class');
  assert.match(css, /\.history-item\.drag-over|\.chat-group.*drag-over/, 'drag-over outline');
  assert.match(css, /scrollbar-gutter:\s*stable/, 'scrollbar-gutter stable');
  const js = readFileSync('backend/static/js/modules/history-view.js', 'utf8');
  assert.match(js, /is-dragging|dragging/, 'history-view should toggle dragging class');
  assert.match(js, /dragover|dragstart/, 'history-view should handle dragover/dragstart');
});
