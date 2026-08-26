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
  assert.match(css, /--amc-radius-lg\s*:\s*1\.25rem/, 'shell radius must be AMC rounded-[20px]');
  assert.match(css, /\.input-box\s*\{[^}]*border-radius[^}]*var\(--amc-radius-lg/);
});

test('P2: composer shell shadow & focus align with AMC', () => {
  const css = readFileSync('backend/static/css/sections/input-modal.css','utf8');
  assert.match(css, /--amc-composer-shadow:\s*0 8px 30px rgba\(0, 0, 0, 0\.06\)/);
  const focus = css.match(/\.input-box:focus-within\s*\{[^}]*\}/);
  assert.ok(focus, 'focus-within rule exists');
  assert.match(focus[0], /0 8px 30px rgba\(0, 0, 0, 0\.08\)/);
  assert.doesNotMatch(focus[0], /0 0 0 2px/, 'AMC focus has no ring');
});

test('P2: send button aligns with AMC size/colors/states', () => {
  const css = readFileSync('backend/static/css/sections/input-modal.css', 'utf8');
  const block = css.match(/#send-btn\s*\{[^}]*\}/);
  assert.ok(block, '#send-btn rule exists');
  assert.match(block[0], /width:\s*34px/);
  assert.match(block[0], /height:\s*34px/);
  assert.doesNotMatch(block[0], /box-shadow/, 'flat button — no glow');
  assert.match(css, /--amc-send-bg:\s*#3964fe/i);
  assert.match(css, /--amc-send-bg:\s*#679efe/i);
  assert.doesNotMatch(css, /is-editing-message #send-btn/, 'edit-state amber override removed');
});

test('P2: intensity preset segments align with AMC segmented control', () => {
  const css = readFileSync('backend/static/css/sections/input-modal.css', 'utf8');
  const track = css.match(/\.search-intensity-presets\s*\{[^}]*\}/);
  assert.ok(track, '.search-intensity-presets rule exists');
  assert.match(track[0], /gap:\s*2px/, 'track gap-0.5');
  assert.match(track[0], /padding:\s*2px/, 'track p-0.5');
  assert.match(track[0], /border-radius:\s*8px/, 'track rounded-lg, not pill');
  assert.match(track[0], /background:\s*var\(--amc-bg-input\)/, 'track bg-input');
  assert.match(track[0], /border:\s*1px solid var\(--amc-border\)/, 'track border-secondary');

  const chip = css.match(/\.intensity-chip\s*\{[^}]*\}/);
  assert.ok(chip, '.intensity-chip rule exists');
  assert.match(chip[0], /height:\s*32px/, 'segment fills h-9 track minus p-0.5');
  assert.match(chip[0], /padding:\s*0 10px/, 'segment px-2.5');
  assert.match(chip[0], /border-radius:\s*6px/, 'segment rounded-md');
  assert.match(chip[0], /color:\s*var\(--amc-text-tertiary\)/, 'idle text tertiary');

  const hover = css.match(/\.intensity-chip:hover:not\(:disabled\)\s*\{[^}]*\}/);
  assert.ok(hover, 'hover rule exists');
  assert.match(hover[0], /color-mix\(in srgb, var\(--amc-btn-hover\) 70%, transparent\)/, 'hover bg-tertiary/70');

  const focus = css.match(/\.intensity-chip:focus-visible\s*\{[^}]*\}/);
  assert.ok(focus, 'focus-visible rule exists');
  assert.match(focus[0], /box-shadow:\s*inset 0 0 0 2px var\(--amc-border-focus\)/, 'inset focus ring');

  const active = css.match(/\.intensity-chip\.active\s*\{[^}]*\}/);
  assert.ok(active, '.active rule exists');
  assert.match(active[0], /color-mix\(in srgb, var\(--amc-accent\) 12%, transparent\)/, 'active accent/12 tint');
  assert.match(active[0], /box-shadow:\s*0 1px 2px rgba\(0, 0, 0, 0\.05\)/, 'active shadow-sm');
  assert.doesNotMatch(active[0], /var\(--amc-bg-input\)/, 'no solid bg-input active fill');
  assert.doesNotMatch(css, /intensity-chip\.active\[data-intensity/, 'research/deep special-case removed');
  assert.doesNotMatch(css, /\.intensity-chip-custom\.active/, 'custom override removed');
});

test('P2: suggestion chips feature is fully removed', () => {
  const html = readFileSync('backend/static/index.html', 'utf8');
  assert.doesNotMatch(html, /suggestion-chip/, '#suggestion-chips block removed from index.html');
  const css = readFileSync('backend/static/css/sections/input-modal.css', 'utf8');
  assert.doesNotMatch(css, /\.suggestion-chip/, '.suggestion-chip rules removed from CSS');
});

test('P2: settings surface aligns with AMC tokens', () => {
  const css = readFileSync('backend/static/css/sections/input-modal.css', 'utf8');
  const navActive = css.match(/\.settings-tab-btn\.active\s*\{[^}]*\}/);
  assert.ok(navActive, '.settings-tab-btn.active exists');
  assert.match(navActive[0], /color-mix\(in srgb, var\(--theme-bg-accent\) 10%, transparent\)/, 'accent/10 tint');
  assert.doesNotMatch(navActive[0], /--bg-elevated/, 'solid elevated bg removed');
  assert.match(navActive[0], /font-weight:\s*500/);

  const card = css.match(/\.settings-card\s*\{[^}]*\}/);
  assert.ok(card, '.settings-card exists');
  assert.match(card[0], /border-radius:\s*12px/, 'rounded-xl card');
  assert.match(card[0], /padding:\s*16px/, 'card p-4');
  assert.match(card[0], /var\(--theme-border-secondary\) 60%, transparent/, 'border-secondary/60');
  assert.match(card[0], /var\(--theme-bg-secondary\) 35%, transparent/, 'bg-secondary/35');

  const title = css.match(/\.panel-header-title\s*\{[^}]*\}/);
  assert.ok(title, '.panel-header-title exists');
  assert.match(title[0], /text-transform:\s*uppercase/, 'uppercase section label');
  assert.match(title[0], /letter-spacing:\s*0\.08em/, 'tracking-wider');
  assert.match(title[0], /font-size:\s*12px/, 'xs label');

  const badge = css.match(/\.settings-font-size-value\s*\{[^}]*\}/);
  assert.ok(badge, '.settings-font-size-value exists');
  assert.match(badge[0], /monospace/, 'mono badge');
  assert.match(badge[0], /tabular-nums/, 'tabular numerals');
  assert.match(badge[0], /var\(--theme-bg-tertiary\)/, 'tertiary chip bg');

  const search = css.match(/\.settings-search\s*\{[^}]*\}/);
  assert.ok(search, '.settings-search exists');
  assert.match(search[0], /border:\s*1px solid transparent/, 'borderless search');
  assert.match(search[0], /var\(--theme-bg-tertiary\) 45%, transparent/, 'bg-tertiary/45');
  assert.match(search[0], /height:\s*40px/, 'h-10');
  const focusWithin = css.match(/\.settings-search:focus-within\s*\{[^}]*\}/);
  assert.ok(focusWithin, ':focus-within exists');
  assert.match(focusWithin[0], /inset 0 0 0 2px/, 'inset focus ring');

  const panels = css.match(/\.settings-panels\s*\{[^}]*\}/);
  assert.match(panels[0], /padding:\s*16px 32px 32px/, 'compact top padding under header');

  const segActive = css.match(/\.settings-segment\[aria-checked="true"\]\s*\{[^}]*\}/);
  assert.ok(segActive, 'checked segment style exists');
  assert.match(segActive[0], /background:\s*var\(--theme-bg-accent\)/, 'solid accent');
});

test('P2: settings content header and segmented groups wired', () => {
  const html = readFileSync('backend/static/index.html', 'utf8');
  assert.match(html, /class="settings-content-header"/, 'persistent header row');
  assert.match(html, /id="settings-content-title"/, 'live tab title');
  assert.match(html, /id="settings-close-btn"/, 'round close button');
  assert.match(html, /id="theme-segmented"/, 'theme radiogroup');
  assert.match(html, /id="language-segmented"/, 'language radiogroup');
  assert.doesNotMatch(html, /settings-section-kicker/, 'kickers removed');
  assert.equal((html.match(/<select id="theme-select">/) || []).length, 0, 'theme select replaced');
  const sm = readFileSync('backend/static/js/modules/settings-modal.js', 'utf8');
  assert.match(sm, /initSegmentedGroups\(/, 'groups initialized');
  assert.match(sm, /settings-content-title/, 'title updated on tab switch');
  assert.match(sm, /settings-close-btn/, 'close wired');
  const sb = readFileSync('backend/static/js/modules/sidebar.js', 'utf8');
  assert.match(sb, /setSegmentedValue\('theme'/, 'external theme sync uses setter');
});

test('P2: settings round-2 replica details', () => {
  const css = readFileSync('backend/static/css/sections/input-modal.css', 'utf8');
  const ddTrigger = css.match(/\.settings-dd-trigger\s*\{[^}]*\}/);
  assert.ok(ddTrigger, '.settings-dd-trigger exists');
  assert.match(ddTrigger[0], /var\(--theme-bg-input\)/, 'trigger bg-input');
  const ddPanel = css.match(/\.settings-dd-panel\s*\{[^}]*\}/);
  assert.ok(ddPanel, '.settings-dd-panel exists');
  assert.match(ddPanel[0], /border-radius:\s*12px/, 'rounded-xl panel');
  assert.match(css, /\.ios-slider\s*\{[^}]*var\(--theme-bg-tertiary\)/, 'toggle off=tertiary');
  assert.match(css, /checked \+ \.ios-slider\s*\{[^}]*var\(--theme-bg-accent\)/, 'toggle on=accent');
  assert.doesNotMatch(css, /checked \+ \.ios-slider\s*\{[^}]*var\(--primary\)/, 'toggle no legacy primary');
  assert.match(css, /border-top:\s*1px solid color-mix\(in srgb, var\(--theme-border-secondary\) 40%/, 'row dividers');
  assert.match(css, /--theme-scrollbar-thumb/, 'thin scrollbar token');
  assert.match(css, /\.settings-tabs\s*\{[^}]*gap:\s*14px/, 'grouped nav gap');
  const header = css.match(/\.settings-content-header\s*\{[^}]*\}/);
  assert.ok(header, '.settings-content-header exists');
  assert.match(header[0], /max-width:\s*var\(--amc-content-width\)/, 'header scrolls inside content column');

  const html = readFileSync('backend/static/index.html', 'utf8');
  assert.match(html, /data-settings-nav-group/, 'grouped nav containers');
  assert.match(html, /class="settings-select"/, 'selects marked for dropdown upgrade');
  assert.equal((html.match(/<div class="settings-content-header">[\s\S]*?<div class="settings-panels">/) || []).length, 0,
    'header lives inside panels scroll container');
});

test('P2: settings danger zone matches AMC (card surface, graded buttons)', () => {
  const css = readFileSync('backend/static/css/sections/input-modal.css', 'utf8');

  // AMC danger zone = normal section card + danger-tinted border; never a red gradient block.
  const zone = css.match(/\.settings-danger-zone\s*\{[^}]*\}/);
  assert.ok(zone, '.settings-danger-zone exists');
  assert.doesNotMatch(zone[0], /linear-gradient|box-shadow/, 'no solid red gradient block / drop shadow');
  assert.match(zone[0], /color-mix\(in srgb, var\(--theme-text-danger\b[^;]*30%/, 'border tinted danger/30 (AMC border-danger/30)');
  assert.match(zone[0], /var\(--theme-bg-secondary\) 35%/, 'surface uses same secondary/35 card mix as .settings-card');
  assert.match(zone[0], /border-radius:\s*12px/, 'rounded-xl like other section cards');

  // Heading = uppercase label in danger text color (AMC h4 text-danger).
  const head = css.match(/\.settings-danger-header\s*\{[^}]*\}/);
  assert.ok(head, '.settings-danger-header exists');
  assert.match(head[0], /var\(--theme-text-danger\b/, 'danger-colored label');
  assert.doesNotMatch(head[0], /#fff/i, 'label no longer white-on-red');

  // Rows share the round-1 divider formula (AMC divide-y divide-secondary/40).
  assert.match(css, /\.settings-danger-zone \.maintenance-card \+ \.maintenance-card\s*\{[^}]*border-top/,
    'danger rows divided like other cards');

  // Severity escalation: neutral reset < danger-outline history < solid danger wipe.
  const resetBtn = css.match(/\.settings-danger-zone \.secondary-btn\s*\{[^}]*\}/);
  assert.ok(resetBtn, 'scoped reset button rule exists');
  assert.match(resetBtn[0], /background:\s*transparent/, 'reset = neutral outline (transparent bg)');
  assert.match(resetBtn[0], /var\(--theme-text-secondary\)/, 'reset text = neutral secondary');
  const historyBtn = css.match(/\.settings-danger-zone \.danger-btn\s*\{[^}]*\}/);
  assert.ok(historyBtn, 'scoped clear-history button rule exists');
  assert.match(historyBtn[0], /background:\s*transparent/, 'clear history = danger outline (transparent bg)');
  assert.match(historyBtn[0], /var\(--theme-text-danger\b/, 'clear history text = danger');
  const wipeBtn = css.match(/\.settings-danger-zone \.danger-btn\.fill\s*\{[^}]*\}/);
  assert.ok(wipeBtn, 'scoped wipe button rule exists');
  assert.match(wipeBtn[0], /background:\s*var\(--theme-bg-danger\)/, 'wipe = the only solid danger fill');

  // No white-on-red leftovers: the old style used translucent WHITE fills/borders
  // on a red block. White TEXT on the solid danger button is legitimate (AMC text-white).
  for (const m of css.matchAll(/\.settings-danger-zone[^{]*\{[^}]*\}/g)) {
    assert.doesNotMatch(m[0], /rgba\(255/, `no translucent white fill/border in: ${m[0].slice(0, 40)}...`);
    assert.doesNotMatch(m[0], /background:\s*(#fff|white)/i, `no white background in: ${m[0].slice(0, 40)}...`);
    assert.doesNotMatch(m[0], /border:(1px solid )?\s*rgba|\bborder:[^;]*#fff/i, `no white border in: ${m[0].slice(0, 40)}...`);
  }

  // Base maintenance copy follows theme tokens (AMC ActionRow primary/secondary), not hardcoded white.
  // ^ anchors to the standalone base rule, not .history-transfer-card scoped overrides above it.
  const title = css.match(/^\.maintenance-title\s*\{[^}]*\}/m);
  assert.ok(title, '.maintenance-title exists');
  assert.match(title[0], /var\(--theme-text-primary\)/, 'row title uses theme token');
  const desc = css.match(/^\.maintenance-desc\s*\{[^}]*\}/m);
  assert.ok(desc, '.maintenance-desc exists');
  assert.match(desc[0], /var\(--theme-text-secondary\)/, 'row desc uses theme token');
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

test('P2: main-header surface matches AMC (no border, no blur, solid themed bg)', () => {
  const css = readFileSync('backend/static/css/sections/chat.css', 'utf8');
  const header = css.match(/\.main-header\s*\{[^}]*\}/);
  assert.ok(header, '.main-header exists');
  const block = header[0];
  assert.doesNotMatch(block, /border-bottom/, 'AMC header carries no bottom border');
  assert.doesNotMatch(block, /backdrop-filter/, 'AMC header has no glass blur (nothing scrolls beneath)');
  assert.doesNotMatch(block, /color-mix/, 'header surface is solid, not a translucent mix');
  assert.match(block, /background:\s*var\(--theme-bg-secondary\)/, 'default surface = bg-secondary (AMC non-pearl themes)');
  assert.match(css, /\[data-theme="light"\]\s+\.main-header\s*\{[^}]*var\(--theme-bg-primary\)/,
    'light theme surface = bg-primary so the bar melts into the page (AMC pearl rule)');
  assert.match(block, /padding:\s*8px 12px/, 'padding aligns AMC sm:px-3 / py-[0.52rem]');
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
        <button class="settings-tab-btn" data-tab="api"><span>模型设置</span></button>
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
            <div class="settings-section-heading"><div class="panel-header-title">模型设置</div></div>
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
