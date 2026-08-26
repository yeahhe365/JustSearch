# 设置界面第二轮复刻补齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans（当前会话内执行）。步骤用 `- [ ]` 勾选。

**Goal:** 按 spec 附录 A1–A8 补齐设置界面与 AMC 的剩余差距（自定义下拉、滚动内容头、行分隔线、Toggle/滑杆配色、导航分组、细滚动条、搜索结果面板）。

**Architecture:** 下拉采用渐进增强（原生 select 留在 DOM，change 事件照常触发，现有 JS 绑定零改动）；其余为 CSS/HTML 结构微调。

## Global Constraints

- 同主 spec 全局约束：只动列出的文件；禁 `git add -A`；已知遗留失败不计入；生成物不入 commit。
- 允许文件：`input-modal.css`、`index.html`、新建 `settings-dropdown.js`、`settings-modal.js`（仅 fillSettingsForm 加 sync 调用）、`tests/frontend/p1-amc-parity.test.mjs`、新建 `tests/frontend/settings-dropdown.test.mjs`。

---

### Task A: 自定义下拉模块（TDD）

- [ ] Step 1 新建 `tests/frontend/settings-dropdown.test.mjs`：

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
    <select id="engine-select" class="settings-select">
        <option value="google" selected>Google</option>
        <option value="bing">Bing</option>
    </select>
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
    return pathToFileURL(path.join(root, 'backend/static/js/modules/settings-dropdown.js')).href + `?t=${Date.now()}`;
}

test('dropdown upgrades select: trigger label, option pick fires change', async () => {
    install();
    let changed = [];
    const sel = document.getElementById('engine-select');
    sel.addEventListener('change', () => changed.push(sel.value));
    const { initSettingsDropdowns } = await import(moduleUrl());
    initSettingsDropdowns(document);
    const trigger = document.querySelector('.settings-dd-trigger');
    assert.ok(trigger, 'trigger rendered');
    assert.equal(trigger.querySelector('.settings-dd-label').textContent, 'Google');
    assert.equal(getComputedStyle(sel).display, 'none', 'native select hidden');
    trigger.click();
    assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'panel opens');
    const opt = document.querySelector('.settings-dd-option[data-value="bing"]');
    opt.click();
    assert.equal(sel.value, 'bing', 'select value synced');
    assert.deepEqual(changed, ['bing'], 'change event fired once');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'panel closes after pick');
    assert.equal(trigger.querySelector('.settings-dd-label').textContent, 'Bing', 'label updated');
});

test('syncFromSelect picks up external value writes', async () => {
    install();
    const { initSettingsDropdowns, syncFromSelect } = await import(moduleUrl());
    initSettingsDropdowns(document);
    const sel = document.getElementById('engine-select');
    sel.value = 'bing';
    syncFromSelect(sel);
    assert.equal(document.querySelector('.settings-dd-label').textContent, 'Bing');
});
```

- [ ] Step 2 红：`node --test --test-force-exit tests/frontend/settings-dropdown.test.mjs` → ERR_MODULE_NOT_FOUND。

- [ ] Step 3 新建 `backend/static/js/modules/settings-dropdown.js`：

```js
// ===========================================================================
// Settings dropdown — AMC Select look as progressive enhancement over native
// <select class="settings-select">. The select stays in the DOM (hidden) so
// every existing change listener keeps working.
// ===========================================================================

const CHEVRON = '<svg class="settings-dd-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

function labelFor(select) {
    return select.options[select.selectedIndex]?.textContent ?? '';
}

export function syncFromSelect(select) {
    const wrap = select.closest('.settings-dd');
    if (!wrap) return;
    wrap.querySelector('.settings-dd-label').textContent = labelFor(select);
    wrap.querySelectorAll('.settings-dd-option').forEach((opt) => {
        const isSel = opt.dataset.value === String(select.value);
        opt.setAttribute('aria-selected', isSel ? 'true' : 'false');
        opt.classList.toggle('is-selected', isSel);
    });
}

export function initSettingsDropdowns(root = document) {
    root.querySelectorAll('select.settings-select').forEach((select) => {
        if (select.dataset.ddUpgraded) return;
        select.dataset.ddUpgraded = '1';

        const wrap = root.createElement('div');
        wrap.className = 'settings-dd';
        const trigger = root.createElement('button');
        trigger.type = 'button';
        trigger.className = 'settings-dd-trigger';
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.innerHTML = `<span class="settings-dd-label"></span>${CHEVRON}`;
        const panel = root.createElement('div');
        panel.className = 'settings-dd-panel';
        panel.setAttribute('role', 'listbox');

        Array.from(select.options).forEach((option) => {
            const opt = root.createElement('button');
            opt.type = 'button';
            opt.className = 'settings-dd-option';
            opt.setAttribute('role', 'option');
            opt.dataset.value = option.value;
            opt.textContent = option.textContent;
            opt.addEventListener('click', () => {
                if (String(select.value) !== option.value) {
                    select.value = option.value;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                }
                close();
            });
            panel.appendChild(opt);
        });

        function open() { panel.hidden = false; trigger.setAttribute('aria-expanded', 'true'); }
        function close() { panel.hidden = true; trigger.setAttribute('aria-expanded', 'false'); }
        trigger.addEventListener('click', () => (panel.hidden ? open() : close()));
        trigger.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { close(); e.stopPropagation(); }
        });
        root.addEventListener('click', (e) => {
            if (!wrap.contains(e.target)) close();
        });

        select.parentNode.insertBefore(wrap, select);
        wrap.appendChild(panel);
        wrap.appendChild(select); // keep select inside for closest('.settings-dd')
        select.classList.add('sr-only-native');
        syncFromSelect(select);
    });
}
```

- [ ] Step 4 绿 → 提交 `feat: settings custom dropdown module over native selects`（两文件）。

---

### Task B: 其余七项 + 接线

- [ ] Step 1 parity 追加断言（红）：

```js
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
  assert.match(css, /divide|border-top:\s*1px solid color-mix\(in srgb, var\(--theme-border-secondary\) 40%/, 'row dividers');
  assert.match(css, /--theme-scrollbar-thumb/, 'thin scrollbar token');
  const header = css.match(/\.settings-content-header\s*\{[^}]*\}/);
  assert.match(header[0], /max-width:\s*var\(--amc-content-width\)/, 'header scrolls with content column');
  const html = readFileSync('backend/static/index.html', 'utf8');
  assert.match(html, /data-settings-nav-group/, 'grouped nav');
  const sd = readFileSync('backend/static/js/modules/settings-dropdown.js', 'utf8');
  assert.match(sd, /initSettingsDropdowns/);
});
```

- [ ] Step 2 实现：
  - CSS：新增 `.settings-dd-*` 全套（trigger h-40 rounded-lg border-secondary bg-input hover:border-focus focus ring；面板 absolute top calc(100%+4px) w-full bg-secondary border-primary rounded-xl shadow p-4px z-50 max-h 300px overflow auto；选项块级 w-full text-left px-10px py-8px rounded-md hover tertiary/50、`.is-selected` accent/10）；内容头改 `padding:0 0 16px; max-width:var(--amc-content-width); margin:0 auto;` 且 HTML 中移入 `.settings-panels` 首子；卡内相邻行分隔线规则；ios-switch 配色/阴影/focus 替换；range 滑杆轨道+thumb 重写；滚动条 5px 规则；nav 分组间距 `.settings-tabs{gap:14px}`；搜索结果容器/行重样式（bg-secondary、rounded-xl、行 hover tertiary/50、tab 徽标大写）。
  - HTML：tabs 包三个 `[data-settings-nav-group]` 容器；`.settings-content-header` 移进 `.settings-panels` 首位；4 个 `<select>` 补 `class="settings-select"`。
  - JS：`settings-modal.js` 导入并在 setup 时调用 `initSettingsDropdowns(elements.settingsModal)`，`fillSettingsForm` 写 engine/poll 值后各调一次 `syncFromSelect`。
- [ ] Step 3 全量绿（除已知遗留）→ 提交 `feat: round-2 settings replica details (dropdowns, dividers, toggles, scrollbar)`。

---

### Task C: 构建 + 部署 + 校验 + 中文汇报

build → docker compose up -d --build（后台）→ healthy/200/CSS 版本变化含新规则/chunk 含 settings-dropdown → 汇报。
