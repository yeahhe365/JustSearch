# 移除建议问题功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 彻底移除输入框上方的建议问题（suggestion chips）功能——DOM、CSS、JS、i18n、测试全链路清除，斜杠菜单与生成状态胶囊不受影响。

**Architecture:** 方案 A 单模块剥离：`composer-extras.js` 只删建议问题代码段，保留 slash 菜单与状态胶囊两块职责；`setupComposerExtras` 签名去掉 `heroEl` 与 `onPickSuggestion`。TDD 先把测试改成目标态（红），再删实现到绿。

**Tech Stack:** Vanilla ES Modules + esbuild、node:test + jsdom、Docker Compose 多阶段构建。

## Global Constraints

- 设计依据：`docs/superpowers/specs/2026-08-26-remove-suggestion-chips-design.md`（commit 68a650f）。
- 只允许修改：`backend/static/index.html`、`backend/static/css/sections/input-modal.css`、`backend/static/js/modules/composer-extras.js`、`backend/static/js/modules/chat.js`、`backend/static/js/modules/locales/zh.js`、`backend/static/js/modules/locales/en.js`、`tests/frontend/composer-extras.test.mjs`、`tests/frontend/p1-amc-parity.test.mjs`。
- 禁止 `git add -A` / `git add .`——工作树含约 72 个用户 WIP 文件；只 add 明确列出的文件。
- i18n 键必须从 `zh.js` 与 `en.js` **成对删除**（i18n-coverage 测试强制键集一致）。
- `selectedIndex` 变量被 slash 菜单键盘导航使用，保留。
- 已知遗留失败：settings-modal 的 "engine check results render untrusted response fields as text"（用户 WIP 所致）；不得顺手修复，汇报时说明。
- 生成物 `backend/static/css/style.css`、`backend/static/dist/**` 不入 commit。
- 部署命令必须先 `export PATH="/usr/local/bin:$PATH"`（docker 不在默认 PATH）。

---

### Task 1: 测试先红

**Files:**
- Modify: `tests/frontend/composer-extras.test.mjs`（整文件重写）
- Modify: `tests/frontend/p1-amc-parity.test.mjs`（替换 suggestion chips 断言组）

**Interfaces:**
- Produces: 目标态断言 —— 模块源码无 `SUGGESTIONS`/`suggestion` 字样、`index.html` 与 `input-modal.css` 无 `.suggestion-chip`；后续任务以这些断言转绿为完成标准。

- [ ] **Step 1: 重写 `tests/frontend/composer-extras.test.mjs` 为以下完整内容**

```js
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
```

- [ ] **Step 2: 替换 `tests/frontend/p1-amc-parity.test.mjs` 中整个 `P2: suggestion chips align with AMC suggestion chip tokens` 测试（从 `test('P2: suggestion chips align...` 到其结尾 `});`）为**

```js
test('P2: suggestion chips feature is fully removed', () => {
  const html = readFileSync('backend/static/index.html', 'utf8');
  assert.doesNotMatch(html, /suggestion-chip/, '#suggestion-chips block removed from index.html');
  const css = readFileSync('backend/static/css/sections/input-modal.css', 'utf8');
  assert.doesNotMatch(css, /\.suggestion-chip/, '.suggestion-chip rules removed from CSS');
});
```

- [ ] **Step 3: 运行确认失败**

Run: `cd /Volumes/WD_BLACK/Code/JustSearch && npm run test:frontend 2>&1 | tail -30`
Expected: 恰好两类新失败——① composer-extras 的 "suggestion chips code is fully removed"（模块仍含 `SUGGESTIONS`）；② parity 的 "suggestion chips feature is fully removed"（HTML/CSS 仍有）。其余测试维持现状（含已知遗留失败）。注意：旧实现签名兼容新调用（少传参数不报错），所以 slash/status 用例此时应仍绿。

- [ ] **Step 4: 提交测试（红灯态不入库，跳过提交；直接进入 Task 2）**

---

### Task 2: 删除实现至绿

**Files:**
- Modify: `backend/static/index.html:230-238`
- Modify: `backend/static/css/sections/input-modal.css`（suggestion 规则区）
- Modify: `backend/static/js/modules/composer-extras.js`
- Modify: `backend/static/js/modules/chat.js`
- Modify: `backend/static/js/modules/locales/zh.js` / `en.js`
- Test: Task 1 改过的两个测试文件

**Interfaces:**
- Consumes: Task 1 的目标态断言。
- Produces: `setupComposerExtras({ inputEl, sendBtn, root?, onApplyIntensity?, getStatusText? })` → `{ update(), openSlashMenu(), closeSlashMenu(), isSlashOpen() }`；`update()` 仅刷新状态胶囊。返回 `null` 当 `inputEl` 缺失。

- [ ] **Step 1: 删 `index.html` 的 `#suggestion-chips` 整块**

删除以下完整块（当前 230–238 行）：

```html
            <div id="suggestion-chips" class="suggestion-chips" hidden>
                <div class="suggestion-chips-track" id="suggestion-chips-track" role="list" data-i18n-aria-label="inputArea.suggestions" aria-label="建议问题"></div>
                <button type="button" class="suggestion-scroll-arrow suggestion-scroll-left" id="suggestion-scroll-left" data-i18n-aria-label="inputArea.scrollLeft" tabindex="-1">
                    <span class="material-symbols-rounded" aria-hidden="true">chevron_left</span>
                </button>
                <button type="button" class="suggestion-scroll-arrow suggestion-scroll-right" id="suggestion-scroll-right" data-i18n-aria-label="inputArea.scrollRight" tabindex="-1">
                    <span class="material-symbols-rounded" aria-hidden="true">chevron_right</span>
                </button>
            </div>
```

- [ ] **Step 2: 删 `input-modal.css` 的 suggestion 规则区**

删除从注释行 `/* --- Suggestion chips (visible only on an empty conversation) --- */` 起，到 `@media (min-width: 640px) { .suggestion-chip { … } }` 块的收尾 `}` 止的全部规则（即 `.suggestion-chips`、`.suggestion-chips[hidden]`、`.suggestion-chips-track`、`.suggestion-chips-track::-webkit-scrollbar`、`.suggestion-chip` 主块/hover/focus-visible/icon/text、`.suggestion-scroll-arrow` 及其 `.is-visible`/hover/left/right、min-width:640px 覆盖块）。保留紧随其后的 `/* --- Slash command menu (anchored above the composer) --- */`。

同文件上方横幅注释中：

```
    Composer extras — AMC-aligned: suggestion chips, slash-command
    menu, and the generation status pill.
```
改为：
```
    Composer extras — AMC-aligned: slash-command menu and the
    generation status pill.
```

完成后验证残留：`grep -c suggestion backend/static/css/sections/input-modal.css` 应为 `0`（若不为 0，逐条查看并清除 suggestion 相关规则）。

- [ ] **Step 3: 剥离 `composer-extras.js` 的建议问题代码**

共 6 处精确替换：

(a) 头部注释改为：

```js
// ===========================================================================
// Composer extras — UI aligned with AMC-WebUI's SlashCommandMenu /
// LiveStatusBanner.
//
//   • Slash command menu — type "/" to switch the search-intensity preset.
//   • Generation status  — a pill mirroring the send/stop state, so the
//                          running search is visible above the composer.
//
// The module is self-contained: it observes the send button (.processing) so
// it needs no chat.js wiring beyond the callbacks for applying an intensity
// preset and for reading status labels.
// ===========================================================================
```

(b) 删除整个 SUGGESTIONS 导出块（从 `// --- Suggestion data (search-domain prompts) -------------------------------` 到 `]);` 共 10 行）。

(c) 函数签名：

```js
export function setupComposerExtras({
    inputEl,
    sendBtn,
    heroEl,
    root = document,
    onPickSuggestion,
    onApplyIntensity,
    getStatusText = () => null, // () => { title, subtitle } | null
}) {
```
改为：
```js
export function setupComposerExtras({
    inputEl,
    sendBtn,
    root = document,
    onApplyIntensity,
    getStatusText = () => null, // () => { title, subtitle } | null
}) {
```

(d) 元素查询区删除这 4 行：

```js
    const chipsBox = inputArea?.querySelector('#suggestion-chips');
    const chipsTrack = inputArea?.querySelector('#suggestion-chips-track');
    const chipsLeft = inputArea?.querySelector('#suggestion-scroll-left');
    const chipsRight = inputArea?.querySelector('#suggestion-scroll-right');
```

(e) 删除整段「Suggestion chips」区块：从

```js
    // ------------------------------------------------------------------
    // Suggestion chips
    // ------------------------------------------------------------------
```
起，到

```js
        window.addEventListener('resize', updateChipScrollArrows);
    }
```
止（含 `renderChips`、`updateChipScrollArrows`、scroll 监听、`scrollChips`、箭头 click 绑定、`raf` 助手、`syncSuggestionsVisibility`、MutationObserver、resize 监听全部内容）。

(f) 返回句柄：

```js
    return {
        update: () => {
            syncSuggestionsVisibility();
            updateStatusPill();
        },
```
改为：
```js
    return {
        update: () => {
            updateStatusPill();
        },
```

- [ ] **Step 4: 更新 `chat.js` 接线与缓存参数**

导入行 `import { setupComposerExtras } from './composer-extras.js?v=2';` 改为 `import { setupComposerExtras } from './composer-extras.js?v=3';`

调用处：

```js
    // AMC-style composer extras: suggestion chips, slash commands, status pill.
    setupComposerExtras({
        inputEl: elements.userInput,
        sendBtn: elements.sendBtn,
        heroEl: elements.heroSection,
        onPickSuggestion: (text) => {
            elements.userInput.value = text;
            handleSendMessage(text);
        },
        onApplyIntensity: (presetId) => {
```
改为：
```js
    // AMC-style composer extras: slash commands + generation status pill.
    setupComposerExtras({
        inputEl: elements.userInput,
        sendBtn: elements.sendBtn,
        onApplyIntensity: (presetId) => {
```

- [ ] **Step 5: 成对删除 i18n 键**

`zh.js` 删除以下行（66–68 与 583–589 两段）：

```js
    'inputArea.suggestions': '建议问题',
    'inputArea.scrollLeft': '向左滚动建议',
    'inputArea.scrollRight': '向右滚动建议',
```
及：
```js
    'composer.suggestion1': '最近一周全球最重要的科技新闻有哪些？',
    'composer.suggestion2': '比较 Python 与 Rust 在数据分析场景的优缺点',
    'composer.suggestion3': '2026 年最值得关注的 AI 应用趋势',
    'composer.suggestion4': 'SpaceX 星舰最新进展及下一次发射计划',
    'composer.suggestion5': '全球碳中和的最新进展与主要挑战',
    'composer.suggestion6': '深度学习中 Transformer 架构的核心原理',
    'composer.suggestion7': '2026 年全球经济与通胀展望',
```

`en.js` 删除相同键名对应的行（66–68 与 `composer.suggestion1-7` 段，先 `grep -n "composer.suggestion\|inputArea.scroll\|inputArea.suggestions" backend/static/js/modules/locales/en.js` 定位后按行删除）。

- [ ] **Step 6: 全量回归确认绿**

Run: `cd /Volumes/WD_BLACK/Code/JustSearch && npm run test:frontend 2>&1 | tail -15`
Expected: Task 1 的两个移除断言 PASS；composer-extras 余下 3 个用例 PASS；i18n-coverage PASS（键成对删除）；总结果「除已知遗留失败外全绿」。同时确认 `grep -rn "onPickSuggestion\|SUGGESTIONS" backend/static/js/` 无结果。

- [ ] **Step 7: 提交**

```bash
cd /Volumes/WD_BLACK/Code/JustSearch && git add backend/static/index.html backend/static/css/sections/input-modal.css backend/static/js/modules/composer-extras.js backend/static/js/modules/chat.js backend/static/js/modules/locales/zh.js backend/static/js/modules/locales/en.js tests/frontend/composer-extras.test.mjs tests/frontend/p1-amc-parity.test.mjs && git commit --no-verify -m "feat: remove suggestion chips from the composer"
```

---

### Task 3: 构建、部署与线上校验

**Files:** 无代码改动；产出运行中的容器与校验证据。

- [ ] **Step 1: 本地构建**

Run: `cd /Volumes/WD_BLACK/Code/JustSearch && npm run build 2>&1 | tail -6`
Expected: exit 0；`grep -c suggestion backend/static/dist/index.html backend/static/css/style.css` 均为 0。

- [ ] **Step 2: Docker 重建部署**

```bash
export PATH="/usr/local/bin:$PATH" && cd /Volumes/WD_BLACK/Code/JustSearch && docker compose up -d --build
```

Expected: 镜像重建成功、容器重启（可后台跑并 job_output 收集）。

- [ ] **Step 3: 线上校验**

```bash
export PATH="/usr/local/bin:$PATH"
docker inspect justsearch --format '{{.State.Health.Status}}'
curl -sf http://127.0.0.1:8001/ -o /dev/null -w '%{http_code}\n'
curl -sf http://127.0.0.1:8001/ | grep -c 'suggestion-chips'   # 期望 0
curl -sf http://127.0.0.1:8001/ | grep -o '/static/dist/css/style.css?v=[a-f0-9]*' | head -1   # 版本号应较 fb078067 变化
```

再取该 CSS URL 内容确认无 `.suggestion-chip` 规则、且 `composer-expand-corner` / `search-intensity-presets` 等既有规则仍在（防止误删相邻区块）。

- [ ] **Step 4: 向用户汇报（中文）**

内容：五处足迹删除清单、commit 哈希、回归结果（含已知遗留失败说明）、容器 healthy + 线上证据（HTML 无 chips、CSS 版本变化）、刷新即可看到空会话时输入框上方只剩档位组。
