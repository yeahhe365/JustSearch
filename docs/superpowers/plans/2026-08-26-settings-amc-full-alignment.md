# 设置界面全量对齐 AMC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/superpowers/specs/2026-08-26-settings-amc-full-alignment-design.md` 完成设置界面 8 项全量对齐：侧栏激活态/搜索框、软卡片化分组、大写组标签、数值徽标、内容区常驻标题栏+圆形关闭钮、主题/语言分段控件。

**Architecture:** 新建零依赖小模块 `settings-segmented.js`（radio-group 读写/键盘），`settings-modal.js` 与 `sidebar.js` 都调用它避免循环导入；HTML 把每个 `.settings-section-heading` 移入其后紧跟的 `.settings-card` 作为卡头（kicker 删除，无 title 者由 kicker 转正）；其余全部为 `input-modal.css` 规则改写。搜索锚点类名不变。

**Tech Stack:** Vanilla ESM、node:test + jsdom、Docker Compose 多阶段构建。

## Global Constraints

- 只允许修改/新建：`backend/static/css/sections/input-modal.css`、`backend/static/index.html`、`backend/static/js/modules/settings-modal.js`、`backend/static/js/modules/sidebar.js`、新建 `backend/static/js/modules/settings-segmented.js`、`tests/frontend/p1-amc-parity.test.mjs`、新建 `tests/frontend/settings-segmented.test.mjs`。
- 禁止 `git add -A`；只 add 明确列出的文件（工作树含用户 WIP）。
- i18n 不新增键：分段按钮复用现有 option 的 `data-i18n` 键（`settings.themeLight/Dark/Graphite/Auto`、`settings.languageAuto`）。
- `#settings-save-status` 胶囊 id 与行为保留（随 api 卡头移入卡内）。
- 已知遗留失败：settings-modal "engine check results render untrusted response fields as text"（用户 WIP），不计入回归判定，不得顺手修。
- 生成物不入 commit；部署先 `export PATH="/usr/local/bin:$PATH"`。

---

### Task 1: settings-segmented 模块（TDD）

**Files:**
- Test(新建): `tests/frontend/settings-segmented.test.mjs`
- Create: `backend/static/js/modules/settings-segmented.js`

**Interfaces:**
- Produces: `getSegmentedValue(key) → string|null`、`setSegmentedValue(key, value, {silent}?) → boolean`、`initSegmentedGroups({onChange}?)`。容器约定 `.settings-segmented[data-settings-key]`，片段 `.settings-segment[data-value][aria-checked]`；激活时派发 bubbling `segmentedchange` CustomEvent。

- [ ] **Step 1: 写失败测试** —— 新建 `tests/frontend/settings-segmented.test.mjs`：

```js
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
    <div class="settings-segmented" id="theme-segmented" role="radiogroup" data-settings-key="theme" aria-label="主题">
        <button type="button" class="settings-segment" role="radio" aria-checked="true" data-value="light">浅色</button>
        <button type="button" class="settings-segment" role="radio" aria-checked="false" data-value="dark">深色</button>
        <button type="button" class="settings-segment" role="radio" aria-checked="false" data-value="graphite">中性灰</button>
        <button type="button" class="settings-segment" role="radio" aria-checked="false" data-value="auto">跟随系统</button>
    </div>
</body></html>`;

function install() {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(HARNESS_HTML, { url: 'http://localhost/' });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.CustomEvent = dom.window.CustomEvent;
    return dom;
}

function moduleUrl() {
    return pathToFileURL(path.join(root, 'backend/static/js/modules/settings-segmented.js')).href + `?t=${Date.now()}`;
}

const group = () => document.getElementById('theme-segmented');
const checked = () => group().querySelector('.settings-segment[aria-checked="true"]')?.dataset.value;

test('click activates segment and fires onChange', async () => {
    install();
    const seen = [];
    const { initSegmentedGroups } = await import(moduleUrl());
    initSegmentedGroups({ onChange: (e) => seen.push(e) });
    group().querySelector('[data-value="graphite"]').click();
    assert.equal(checked(), 'graphite');
    assert.deepEqual(seen, [{ key: 'theme', value: 'graphite' }]);
});

test('keyboard wraps and supports Home/End', async () => {
    install();
    const { initSegmentedGroups } = await import(moduleUrl());
    initSegmentedGroups({ onChange: () => {} });
    const last = group().querySelector('[data-value="auto"]');
    last.focus();
    last.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    assert.equal(checked(), 'light', 'ArrowRight wraps to first');
    group().querySelector('[data-value="dark"]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    assert.equal(checked(), 'auto');
});

test('set/get are programmatic and silent', async () => {
    install();
    let fired = 0;
    group().addEventListener('segmentedchange', () => { fired += 1; });
    const { setSegmentedValue, getSegmentedValue } = await import(moduleUrl());
    assert.equal(getSegmentedValue('theme'), 'light');
    assert.equal(setSegmentedValue('theme', 'dark', { silent: true }), true);
    assert.equal(checked(), 'dark');
    assert.equal(fired, 0, 'silent set dispatches nothing');
    assert.equal(getSegmentedValue('theme'), 'dark');
    assert.equal(setSegmentedValue('theme', 'nope'), false, 'unknown value rejected');
});
```

- [ ] **Step 2: 运行确认红**

Run: `cd /Volumes/WD_BLACK/Code/JustSearch && node --test --test-force-exit tests/frontend/settings-segmented.test.mjs 2>&1 | tail -8`
Expected: 3 个用例 FAIL（模块不存在，import 抛错）。

- [ ] **Step 3: 实现** —— 新建 `backend/static/js/modules/settings-segmented.js`：

```js
// ===========================================================================
// Settings segmented control — AMC-style radiogroup replacing the theme /
// language <select>. Zero imports so settings-modal.js and sidebar.js can
// both use it without cycles.
// ===========================================================================

function findGroup(key) {
    return document.querySelector(`.settings-segmented[data-settings-key="${key}"]`);
}

export function getSegmentedValue(key) {
    const group = findGroup(key);
    if (!group) return null;
    return group.querySelector('.settings-segment[aria-checked="true"]')?.dataset.value ?? null;
}

export function setSegmentedValue(key, value, { silent = false } = {}) {
    const group = findGroup(key);
    if (!group) return false;
    const segments = Array.from(group.querySelectorAll('.settings-segment'));
    const target = segments.find((btn) => btn.dataset.value === String(value));
    if (!target) return false;
    if (target.getAttribute('aria-checked') !== 'true') {
        segments.forEach((btn) => btn.setAttribute('aria-checked', btn === target ? 'true' : 'false'));
        if (!silent) {
            group.dispatchEvent(new CustomEvent('segmentedchange', { bubbles: true, detail: { key, value: target.dataset.value } }));
        }
    }
    return true;
}

/** Wire click + keyboard (←/→/↑/↓/Home/End) on every group. Idempotent. */
export function initSegmentedGroups({ onChange } = {}) {
    document.querySelectorAll('.settings-segmented').forEach((group) => {
        if (group.dataset.segmentedInitialized) return;
        group.dataset.segmentedInitialized = '1';
        const key = group.dataset.settingsKey;
        const segments = Array.from(group.querySelectorAll('.settings-segment'));
        const activate = (btn) => {
            if (!btn || btn.getAttribute('aria-checked') === 'true') return;
            segments.forEach((s) => s.setAttribute('aria-checked', s === btn ? 'true' : 'false'));
            group.dispatchEvent(new CustomEvent('segmentedchange', { bubbles: true, detail: { key, value: btn.dataset.value } }));
            if (typeof onChange === 'function') onChange({ key, value: btn.dataset.value });
        };
        segments.forEach((btn) => {
            btn.addEventListener('click', () => activate(btn));
            btn.addEventListener('keydown', (e) => {
                const idx = segments.indexOf(btn);
                let next = null;
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = segments[(idx + 1) % segments.length];
                else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = segments[(idx - 1 + segments.length) % segments.length];
                else if (e.key === 'Home') next = segments[0];
                else if (e.key === 'End') next = segments[segments.length - 1];
                if (next) { e.preventDefault(); next.focus(); activate(next); }
            });
        });
    });
}
```

- [ ] **Step 4: 运行确认绿**

Run: `cd /Volumes/WD_BLACK/Code/JustSearch && node --test --test-force-exit tests/frontend/settings-segmented.test.mjs 2>&1 | tail -6`
Expected: `pass 3`。

- [ ] **Step 5: 提交**

```bash
cd /Volumes/WD_BLACK/Code/JustSearch && git add backend/static/js/modules/settings-segmented.js tests/frontend/settings-segmented.test.mjs && git commit --no-verify -m "feat: add AMC-style settings segmented control module"
```

---

### Task 2: 设置界面视觉/结构对齐（TDD）

**Files:**
- Modify: `tests/frontend/p1-amc-parity.test.mjs`（追加两组断言）
- Modify: `backend/static/css/sections/input-modal.css`
- Modify: `backend/static/index.html`
- Modify: `backend/static/js/modules/settings-modal.js`
- Modify: `backend/static/js/modules/sidebar.js`

**Interfaces:**
- Consumes: Task 1 的 `getSegmentedValue/setSegmentedValue/initSegmentedGroups`。
- Produces: DOM 锚点 `#settings-content-title`、`#settings-close-btn`、`#theme-segmented`、`#language-segmented`；`.settings-card` 内首子 `.settings-section-heading` 结构（搜索锚点兼容）。

- [ ] **Step 1: 追加失败测试** —— 在 `p1-amc-parity.test.mjs` 的「P2: suggestion chips feature is fully removed」测试之后插入：

```js
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
```

Run 全量确认这两条 FAIL（其余维持现状）：`npm run test:frontend 2>&1 | tail -20`。

- [ ] **Step 2: CSS 改写**（`input-modal.css`，逐块替换）

(a) `.settings-tab-btn.active`（原 `background: var(--bg-elevated); color: var(--text-primary); font-weight: 600;`）→

```css
.settings-tab-btn.active {
    background: color-mix(in srgb, var(--theme-bg-accent) 10%, transparent);
    color: var(--text-primary);
    font-weight: 500;
}
```

(b) `.settings-tab-btn:hover` 的 background 行 `background: color-mix(in srgb, var(--bg-elevated) 60%, var(--border-light));` → `background: color-mix(in srgb, var(--theme-bg-tertiary) 50%, transparent);`

(c) 图标规则 `.settings-tab-btn .material-symbols-rounded, .settings-tab-btn svg { color: var(--text-muted); …}` 中 `color: var(--text-muted)` → `color: var(--theme-text-primary)`（active 分支保持 primary，可顺带删除冗余 active 图标色的第一条规则但保留 stroke-width 规则）。

(d) `.settings-search` 主块与 `:focus-within` 整体替换为：

```css
.settings-search {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 40px;
    padding: 0 10px;
    margin: 0 12px 10px;
    border-radius: 8px;
    border: 1px solid transparent;
    background: color-mix(in srgb, var(--theme-bg-tertiary) 45%, transparent);
    transition: background-color 0.15s ease, box-shadow 0.15s ease;
}
.settings-search:hover {
    background: color-mix(in srgb, var(--theme-bg-tertiary) 70%, transparent);
}
.settings-search:focus-within {
    background: var(--theme-bg-tertiary);
    box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--theme-border-focus) 35%, transparent);
}
```

(e) `.settings-panel` 的 `gap: 22px` → `gap: 24px`；`.settings-panels` 的 `padding: 32px 36px 28px` → `padding: 16px 32px 32px`。

(f) `.settings-card` 块整体替换：

```css
.settings-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: color-mix(in srgb, var(--theme-bg-secondary) 35%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-border-secondary) 60%, transparent);
    border-radius: 12px;
    padding: 16px;
}
```

(g) 卡内行距规则 `.settings-card > .form-group, .settings-card > .settings-field-row, .settings-card > .form-grid { padding: 14px 0; }` → `padding: 12px 0;`，并紧随其后新增：

```css
.settings-card > .settings-section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 0;
}
```

(h) 删除 `.settings-section-kicker` 规则块与 `.api-settings-heading` 规则块（结构已移除/被通用卡头规则覆盖）。

(i) `.panel-header-title` 块替换：

```css
.panel-header-title {
    margin: 0;
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 650;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    line-height: 1.4;
}
```

(j) `.settings-font-size-value` 块整体替换为徽标样式：

```css
.settings-font-size-value {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 6px;
    background: var(--theme-bg-tertiary);
    color: var(--theme-text-primary);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 13px;
    line-height: 1.4;
}
```

(k) 在设置区样式附近新增内容头与分段控件规则：

```css
/* AMC-style persistent content header */
.settings-content-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px 32px 0;
    flex-shrink: 0;
}
.settings-content-title {
    margin: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
    font-size: 20px;
    font-weight: 600;
    line-height: 1.25;
}
.settings-content-close {
    appearance: none;
    border: 0;
    background: transparent;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 9999px;
    color: var(--text-muted);
    cursor: pointer;
    transition: background-color 0.15s ease, color 0.15s ease;
}
.settings-content-close:hover {
    background: var(--theme-bg-tertiary);
    color: var(--text-primary);
}
.settings-content-close .material-symbols-rounded { font-size: 18px; }

/* AMC SETTINGS_SEGMENTED_* tokens */
.settings-segmented {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 4px;
    border-radius: 8px;
    border: 1px solid var(--theme-border-secondary);
    background: color-mix(in srgb, var(--theme-bg-tertiary) 50%, transparent);
    flex-shrink: 0;
}
.settings-segment {
    appearance: none;
    border: 0;
    background: transparent;
    padding: 6px 12px;
    border-radius: 6px;
    color: var(--theme-text-secondary);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    line-height: 1.2;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
}
.settings-segment:hover:not([aria-checked="true"]) { color: var(--theme-text-primary); }
.settings-segment:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--theme-border-focus);
}
.settings-segment[aria-checked="true"] {
    background: var(--theme-bg-accent);
    color: var(--theme-text-inverse, #ffffff);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}
```

(l) 文件末尾追加响应式收尾：

```css
@media (min-width: 769px) {
    /* Desktop close lives in the content header (AMC layout). */
    .settings-sidebar-header { display: none; }
}

@media (max-width: 768px) {
    .settings-content-header { display: none; }
    .settings-panels { padding-top: 20px; }
    .settings-segmented { width: 100%; justify-content: center; }
}
```

- [ ] **Step 3: HTML 改造**（`index.html`）

(a) 内容头插入——OLD：
```html
                <main class="settings-main">
                    <div class="settings-panels">
```
NEW：
```html
                <main class="settings-main">
                    <div class="settings-content-header">
                        <h2 id="settings-content-title" class="settings-content-title" data-i18n="settings.tabs.general">常规设置</h2>
                        <button type="button" id="settings-close-btn" class="settings-content-close" data-i18n-aria-label="modal.close" aria-label="关闭设置">
                            <span class="material-symbols-rounded" aria-hidden="true">close</span>
                        </button>
                    </div>
                    <div class="settings-panels">
```

(b) 八处 heading 移入其后卡片（每处删除 kicker 与行内 margin；无 title 者将 kicker 转为 title）。统一模式示例（general 组）——OLD：
```html
                            <div class="settings-section-heading">
                                <div class="settings-section-kicker" data-i18n="settings.sectionInterface">Interface</div>
                                <div class="panel-header-title" data-i18n="settings.tabs.general">常规设置</div>
                            </div>
                            <div class="settings-card">
```
NEW：
```html
                            <div class="settings-card">
                                <div class="settings-section-heading">
                                    <div class="panel-header-title" data-i18n="settings.tabs.general">常规设置</div>
                                </div>
```

按同模式处理其余七处（OLD 的 heading 行 → NEW 卡内标题行）：

| 位置 | 原 heading 特征 | 移入的卡片 |
|---|---|---|
| general 第二组 L573 | `style="margin-top: 10px;"` + 仅 kicker(`settings.sectionGeneration`) | 其后 `<div class="settings-card">`（form-grid 组）；title 用 `<div class="panel-header-title" data-i18n="settings.sectionGeneration">Generation</div>` |
| api L606 | `api-settings-heading`，含右侧 `#settings-save-status` 胶囊 | `<div class="settings-card api-settings-card">`；NEW 为卡头 flex 行＝title(`settings.tabs.api`)+胶囊整块照搬 |
| bridge L645 | title=`settings.tabs.bridge` | `<div class="settings-card" id="settings-bridge-hero" data-state="unknown">` |
| preferences L756 | `style="margin-top: 18px;"` + title=`settings.sectionPreferencesTitle` | 其后 `<div class="settings-card">` |
| help L805 | `style="margin-top: 18px;"` + title=`settings.sectionHelpTitle` | 其后 `<div class="settings-card">` |
| system L842 | title=`settings.tabs.maintenance` | `<div class="settings-card history-transfer-card">` |
| shortcuts L900 | 含右侧 `<span class="shortcuts-settings-count" aria-live="polite"></span>` | `<div class="settings-card shortcuts-settings-card">` |

注意：bridge/preferences/help 三处的 OLD 里 heading 与卡片之间有空行，old_string 需含该空行；shortcuts/api 的胶囊与计数 span 原样保留在移动后的 heading 内。

(c) 主题下拉替换——OLD：
```html
                                    <select id="theme-select">
                                        <option value="light" data-i18n="settings.themeLight">浅色</option>
                                        <option value="dark" data-i18n="settings.themeDark">深色</option>
                                        <option value="graphite" data-i18n="settings.themeGraphite">中性灰</option>
                                        <option value="auto" data-i18n="settings.themeAuto">跟随系统</option>
                                    </select>
```
NEW：
```html
                                    <div class="settings-segmented" id="theme-segmented" role="radiogroup" data-settings-key="theme" aria-label="主题">
                                        <button type="button" class="settings-segment" role="radio" aria-checked="true" data-value="light" data-i18n="settings.themeLight">浅色</button>
                                        <button type="button" class="settings-segment" role="radio" aria-checked="false" data-value="dark" data-i18n="settings.themeDark">深色</button>
                                        <button type="button" class="settings-segment" role="radio" aria-checked="false" data-value="graphite" data-i18n="settings.themeGraphite">中性灰</button>
                                        <button type="button" class="settings-segment" role="radio" aria-checked="false" data-value="auto" data-i18n="settings.themeAuto">跟随系统</button>
                                    </div>
```
同时该 field-row 的 `<label for="theme-select">` 改为 `<label>`（无 for 目标）。

(d) 语言下拉替换——OLD：
```html
                                    <select id="language-select">
                                        <option value="zh">中文</option>
                                        <option value="en">English</option>
                                        <option value="auto" data-i18n="settings.languageAuto">跟随系统</option>
                                    </select>
```
NEW：
```html
                                    <div class="settings-segmented" id="language-segmented" role="radiogroup" data-settings-key="language" aria-label="语言">
                                        <button type="button" class="settings-segment" role="radio" aria-checked="true" data-value="zh">中文</button>
                                        <button type="button" class="settings-segment" role="radio" aria-checked="false" data-value="en">English</button>
                                        <button type="button" class="settings-segment" role="radio" aria-checked="false" data-value="auto" data-i18n="settings.languageAuto">跟随系统</button>
                                    </div>
```
同样把 `<label for="language-select">` 改为 `<label>`。

- [ ] **Step 4: JS 接线**

(a) `settings-modal.js` 导入区（L7 之后）加：
```js
import { initSegmentedGroups, getSegmentedValue, setSegmentedValue } from './settings-segmented.js?v=1';
```

(b) L82 后（`closeBtn.addEventListener('click', closeSettingsModal);` 附近，L176 处）加：
```js
    const contentCloseBtn = document.getElementById('settings-close-btn');
    if (contentCloseBtn) contentCloseBtn.addEventListener('click', closeSettingsModal);
```

(c) `switchTab` 内 panels.forEach 之后、`safeSetLocalStorageItem` 之前加：
```js
        const activeTabBtn = Array.from(tabs).find(tab => tab.getAttribute('data-tab') === activeTabId);
        const contentTitle = document.getElementById('settings-content-title');
        if (contentTitle && activeTabBtn) {
            contentTitle.textContent = activeTabBtn.querySelector('span')?.textContent?.trim() || activeTabId;
        }
```

(d) `autoSaveInputs` 数组删除 `'theme-select',` 一行。

(e) 语言绑定块（L389–397 注释+langSelect）整体替换为：
```js
    // Segmented groups (AMC radiogroups). Language stays client-only — it
    // never enters the backend payload; other keys flow through autosave.
    initSegmentedGroups({
        onChange: ({ key }) => {
            if (key === 'language') {
                const lang = getSegmentedValue('language');
                if (lang && lang !== getLanguage()) {
                    setLanguage(lang);
                    if (typeof onLanguageChanged === 'function') onLanguageChanged();
                }
                return;
            }
            requestSettingsAutoSave();
        },
    });
```

(f) `fillSettingsForm` 前两行：
```js
        document.getElementById('theme-select').value = settings.theme || 'light';
        const langSel = document.getElementById('language-select');
        if (langSel) langSel.value = getLanguage();
```
→
```js
        setSegmentedValue('theme', settings.theme || 'light', { silent: true });
        setSegmentedValue('language', getLanguage(), { silent: true });
```

(g) `collectSettingsForm` 的 `theme: document.getElementById('theme-select').value,` → `theme: getSegmentedValue('theme') || 'light',`

(h) `sidebar.js` 主题同步块：
```js
                const themeSelect = document.getElementById('theme-select');
                if (themeSelect) {
                    themeSelect.value = newTheme;
                }
```
→
```js
                const { setSegmentedValue } = await import('./settings-segmented.js?v=1');
                setSegmentedValue('theme', newTheme, { silent: true });
```

- [ ] **Step 5: 全量回归绿**

Run: `cd /Volumes/WD_BLACK/Code/JustSearch && npm run test:frontend 2>&1 | tail -12`
Expected: 两组新 parity 测试 PASS；Task 1 的 3 个用例 PASS；既有 settings-search/shortcuts/composer 等用例 PASS；总失败数仍为 1（已知遗留）。若 settings-modal 相关用例因 `theme-select` 缺失而挂，检查是否遗漏 (d)/(f)/(g) 任一步。

- [ ] **Step 6: 提交**

```bash
cd /Volumes/WD_BLACK/Code/JustSearch && git add backend/static/css/sections/input-modal.css backend/static/index.html backend/static/js/modules/settings-modal.js backend/static/js/modules/sidebar.js tests/frontend/p1-amc-parity.test.mjs && git commit --no-verify -m "feat: align settings surface fully with AMC (cards, nav tint, header bar, segmented controls)"
```

---

### Task 3: 构建、部署与线上校验

- [ ] **Step 1: 本地构建** `npm run build 2>&1 | tail -4`，Expected exit 0。
- [ ] **Step 2: 部署** `export PATH="/usr/local/bin:$PATH" && cd /Volumes/WD_BLACK/Code/JustSearch && docker compose up -d --build`（后台跑并收集）。
- [ ] **Step 3: 校验** healthy + HTTP 200；首页含 `settings-content-header`/`theme-segmented` 且不含 `settings-section-kicker`/`theme-select`；CSS 版本参数变化且含 `.settings-card` 12px、`.settings-segment[aria-checked="true"]` accent 规则；chunk 含 `initSegmentedGroups` 标记（ASCII 可直接 grep）。
- [ ] **Step 4: 中文汇报**：改动对照、commit 列表、测试结果（含已知遗留说明）、线上证据、刷新查看指引。
