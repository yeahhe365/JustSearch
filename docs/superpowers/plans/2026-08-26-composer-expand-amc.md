# Composer 展开功能 AMC 对齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 AMC 的 composer 展开交互（右上角角标、内联高度动画展开、顶边拖拽调高）完整移植到 JustSearch，vanilla JS 实现。

**Architecture:** 新增 `composer-expand.js` 模块承载状态机（expanded / manualHeight / animatedHeight），HTML 加角标/手柄/frame 结构，CSS 走 `--theme-*` token，`chat.js` 高度函数让位。AMC 数值（220px/50vh/40vh/260ms/±16px/pr-9）逐项照抄。

**Tech Stack:** Vanilla ES Modules、CSS Variables + color-mix、Node --test + jsdom、esbuild

## Global Constraints

- 源码唯一真源 `css/sections/*.css`；改后必须 `npm run build`
- i18n key 必须同步 zh.js 与 en.js（i18n 覆盖率测试会拦截）
- 提交仅限本计划列出的文件；禁止 `git add -A`
- 模块 import 带 `?v=N` 版本参数（既有约定，新模块用 `?v=1`）
- 完成后 Docker Compose 重新部署并验证线上产物（用户明确要求）

---

### Task 1: HTML 结构 + CSS 样式

**Files:**
- Modify: `backend/static/index.html`（`.input-box` 区块，约 line 280-284）
- Modify: `backend/static/css/sections/input-modal.css`（textarea padding + 文件内新增区块）

**Interfaces:**
- Produces: DOM 契约——`.input-box > #composer-resize-handle.composer-resize-handle[role=separator]`、`.composer-resize-handle-bar`、`.composer-expand-corner > .composer-expand-corner-line + button#expand-btn.composer-expand-btn(.icon-maximize/.icon-minimize)`、`.composer-editor-frame#composer-editor-frame` 包裹 `#user-input`。Task 2 的选择器依赖这些类名。

- [ ] **Step 1: 修改 index.html**

将：

```html
<textarea id="user-input" placeholder="提出问题..." rows="1" data-i18n-placeholder="inputArea.placeholder" data-i18n-aria-label="inputArea.messageInput" aria-label="消息输入" enterkeyhint="send" autofocus></textarea>
```

替换为（手柄与角标插在 slash menu 之后、frame 包住 textarea）：

```html
<div class="composer-resize-handle" id="composer-resize-handle" role="separator" aria-orientation="horizontal" tabindex="0" data-i18n-aria-label="inputArea.resizeHandle" aria-label="调整输入框高度">
    <div class="composer-resize-handle-bar"></div>
</div>
<div class="composer-expand-corner">
    <span class="composer-expand-corner-line" aria-hidden="true"></span>
    <button type="button" id="expand-btn" class="composer-expand-btn" aria-pressed="false" data-i18n-aria-label="inputArea.expand" data-i18n-title="inputArea.expand" aria-label="展开输入框" title="展开输入框">
        <svg class="icon-maximize" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
        <svg class="icon-minimize" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
    </button>
</div>
<div id="composer-editor-frame" class="composer-editor-frame">
    <textarea id="user-input" placeholder="提出问题..." rows="1" data-i18n-placeholder="inputArea.placeholder" data-i18n-aria-label="inputArea.messageInput" aria-label="消息输入" enterkeyhint="send" autofocus></textarea>
</div>
```

- [ ] **Step 2: input-modal.css — textarea 右侧避让**

```css
/* old */
    padding: 2px 4px 0 4px;
/* new（AMC px-1 pr-9 pt-0.5 pb-0） */
    padding: 2px 36px 0 4px;
```

- [ ] **Step 3: input-modal.css — 在 `#user-input::placeholder` 规则之后追加**

```css
/* --- AMC composer expand corner + top resize handle --- */
.composer-editor-frame {
    position: relative;
    min-width: 0;
    overflow: hidden;
}

.composer-resize-handle {
    position: absolute;
    top: 0;
    right: 16px;
    left: 16px;
    z-index: 30;
    height: 8px;
    border-radius: 9999px;
    cursor: row-resize;
}

.composer-resize-handle:focus-visible {
    outline: none;
    background: color-mix(in srgb, var(--amc-accent) 40%, transparent);
}

.composer-resize-handle-bar {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    height: 2px;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--amc-accent) 20%, transparent);
    opacity: 0;
    transition: opacity 0.2s ease-out, background-color 0.2s ease-out;
}

.composer-resize-handle:hover .composer-resize-handle-bar,
.composer-resize-handle:focus-visible .composer-resize-handle-bar {
    opacity: 1;
}

.composer-resize-handle[data-resizing] .composer-resize-handle-bar {
    opacity: 1;
    background: color-mix(in srgb, var(--amc-accent) 35%, transparent);
}

.composer-expand-corner {
    position: absolute;
    top: 1px;
    right: 1px;
    z-index: 10;
    width: 32px;
    height: 32px;
}

.composer-expand-corner-line {
    pointer-events: none;
    position: absolute;
    top: 4px;
    right: 4px;
    width: 12px;
    height: 12px;
    border-top: 1.5px solid color-mix(in srgb, var(--amc-text-primary) 60%, transparent);
    border-right: 1.5px solid color-mix(in srgb, var(--amc-text-primary) 60%, transparent);
    border-top-right-radius: 16px;
    opacity: 0.7;
    transform-origin: top right;
    transition: opacity 0.2s ease-out, scale 0.2s ease-out;
}

.composer-expand-corner:hover .composer-expand-corner-line,
.composer-expand-corner:focus-within .composer-expand-corner-line {
    scale: 0.5;
    opacity: 0;
}

.composer-expand-btn {
    pointer-events: none;
    position: absolute;
    top: 4px;
    right: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: none;
    border-radius: 9999px;
    background: transparent;
    color: var(--amc-text-tertiary);
    cursor: pointer;
    opacity: 0;
    transform: translate(10px, -10px) rotate(-8deg) scale(0.8);
    transition: opacity 0.3s ease-out, translate 0.3s ease-out, scale 0.3s ease-out, rotate 0.3s ease-out, color 0.3s ease-out, background-color 0.3s ease-out;
    outline: none;
}

.composer-expand-corner:hover .composer-expand-btn,
.composer-expand-corner:focus-within .composer-expand-btn,
.composer-expand-btn:focus-visible {
    pointer-events: auto;
    opacity: 1;
    transform: translate(0, 0) rotate(0deg) scale(1);
    background: color-mix(in srgb, var(--amc-btn-hover) 80%, transparent);
    color: var(--amc-text-primary);
}

.composer-expand-btn svg {
    width: 12px;
    height: 12px;
    display: block;
}

.composer-expand-btn .icon-minimize {
    display: none;
}

.input-box.expanded .composer-expand-btn .icon-maximize {
    display: none;
}

.input-box.expanded .composer-expand-btn .icon-minimize {
    display: block;
}
```

- [ ] **Step 4: 构建验证无语法错误**

Run: `npm run build`
Expected: 成功，无 CSS 报错

- [ ] **Step 5: Commit**

```bash
git add backend/static/index.html backend/static/css/sections/input-modal.css
git commit --no-verify -m "feat(composer): add expand corner & resize handle structure/styles (AMC)"
```

---

### Task 2: composer-expand.js 状态机 + chat.js 联动 + i18n

**Files:**
- Create: `backend/static/js/modules/composer-expand.js`
- Modify: `backend/static/js/modules/chat.js`（import 区、setup 区约 line 1266 后、autoResizeInput/resetInputHeight 约 line 1022-1032）
- Modify: `backend/static/js/modules/locales/zh.js`、`en.js`（inputArea 区块）
- Test: `tests/frontend/composer-expand.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 DOM 契约；i18n `t(key)`
- Produces: `setupComposerExpand({ inputBoxEl, textareaEl }) -> { toggle, isExpanded, hasCustomHeight } | null`；`isComposerCustomHeight(textareaEl) -> boolean`（chat.js 用）

- [ ] **Step 1: 写失败测试** `tests/frontend/composer-expand.test.mjs`

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const dom = () => {
  const d = new JSDOM(`<!doctype html><html><body>
    <div class="input-box">
      <div class="composer-resize-handle" role="separator" tabindex="0"><div class="composer-resize-handle-bar"></div></div>
      <div class="composer-expand-corner">
        <span class="composer-expand-corner-line"></span>
        <button type="button" class="composer-expand-btn" aria-pressed="false"></button>
      </div>
      <div class="composer-editor-frame"><textarea id="user-input" style="min-height:26px"></textarea></div>
      <div class="input-toolbar"></div>
    </div></body></html>`, { url: 'http://localhost/' });
  globalThis.window = d.window;
  globalThis.document = d.window.document;
  if (!d.window.requestAnimationFrame) d.window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
  if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = d.window.requestAnimationFrame.bind(d.window);
  return d;
};

const moduleUrl = () => pathToFileURL(path.resolve('backend/static/js/modules/composer-expand.js')).href + `?t=${Math.random()}`;

test('expand toggle: corner click expands inline and collapses back', async () => {
  const d = dom();
  const { setupComposerExpand } = await import(moduleUrl());
  const box = document.querySelector('.input-box');
  const textarea = document.getElementById('user-input');
  const api = setupComposerExpand({ inputBoxEl: box, textareaEl: textarea });
  assert.ok(api);
  box.querySelector('.composer-expand-btn').click();
  assert.equal(box.classList.contains('expanded'), true);
  assert.equal(box.querySelector('.composer-expand-btn').getAttribute('aria-pressed'), 'true');
  assert.equal(textarea.dataset.customHeight, 'true');
  assert.match(box.querySelector('.composer-editor-frame').style.height, /max\(220px, ?50vh\)/);
  api.toggle();
  assert.equal(box.classList.contains('expanded'), false);
  assert.equal(textarea.dataset.customHeight, 'false');
});

test('resize keyboard: ArrowUp raises manual height by 16 from min', async () => {
  dom();
  const { setupComposerExpand } = await import(moduleUrl());
  const box = document.querySelector('.input-box');
  const handle = box.querySelector('.composer-resize-handle');
  setupComposerExpand({ inputBoxEl: box, textareaEl: document.getElementById('user-input') });
  handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  assert.equal(box.classList.contains('expanded'), false);
  assert.match(box.querySelector('.composer-editor-frame').style.height, /42px/); // 26 + 16
  handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
  assert.match(box.querySelector('.composer-editor-frame').style.height, /26px/);
});

test('mouse drag on handle sets clamped manual height', async () => {
  dom();
  const { setupComposerExpand } = await import(moduleUrl());
  const box = document.querySelector('.input-box');
  const handle = box.querySelector('.composer-resize-handle');
  setupComposerExpand({ inputBoxEl: box, textareaEl: document.getElementById('user-input') });
  handle.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientY: 200 }));
  document.dispatchEvent(new window.MouseEvent('mousemove', { clientY: 158 })); // +42 → 68px
  assert.match(box.querySelector('.composer-editor-frame').style.height, /68px/);
  document.dispatchEvent(new window.MouseEvent('mousemove', { clientY: 5000 })); // clamp to min
  assert.match(box.querySelector('.composer-editor-frame').style.height, /26px/);
  document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
});

test('double init is idempotent', async () => {
  dom();
  const { setupComposerExpand } = await import(moduleUrl());
  const box = document.querySelector('.input-box');
  const a = setupComposerExpand({ inputBoxEl: box, textareaEl: document.getElementById('user-input') });
  const b = setupComposerExpand({ inputBoxEl: box, textareaEl: document.getElementById('user-input') });
  assert.ok(a); assert.equal(b, null);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/frontend/composer-expand.test.mjs`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 新建 composer-expand.js**

```js
/**
 * Composer expand & resize — vanilla port of AMC useChatInputExpandSizing +
 * ChatInputExpandCorner. Numbers mirror the React source exactly.
 */
import { t } from './i18n.js?v=1';

const EXPANDED_MIN_PX = 220;
const EXPANDED_RATIO = 0.5;   // max(220px, 50vh)
const COLLAPSED_RATIO = 0.4;  // collapse target cap max(220px, 40vh)
const HEIGHT_TRANSITION_MS = 260;
const RESIZE_KEYBOARD_STEP = 16;

export function isComposerCustomHeight(textareaEl) {
    return textareaEl?.dataset?.customHeight === 'true';
}

export function setupComposerExpand({ inputBoxEl, textareaEl }) {
    if (!inputBoxEl || !textareaEl) return null;
    if (inputBoxEl.dataset.expandInitialized === 'true') return null;
    inputBoxEl.dataset.expandInitialized = 'true';

    const frame = inputBoxEl.querySelector('.composer-editor-frame') || textareaEl.parentElement;
    const handle = inputBoxEl.querySelector('.composer-resize-handle');
    const expandBtn = inputBoxEl.querySelector('.composer-expand-btn');

    let expanded = false;
    let manualHeight = null;
    let animatedHeight = null;
    let isResizing = false;
    let pendingExpanded = null;
    let rafId = null;
    let settleTimer = null;
    let dragState = null;

    const minHeightPx = () => {
        const parsed = parseFloat(window.getComputedStyle ? getComputedStyle(textareaEl).minHeight : '');
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 26;
    };
    const viewportPx = (ratio) => Math.max(EXPANDED_MIN_PX, Math.round(window.innerHeight * ratio));
    const expandedMaxPx = () => viewportPx(EXPANDED_RATIO);
    const clampHeight = (h) => Math.min(expandedMaxPx(), Math.max(minHeightPx(), Math.round(h)));
    const hasCustomHeight = () => expanded || manualHeight !== null;

    function measureCollapsedHeight() {
        const prev = textareaEl.style.height;
        try {
            textareaEl.style.height = 'auto';
            return clampHeight(textareaEl.scrollHeight || minHeightPx());
        } finally {
            textareaEl.style.height = prev || '';
        }
    }

    function clearRaf() {
        if (rafId !== null && window.cancelAnimationFrame) window.cancelAnimationFrame(rafId);
        rafId = null;
    }

    function applyFrameStyle() {
        const resolved = animatedHeight ?? (expanded ? 'max(220px, 50vh)' : manualHeight !== null ? `${manualHeight}px` : '');
        frame.style.height = resolved;
        frame.style.minHeight = `${minHeightPx()}px`;
        frame.style.overflow = 'hidden';
        frame.style.transition = isResizing ? 'none' : `height ${HEIGHT_TRANSITION_MS}ms cubic-bezier(0, 0, 0.2, 1)`;
        // Textarea fills the custom-height frame; otherwise natural autoResize flow.
        if (hasCustomHeight()) {
            textareaEl.style.height = '100%';
            textareaEl.style.overflowY = 'auto';
        } else {
            textareaEl.style.height = '';
            textareaEl.style.overflowY = 'hidden';
        }
        textareaEl.dataset.customHeight = String(hasCustomHeight());
        inputBoxEl.classList.toggle('expanded', hasCustomHeight());
        if (handle) {
            handle.setAttribute('aria-valuemin', String(minHeightPx()));
            handle.setAttribute('aria-valuemax', String(expandedMaxPx()));
            handle.setAttribute('aria-valuenow', String(expanded ? expandedMaxPx() : manualHeight ?? minHeightPx()));
            if (isResizing) handle.setAttribute('data-resizing', '');
            else handle.removeAttribute('data-resizing');
        }
    }

    function settleAfterTransition() {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
            animatedHeight = null;
            pendingExpanded = null;
            applyFrameStyle();
        }, HEIGHT_TRANSITION_MS + 80);
    }

    function syncExpandButton() {
        if (!expandBtn) return;
        expandBtn.setAttribute('aria-pressed', String(expanded));
        const labelKey = expanded ? 'inputArea.collapse' : 'inputArea.expand';
        expandBtn.title = t(labelKey);
        expandBtn.setAttribute('aria-label', labelKey);
    }

    function setExpanded(target) {
        if (typeof target === 'boolean' && target === expanded) {
            if (!target && manualHeight !== null) manualHeight = null;
            applyFrameStyle(); syncExpandButton(); return;
        }
        const next = typeof target === 'boolean' ? target : !expanded;
        animatedHeight = `${frame.offsetHeight || minHeightPx()}px`;
        pendingExpanded = next;
        if (!next) manualHeight = null;
        expanded = next;
        applyFrameStyle(); syncExpandButton();
        if (window.requestAnimationFrame) {
            clearRaf();
            rafId = requestAnimationFrame(() => {
                const targetH = expanded ? viewportPx(EXPANDED_RATIO) : measureCollapsedHeight();
                animatedHeight = `${targetH}px`;
                applyFrameStyle();
                settleAfterTransition();
                rafId = null;
            });
        }
        textareaEl.focus({ preventScroll: true });
    }

    function endDrag() {
        isResizing = false;
        dragState = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onDragMove);
        document.removeEventListener('mouseup', endDrag);
        applyFrameStyle();
    }

    function onDragMove(event) {
        if (!dragState) return;
        if (dragState.exitExpandedOnMove) { dragState.exitExpandedOnMove = false; expanded = false; syncExpandButton(); }
        manualHeight = clampHeight(dragState.startHeight + dragState.startClientY - event.clientY);
        applyFrameStyle();
    }

    function startDrag(event) {
        if (event.button !== 0) return;
        event.preventDefault();
        const current = frame.offsetHeight || manualHeight || minHeightPx();
        dragState = { startClientY: event.clientY, startHeight: current, exitExpandedOnMove: expanded };
        isResizing = true;
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('mouseup', endDrag);
        applyFrameStyle();
    }

    function onHandleKeyDown(event) {
        const current = frame.offsetHeight || manualHeight ?? minHeightPx();
        let next = null;
        if (event.key === 'ArrowUp') next = current + RESIZE_KEYBOARD_STEP;
        else if (event.key === 'ArrowDown') next = current - RESIZE_KEYBOARD_STEP;
        else if (event.key === 'Home') next = minHeightPx();
        else if (event.key === 'End') next = expandedMaxPx();
        if (next === null) return;
        event.preventDefault();
        expanded = false;
        manualHeight = clampHeight(next);
        syncExpandButton();
        applyFrameStyle();
    }

    if (expandBtn) {
        expandBtn.addEventListener('click', () => setExpanded());
    }
    if (handle) {
        handle.addEventListener('mousedown', startDrag);
        handle.addEventListener('keydown', onHandleKeyDown);
    }
    const onVisibility = () => { if (document.hidden) endDrag(); };
    document.addEventListener('visibilitychange', onVisibility);

    applyFrameStyle();

    return {
        toggle: () => setExpanded(),
        isExpanded: () => expanded,
        hasCustomHeight,
    };
}
```

注意：`??` 与 `||` 混用的表达式 `manualHeight ?? minHeightPx()` 已用括号显式分组，避免语法歧义。

- [ ] **Step 4: chat.js 联动**

import 区加：

```js
import { setupComposerExpand, isComposerCustomHeight } from './composer-expand.js?v=1';
```

setup 区（`setupComposerExtras({...})` 调用之前）加：

```js
    // AMC-style composer expand corner + resize handle.
    setupComposerExpand({
        inputBoxEl: elements.userInput.closest('.input-box'),
        textareaEl: elements.userInput,
    });
```

两个高度函数让位：

```js
    function resetInputHeight() {
        if (isComposerCustomHeight(elements.userInput)) return;
        elements.userInput.style.height = '26px';
        elements.userInput.style.overflowY = 'hidden';
    }

    function autoResizeInput() {
        if (isComposerCustomHeight(elements.userInput)) { updateSendButtonState(); return; }
        // ……其余原样保留
```

- [ ] **Step 5: i18n 三组 key**

zh.js（inputArea 区块末尾）：

```js
    'inputArea.expand': '展开输入框',
    'inputArea.collapse': '收起输入框',
    'inputArea.resizeHandle': '调整输入框高度',
```

en.js 同位置：

```js
    'inputArea.expand': 'Expand input',
    'inputArea.collapse': 'Collapse input',
    'inputArea.resizeHandle': 'Resize input height',
```

- [ ] **Step 6: 运行新测试与全量测试**

Run: `npm run test:frontend`
Expected: 新增 4 例通过；除已知的 settings-modal 引擎检查遗留失败外全绿

- [ ] **Step 7: Commit**

```bash
git add backend/static/js/modules/composer-expand.js backend/static/js/modules/chat.js backend/static/js/modules/locales/zh.js backend/static/js/modules/locales/en.js tests/frontend/composer-expand.test.mjs
git commit --no-verify -m "feat(composer): port AMC expand sizing state machine + i18n"
```

---

### Task 3: 构建 + 部署 + 线上验证

**Files:** Generate: `backend/static/css/style.css`、`backend/static/dist/**`（不提交生成物，理由同前一轮：工作区有无关 WIP）

- [ ] **Step 1:** `npm run build` — 成功
- [ ] **Step 2:** `docker compose up -d --build`（PATH 补 /usr/local/bin）— exit 0、容器 healthy
- [ ] **Step 3:** 线上验证：首页 200；dist CSS 含 `.composer-expand-corner`；app bundle 含 `composer-expand` 逻辑特征串 `customHeight`
