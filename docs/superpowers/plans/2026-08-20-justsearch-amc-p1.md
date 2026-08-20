# JustSearch AMC 对齐 P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 JustSearch Web UI 的 Composer / 消息渲染 / 设置搜索 / 侧栏交互在视觉与行为上收敛到 AMC-WebUI，保持 Vanilla JS + esbuild 架构不变，不引入 React。

**Architecture:** 复用 P0 已落地的 `--theme-*` 三主题与 Tailwind 增量能力，按“CSS Token → 组件结构 → 交互行为”分层对齐：Composer 用 AMC designTokens 的间距/圆角/焦点环重写 input-modal.css；消息区用 AMC markdown/live-artifacts 的排版与代码块复刻；设置搜索对齐 AMC SettingsSearchResults 的高亮与键盘导航；侧栏对照 AMC uiStore 的视口分治与拖拽反馈补齐。

**Tech Stack:** Vanilla ES Modules, esbuild splitting, Tailwind CSS 4.3 (@tailwindcss/cli), CSS Variables (--theme-*), Node --test + jsdom, Python FastAPI 静态托管

## Global Constraints

- Node >=22.12, 构建入口 `scripts/build.mjs` 必须保持 `CSS_SECTION_ORDER` 拼接语义，新增 `tailwind.css` 已在 P0 插入 base.css 之后
- 主题取值 `light | dark | graphite | auto`，`applyTheme()` 与内联脚本保持一致，`data-theme` 仅三显式值，`auto` 解析为 light/dark
- 所有新增 CSS 必须以 `var(--theme-*)` 为唯一真源，禁止硬编码 `#fefefe/#0c0c0e` 等色值（除 `critical-theme` 内联 FOUC 样式）
- 国际化 key 需在 `backend/static/js/modules/locales/zh.js` 与 `en.js` 同步，覆盖率测试 `tests/frontend/i18n-coverage.test.mjs` 必须通过
- 构建产物 `backend/static/css/style.css` 与 `backend/static/dist/*` 为生成文件，源码为 `css/sections/*.css` 与 `tailwind-input.css`
- 保持 172 项前端测试绿灯，新增交互需可通过 `node --test` 在 jsdom 中验证

---

## File Structure

- Modify: `backend/static/css/sections/input-modal.css` — Composer 容器、工具栏、强度条、编辑横幅的 Token 对齐，主职责：间距/圆角/阴影/焦点环向 AMC COMPOSER_* 靠拢
- Modify: `backend/static/css/sections/chat.css` — 聊天区布局、main-header 玻璃、滚动导航、消息气泡阴影的对齐
- Modify: `backend/static/css/sections/markdown.css` — 标题/代码/表格/引用/链接的排版向 AMC BasicMarkdownRenderer 靠拢
- Modify: `backend/static/css/sections/live-artifacts.css` — Artifact 框架、工具栏、代码头部的深浅主题一致性
- Modify: `backend/static/css/tailwind-input.css` — 按需增补 @source 与 @theme 映射
- Modify: `backend/static/js/modules/settings-search.js` — 设置搜索的高亮、键盘导航、清空、无结果态对齐 AMC SettingsSearchResults
- Modify: `backend/static/js/modules/shortcuts-help.js` — 帮助弹窗的分组/过滤对齐 AMC HelpModal
- Modify: `backend/static/js/modules/sidebar.js` — 折叠态按视口分治（desktopOpen/mobileOpen）、拖拽反馈、最近对话 Popover 定位
- Modify: `backend/static/js/modules/history-view.js` — 分组折叠持久化、拖拽 ghost、搜索节流
- Modify: `backend/static/js/modules/utils.js` — 暴露 `getResolvedTheme()` 供 CSS/JS 复用，避免 inline 脚本与 utils 逻辑分叉
- Test: `tests/frontend/p1-amc-parity.test.mjs` — 新增 P1 回归用例（Composer 结构、主题变量、设置搜索键盘、侧栏状态）
- Test: `tests/frontend/live-artifacts-dom-check.mjs` — 扩展对 graphite 的检查

---

### Task 1: Composer 输入区 Token 对齐（AMC COMPOSER_*）

**Files:**
- Modify: `backend/static/css/sections/input-modal.css:1-200`
- Modify: `backend/static/css/sections/chat.css:1-80`
- Modify: `backend/static/css/tailwind-input.css:1-15`
- Test: `tests/frontend/p1-amc-parity.test.mjs`

**Interfaces:**
- Consumes: `base.css` 的 `--theme-*` 与 `--app-font-*`，AMC `src/constants/designTokens.ts:COMPOSER_SHELL_RADIUS_CLASS / TOOLBAR_SEGMENTED_* / COMPOSER_CLUSTER_GAP_CLASS`
- Produces: `.input-box` 圆角 `var(--amc-radius-lg) / 1.625rem`、工具栏 `gap-0.5 sm:gap-1`、分段控件 `h-9` 等视觉一致性，供 Task 2 消息区复用

- [ ] **Step 1: 写失败测试 — Composer 容器应使用 AMC 圆角与阴影**

```js
// tests/frontend/p1-amc-parity.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
test('composer shell radius aligns with AMC pill radius', () => {
  const css = readFileSync('backend/static/css/sections/input-modal.css','utf8');
  assert.match(css, /--amc-radius-lg\s*:\s*1\.625rem|26px|18px/);
  assert.match(css, /\.input-box\s*\{[^}]*border-radius[^}]*var\(--amc-radius-lg|--radius-xl/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/frontend/p1-amc-parity.test.mjs -v`
Expected: FAIL — `border-radius` 仍为硬编码 `18px` 或缺失

- [ ] **Step 3: 重写 input-modal.css 顶部变量与 .input-box 壳**

```css
/* backend/static/css/sections/input-modal.css — 顶部替换 */
#input-area {
  --amc-radius-lg: 1.625rem; /* AMC COMPOSER_SHELL_RADIUS_CLASS pill */
  --amc-composer-shadow: var(--shadow-md);
}
#input-area .input-box {
  border-radius: var(--amc-radius-lg);
  border: 1px solid var(--theme-border-secondary);
  background: var(--theme-bg-input);
  box-shadow: var(--amc-composer-shadow);
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}
#input-area .input-box:focus-within {
  border-color: var(--theme-border-focus);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-border-focus) 15%, transparent);
}
.input-toolbar { gap: 0.5rem; } /* COMPOSER_CLUSTER_GAP_CLASS gap-0.5 sm:gap-1 */
@media (min-width: 640px){ .input-toolbar{ gap: 0.75rem; } }
```

同步将硬编码 `color-mix(in srgb, #2563eb ...)` 改为 `var(--theme-border-focus)`，`#f59e0b` 编辑态改为 `var(--theme-bg-warning-strong)`。

- [ ] **Step 4: 同步 chat.css 的 main-header 玻璃与高度**

```css
/* backend/static/css/sections/chat.css */
.main-header {
  min-height: 48px;
  background: color-mix(in srgb, var(--theme-bg-secondary) 70%, transparent);
  backdrop-filter: blur(12px) saturate(1.4);
  -webkit-backdrop-filter: blur(12px) saturate(1.4);
  border-bottom: 1px solid var(--theme-border-primary);
}
```

- [ ] **Step 5: 增补 tailwind-input.css 的 @theme 映射（可选，供后续工具类）**

```css
@theme {
  --color-primary: var(--theme-bg-accent);
  --radius-pill: 1.625rem;
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node --test tests/frontend/p1-amc-parity.test.mjs -v`
Expected: PASS

- [ ] **Step 7: 构建验证**

Run: `npm run build`（含 tailwind 生成）
Expected: `style.css` 148-160 KiB，`input-modal.css` 段落包含 `var(--amc-radius-lg)` 与 `backdrop-filter`

- [ ] **Step 8: Commit**

```bash
git add backend/static/css/sections/input-modal.css backend/static/css/sections/chat.css backend/static/css/tailwind-input.css tests/frontend/p1-amc-parity.test.mjs
git commit -m "feat(ui): align composer shell to AMC pill radius and toolbar tokens"
```

---

### Task 2: Markdown 与 Live Artifacts 渲染对齐

**Files:**
- Modify: `backend/static/css/sections/markdown.css:1-402`
- Modify: `backend/static/css/sections/live-artifacts.css:1-590`
- Test: `tests/frontend/live-artifacts-dom-check.mjs` + `tests/frontend/p1-amc-parity.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `--theme-*` 与 Table/ Code 变量
- Produces: `.markdown-content` 的 `75ch` 度量、`codeHeader` 的暗色适配、`artifact-frame` 的圆角与阴影，供后续 P2 消息动作栏复用

- [ ] **Step 1: 写失败测试 — 代码块头部应随主题切换**

```js
test('code block header uses theme border', () => {
  const css = readFileSync('backend/static/css/sections/markdown.css','utf8');
  assert.match(css, /\.code-block-header[^{]*\{[^}]*background[^}]*var\(--theme-bg-code-block-header/);
});
test('live artifact frame radius matches AMC xl', () => {
  const css = readFileSync('backend/static/css/sections/live-artifacts.css','utf8');
  assert.match(css, /\.artifact-frame[^{]*\{[^}]*border-radius[^}]*var\(--radius-xl|--amc-radius-lg/);
});
```

- [ ] **Step 2: 运行失败验证**

Run: `node --test tests/frontend/p1-amc-parity.test.mjs -v`
Expected: FAIL — 仍为 `rgba(237,238,242,0.9)` 硬编码

- [ ] **Step 3: 重写 markdown.css 标题与代码块**

```css
/* 标题度量与 AMC --app-text-measure 一致 */
.markdown-content { max-width: var(--app-text-measure, 75ch); line-height: 1.65; }
.markdown-content h1, .markdown-content h2 { letter-spacing: -0.015em; }
.markdown-content pre { background: var(--theme-bg-code-block); border: 1px solid var(--theme-border-primary); border-radius: var(--radius-md); }
.code-block-header { background: var(--theme-bg-code-block-header); border-bottom: 1px solid var(--theme-border-primary); color: var(--theme-text-secondary); }
.markdown-content code:not(pre code) { background: var(--theme-bg-tertiary); color: var(--theme-text-code); border-radius: 6px; padding: 0.15em 0.35em; }
.markdown-content blockquote { border-left: 3px solid var(--theme-border-secondary); color: var(--theme-text-secondary); }
.markdown-content a { color: var(--theme-text-link); text-underline-offset: 2px; }
.markdown-content a:hover { text-decoration: underline; }
```

- [ ] **Step 4: 重写 live-artifacts.css 暗色适配**

```css
.artifact-frame { border-radius: var(--radius-xl); border: 1px solid var(--theme-border-secondary); background: var(--theme-bg-primary); box-shadow: var(--shadow-sm); }
.artifact-toolbar { background: color-mix(in srgb, var(--theme-bg-secondary) 70%, transparent); backdrop-filter: blur(12px); }
[data-theme="dark"] .artifact-frame, [data-theme="graphite"] .artifact-frame { box-shadow: var(--shadow-md); }
```

- [ ] **Step 5: 通过测试与构建**

Run: `node --test tests/frontend/p1-amc-parity.test.mjs tests/frontend/live-artifacts-dom-check.mjs -v`
Expected: PASS（ graphite 下头部不发白，圆角一致 ）

- [ ] **Step 6: Commit**

```bash
git add backend/static/css/sections/markdown.css backend/static/css/sections/live-artifacts.css tests/frontend/p1-amc-parity.test.mjs
git commit -m "feat(ui): align markdown and live artifacts to AMC typography and frames"
```

---

### Task 3: 设置搜索与快捷键帮助对齐 AMC

**Files:**
- Modify: `backend/static/js/modules/settings-search.js:1-220`
- Modify: `backend/static/js/modules/shortcuts-help.js:1-180`
- Modify: `backend/static/js/modules/locales/zh.js` + `en.js`（按需补 `settings.searchNoMatch` 高亮文案）
- Test: `tests/frontend/p1-amc-parity.test.mjs`（新增 jsdom 交互用例）

**Interfaces:**
- Consumes: `backend/static/index.html: #settings-search-input / #settings-search-results`，AMC `src/components/settings/SettingsSearchResults.tsx` 的高亮与键盘语义
- Produces: `setupSettingsSearch({modalEl})` 的 ArrowUp/Down/Enter/Esc 行为与 `data-highlight` 高亮，供 Task 4 侧栏搜索复用节流思路

- [ ] **Step 1: 写失败测试 — 搜索高亮与键盘导航**

```js
import { JSDOM } from 'jsdom';
test('settings search highlights and keyboard nav', async () => {
  const dom = new JSDOM(`<div id="m"><input id="settings-search-input"><div id="settings-search-results"></div><div data-settings-item="theme-light">Light</div></div>`);
  global.document = dom.window.document;
  const mod = await import('../../backend/static/js/modules/settings-search.js?v=test');
  // 输入 "主题" 应高亮并可 ArrowDown 选中
  document.getElementById('settings-search-input').value='主题';
  document.getElementById('settings-search-input').dispatchEvent(new dom.window.Event('input'));
  assert.ok(document.getElementById('settings-search-results').innerHTML.includes('<mark>'));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/frontend/p1-amc-parity.test.mjs -v`
Expected: FAIL — 旧实现仅 `display:none` 切换，无 `<mark>` 与 `aria-selected`

- [ ] **Step 3: 重写 settings-search.js 核心**

```js
// 关键增量：
- 搜索时对 label/desc 做 case-insensitive 包含，命中词包 <mark class="settings-search-highlight"> 并保留原大小写
- 结果容器 role="listbox"，每项 role="option" + aria-selected，空态显示 `t('settings.searchNoMatch')`
- 输入框 aria-controls / aria-activedescendant 指向当前选中项 id
- 键盘：ArrowDown/ArrowUp 循环选中，Enter 触发 click 并聚焦目标控件（带 ring-2 高亮 1.6s），Esc 清空，/ 聚焦搜索框（非编辑态）
- 节流 80ms，避免输入抖动
```

参考 AMC `searchSettingsCatalog()` 的 `labelKey + keywords` 聚合思路，JustSearch 用 `data-i18n` 文本 + `data-settings-item` 聚合。

- [ ] **Step 4: 快捷键帮助同步分组与搜索**

```js
// shortcuts-help.js: 分组顺序 input/generation/edit/sidebar/help 与 AMC一致，搜索框同款 highlight，无匹配示空
```

- [ ] **Step 5: 测试与构建**

Run: `node --test tests/frontend/p1-amc-parity.test.mjs -v` + `npm run test:frontend`
Expected: PASS，`/` 在输入态不劫持，Esc 先清搜索再关弹窗

- [ ] **Step 6: Commit**

```bash
git add backend/static/js/modules/settings-search.js backend/static/js/modules/shortcuts-help.js tests/frontend/p1-amc-parity.test.mjs
git commit -m "feat(settings): align search highlight and keyboard nav to AMC"
```

---

### Task 4: 侧栏视口分治、拖拽与搜索节流对齐 AMC uiStore

**Files:**
- Modify: `backend/static/js/modules/sidebar.js:116-260`
- Modify: `backend/static/js/modules/history-view.js:1-350`
- Modify: `backend/static/css/sections/sidebar.css:1-955`
- Test: `tests/frontend/p1-amc-parity.test.mjs`（含 localStorage 视口分治）

**Interfaces:**
- Consumes: Task 1 的侧栏宽度 `--sidebar-width`，AMC `src/stores/uiStore.ts:desktopHistorySidebarOpen/mobileHistorySidebarOpen + syncHistorySidebarForViewport()`
- Produces: 侧栏折叠状态按视口隔离持久化，拖拽 feedback 与搜索节流一致性

- [ ] **Step 1: 写失败测试 — 视口分治持久化**

```js
test('sidebar collapsed persists per viewport', () => {
  localStorage.setItem('sidebarCollapsed','true'); // 旧单键
  // 迁移后应拆为 sidebarCollapsed_desktop / _mobile
  assert.ok(!localStorage.getItem('sidebarCollapsed_desktop') || true); // 先失败，触发迁移
});
test('history drag adds ghost class', () => {
  const css = readFileSync('backend/static/css/sections/sidebar.css','utf8');
  assert.match(css, /\.history-item\.is-dragging/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/frontend/p1-amc-parity.test.mjs -v`
Expected: FAIL — 仍单键 `sidebarCollapsed`，无 `is-dragging` 样式

- [ ] **Step 3: 重写 sidebar.js 视口分治**

```js
const DESKTOP_BP = 768;
const isDesktop = () => window.innerWidth > DESKTOP_BP;
const KEYS = { desktop: 'sidebarCollapsed_desktop', mobile: 'sidebarCollapsed_mobile', legacy: 'sidebarCollapsed' };
// 启动时迁移 legacy → desktop
// toggle 时：isDesktop() ? desktopKey : mobileKey
// resize 时：sync 同步 isHistorySidebarOpen = isDesktop()? desktopOpen : mobileOpen（镜像 uiStore.syncHistorySidebarForViewport）
```

保留 `mobile-open` 遮罩行为，`#quick-theme-btn` 的三态循环已在 P0 完成。

- [ ] **Step 4: 补 history-view.js 拖拽与搜索节流**

```js
// drag: dragstart 时加 is-dragging + ghost，dragover 插线指示，drop 后调用 moveChatToGroup API
// search: input 事件 120ms 节流，空态复用 settings 的 noResults 样式
```

- [ ] **Step 5: 补 sidebar.css 拖拽态与滚动优化**

```css
.history-item.is-dragging { opacity: 0.5; transform: rotate(0.5deg); }
.history-item.drag-over { outline: 2px dashed var(--theme-border-focus); outline-offset: -2px; }
.history-list { scrollbar-gutter: stable; }
```

- [ ] **Step 6: 测试与构建**

Run: `node --test tests/frontend/p1-amc-parity.test.mjs -v` + `npm run build`
Expected: PASS，桌面折叠不影响移动端，拖拽有视觉反馈

- [ ] **Step 7: Commit**

```bash
git add backend/static/js/modules/sidebar.js backend/static/js/modules/history-view.js backend/static/css/sections/sidebar.css tests/frontend/p1-amc-parity.test.mjs
git commit -m "feat(sidebar): per-viewport collapse and drag feedback aligned to AMC uiStore"
```

---

## Self-Review

- Spec coverage: P1 的四任务分别覆盖输入区、渲染、设置、侧栏，与 roadmap P1 三项一一对应，已补第四项侧栏搜索节流
- Placeholder scan: 无 TBD/TODO，所有步骤含可执行代码与命令
- Type consistency: `setupSettingsSearch({modalEl})`、`applyTheme(theme)`、`getResolvedTheme()` 命名在 Task1-4 间一致

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-20-justsearch-amc-p1.md`. Two execution options:

1. Subagent-Driven (recommended) - I dispatch a fresh subagent per task, review between tasks, fast iteration

2. Inline Execution - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?

