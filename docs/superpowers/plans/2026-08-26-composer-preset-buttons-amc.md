# 预设按钮 AMC 样式对齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 JustSearch 输入框的搜索强度档位（分段控件）与建议问题 chips 的视觉样式对齐到 AMC-WebUI，纯 CSS 实现。

**Architecture:** 只改 `backend/static/css/sections/input-modal.css` 中两组既有规则块 + 扩展 `tests/frontend/p1-amc-parity.test.mjs` 断言。DOM/JS/i18n 零改动。颜色一律走文件头部既有的 `--amc-*` token（三主题自动生效）。

**Tech Stack:** Vanilla CSS（源文件 = sections/*.css，`css/style.css` 与 `dist/` 由 `npm run build` 生成）、node:test + 正则断言的 CSS parity 测试、Docker Compose 多阶段构建部署。

## Global Constraints

- 设计依据：`docs/superpowers/specs/2026-08-26-composer-preset-buttons-amc-design.md`（commit 44d61c9），AMC 参照 `AMC-WebUI/src/constants/designTokens.ts` L27/L49–L56。
- 本计划只允许修改两个文件：`backend/static/css/sections/input-modal.css` 和 `tests/frontend/p1-amc-parity.test.mjs`。
- 禁止 `git add -A` / `git add .`——工作树含约 72 个用户 WIP 文件；只 add 明确列出的文件。
- 新增硬编码值只允许：几何值（8px/6px/32px/2px/10px/12px）与 `rgba(0, 0, 0, 0.05)`（shadow-sm）；颜色一律 `var(--amc-*)`。
- Token 映射：AMC `bg-input → --amc-bg-input`、`bg-tertiary → --amc-btn-hover`、`border-secondary → --amc-border`、`border-focus → --amc-border-focus`、`text-* → --amc-text-*`、`accent → --amc-accent`。不存在 `--amc-bg-tertiary` 这个 token，不要使用。
- 测试命令：`npm run test:frontend`（= `node --test --test-force-exit tests/frontend/*.test.mjs && node tests/frontend/live-artifacts-dom-check.mjs`）。已知遗留失败：`settings-modal.test.mjs` 的 "engine check results render untrusted response fields as text"（用户 WIP 所致，与本工作无关，不得顺手修复，汇报时说明即可）。
- 生成物 `backend/static/css/style.css`、`backend/static/dist/**` 不入 commit，部署时由 Docker 构建阶段重新生成。

---

### Task 1: 搜索强度档位 → AMC 分段控件

**Files:**
- Test: `tests/frontend/p1-amc-parity.test.mjs`（在 "P2: send button" 测试之后追加）
- Modify: `backend/static/css/sections/input-modal.css:187-244`（`.search-intensity-presets` 轨道与 `.intensity-chip*` 各规则）

**Interfaces:**
- Consumes: 文件头部既有 token（light 块 L84 起、dark L107 起、graphite L128 起）。
- Produces: 无下游依赖；Task 3 直接复用本任务的最终 CSS。

- [ ] **Step 1: 写失败测试**

在 `tests/frontend/p1-amc-parity.test.mjs` 的 `P2: send button aligns with AMC size/colors/states` 测试结束后（第 38 行 `});` 之后）插入：

```js
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
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Volumes/WD_BLACK/Code/JustSearch && npm run test:frontend 2>&1 | tail -30`
Expected: 新测试 `intensity preset segments align with AMC segmented control` FAIL（track 缺 `gap: 2px` 等）；其余测试维持原状（含那 1 个已知遗留失败）。

- [ ] **Step 3: 改轨道规则**

`backend/static/css/sections/input-modal.css` 中把：

```css
.search-intensity-presets {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--amc-btn-hover) 80%, transparent);
    border: 1px solid color-mix(in srgb, var(--amc-border) 70%, transparent);
    flex-wrap: wrap;
}
```

替换为：

```css
.search-intensity-presets {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    border-radius: 8px; /* AMC rounded-lg segmented track */
    background: var(--amc-bg-input);
    border: 1px solid var(--amc-border);
    flex-wrap: wrap;
}
```

- [ ] **Step 4: 改片段基础/hover/focus 规则**

同文件把 `.intensity-chip` 主块中的

```css
    color: var(--amc-text-secondary);
```
（该行位于 `.intensity-chip {` 块内）改为

```css
    color: var(--amc-text-tertiary);
```

并把主块内的

```css
    padding: 5px 11px;
    border-radius: 9999px;
```
改为

```css
    height: 32px;
    padding: 0 10px;
    border-radius: 6px;
```

把 hover 规则：

```css
.intensity-chip:hover:not(:disabled) {
    background: color-mix(in srgb, var(--amc-bg-input) 70%, var(--amc-btn-hover));
    color: var(--amc-text-primary);
}
```
改为：

```css
.intensity-chip:hover:not(:disabled) {
    background: color-mix(in srgb, var(--amc-btn-hover) 70%, transparent);
    color: var(--amc-text-primary);
}
```

把 focus-visible 规则：

```css
.intensity-chip:focus-visible {
    outline: none;
    border-color: var(--amc-border-focus);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--amc-accent) 35%, transparent);
}
```
改为：

```css
.intensity-chip:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--amc-border-focus); /* AMC ring-inset */
}
```

- [ ] **Step 5: 重做选中态并删除特例**

把：

```css
.intensity-chip.active {
    background: var(--amc-bg-input);
    color: var(--amc-text-primary);
    border-color: color-mix(in srgb, var(--amc-border) 80%, transparent);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
    font-weight: 600;
}

.intensity-chip.active[data-intensity="research"],
.intensity-chip.active[data-intensity="deep"] {
    color: var(--amc-accent);
}

.intensity-chip-custom.active {
    color: var(--amc-text-primary);
}
```

整体替换为：

```css
.intensity-chip.active {
    background: color-mix(in srgb, var(--amc-accent) 12%, transparent); /* AMC bg-accent/12 */
    color: var(--amc-text-primary);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05); /* shadow-sm */
}
```

- [ ] **Step 6: 运行确认通过**

Run: `cd /Volumes/WD_BLACK/Code/JustSearch && npm run test:frontend 2>&1 | tail -15`
Expected: 新测试 PASS；总结果仍为「除已知遗留失败外全部通过」。

- [ ] **Step 7: 提交**

```bash
cd /Volumes/WD_BLACK/Code/JustSearch && git add backend/static/css/sections/input-modal.css tests/frontend/p1-amc-parity.test.mjs && git commit --no-verify -m "feat: align search-intensity segments with AMC ToolbarSegmentedControl"
```

---

### Task 2: 建议 chips → AMC SUGGESTION_CHIP

**Files:**
- Test: `tests/frontend/p1-amc-parity.test.mjs`（Task 1 测试之后追加）
- Modify: `backend/static/css/sections/input-modal.css:3135-3195`（`.suggestion-chip` 主块/hover 与 ≥640px media query）

**Interfaces:**
- Consumes: Task 1 已提交的同一 CSS 文件与测试文件。
- Produces: 无下游依赖。

- [ ] **Step 1: 写失败测试**

在 Task 1 新增测试之后插入：

```js
test('P2: suggestion chips align with AMC suggestion chip tokens', () => {
  const css = readFileSync('backend/static/css/sections/input-modal.css', 'utf8');
  const chip = css.match(/\.suggestion-chip\s*\{[^}]*\}/);
  assert.ok(chip, '.suggestion-chip rule exists');
  assert.match(chip[0], /padding:\s*10px 10px/, 'mobile py-2.5 px-2.5 touch target');
  assert.match(chip[0], /border-radius:\s*8px/, 'rounded-lg kept');
  assert.match(chip[0], /color-mix\(in srgb, var\(--amc-btn-hover\) 35%, transparent\)/, 'default bg-tertiary/35 via amc token');
  assert.match(chip[0], /color-mix\(in srgb, var\(--amc-border\) 70%, transparent\)/, 'default border-secondary/70 via amc token');
  assert.match(chip[0], /color:\s*var\(--amc-text-secondary\)/);

  const hover = css.match(/\.suggestion-chip:hover\s*\{[^}]*\}/);
  assert.ok(hover, ':hover rule exists');
  assert.match(hover[0], /border-color:\s*var\(--amc-border-focus\)/, 'AMC hover:border-focus');
  assert.match(hover[0], /background:\s*var\(--amc-btn-hover\)/, 'solid tertiary hover bg');

  const focus = css.match(/\.suggestion-chip:focus-visible\s*\{[^}]*\}/);
  assert.ok(focus, ':focus-visible rule exists');
  assert.match(focus[0], /box-shadow:\s*inset 0 0 0 2px var\(--amc-border-focus\)/, 'inset focus ring');

  const mq = css.match(/@media \(min-width: 640px\)\s*\{\s*\.suggestion-chip\s*\{[^}]*\}/);
  assert.ok(mq, 'desktop media query exists');
  assert.match(mq[0], /padding:\s*8px 12px/, 'desktop sm:px-3 py-2');
  assert.match(mq[0], /gap:\s*6px/, 'desktop sm:gap-1.5');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Volumes/WD_BLACK/Code/JustSearch && npm run test:frontend 2>&1 | tail -30`
Expected: 仅新测试 `suggestion chips align with AMC suggestion chip tokens` FAIL（缺 focus-visible 规则等）。

- [ ] **Step 3: 改 chips 主块与 hover，新增 focus-visible**

把：

```css
.suggestion-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 6px 10px;
    border-radius: 8px; /* AMC rounded-lg */
    border: 1px solid color-mix(in srgb, var(--theme-border-secondary) 70%, transparent);
    background: color-mix(in srgb, var(--theme-bg-tertiary) 35%, transparent);
    color: var(--theme-text-secondary);
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.suggestion-chip:hover {
    background: var(--theme-bg-tertiary);
    color: var(--theme-text-primary);
    border-color: var(--theme-border-secondary);
}
```

替换为：

```css
.suggestion-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 10px 10px; /* AMC mobile py-2.5 px-2.5 touch target */
    border-radius: 8px; /* AMC rounded-lg */
    border: 1px solid color-mix(in srgb, var(--amc-border) 70%, transparent);
    background: color-mix(in srgb, var(--amc-btn-hover) 35%, transparent); /* bg-tertiary/35 */
    color: var(--amc-text-secondary);
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.suggestion-chip:hover {
    background: var(--amc-btn-hover);
    color: var(--amc-text-primary);
    border-color: var(--amc-border-focus); /* AMC hover:border-focus */
}
.suggestion-chip:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--amc-border-focus);
}
```

- [ ] **Step 4: 改桌面 media query**

把：

```css
@media (min-width: 640px) {
    .suggestion-chip {
        padding: 8px 13px;
        font-size: 14px;
    }
}
```

替换为：

```css
@media (min-width: 640px) {
    .suggestion-chip {
        padding: 8px 12px; /* AMC sm:px-3 py-2 */
        gap: 6px; /* sm:gap-1.5 */
        font-size: 14px;
    }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `cd /Volumes/WD_BLACK/Code/JustSearch && npm run test:frontend 2>&1 | tail -15`
Expected: 两个新测试均 PASS；除已知遗留失败外全绿。

- [ ] **Step 6: 提交**

```bash
cd /Volumes/WD_BLACK/Code/JustSearch && git add backend/static/css/sections/input-modal.css tests/frontend/p1-amc-parity.test.mjs && git commit --no-verify -m "feat: align suggestion chips with AMC suggestion chip tokens"
```

---

### Task 3: 构建、部署与线上校验

**Files:** 无代码改动；产出运行中的容器与校验证据。

**Interfaces:**
- Consumes: Task 1/2 已提交的源 CSS。

- [ ] **Step 1: 全量回归确认**

Run: `cd /Volumes/WD_BLACK/Code/JustSearch && npm run test:frontend 2>&1 | tail -20`
Expected: 除已知遗留失败（settings-modal untrusted fields，用户 WIP 所致）外全部通过；两个新 parity 测试 PASS。

- [ ] **Step 2: 本地构建验证 CSS 编译无误**

Run: `cd /Volumes/WD_BLACK/Code/JustSearch && npm run build 2>&1 | tail -10`
Expected: exit 0；`backend/static/css/style.css` 更新且包含 `border-radius:8px` 相邻 `--amc-bg-input` 的档位轨道规则（grep `style.css` 确认，注意压缩后冒号后有空格与否以实际输出为准）。

- [ ] **Step 3: Docker 重建部署**

```bash
export PATH="/usr/local/bin:$PATH" && cd /Volumes/WD_BLACK/Code/JustSearch && docker compose up -d --build
```

Expected: 镜像构建成功、容器重启。（docker 二进制不在默认 PATH，必须先 export。）

- [ ] **Step 4: 线上资产校验**

```bash
export PATH="/usr/local/bin:$PATH"
docker inspect justsearch --format '{{.State.Health.Status}}'
curl -sf http://127.0.0.1:8001/ -o /dev/null -w '%{http_code}\n'
CSS_URL=$(curl -sf http://127.0.0.1:8001/ | grep -o '/static/css/style.css?v=[a-f0-9]*' | head -1)
curl -sf "http://127.0.0.1:8001${CSS_URL}" | tr '}' '\n' | grep -F 'border-radius: 8px' | grep -i 'search-intensity-presets' 
curl -sf "http://127.0.0.1:8001${CSS_URL}" | grep -c 'composer-expand-corner'
```

Expected: `healthy`；首页 `200`；服务端 CSS 含新的 `.search-intensity-presets … border-radius: 8px` 规则与上一轮的 expand-corner 规则（版本参数已变化）。若压缩格式与 grep 不符（如无空格），改用 `grep -o 'search-intensity-presets[^}]*}'` 检查内容而非死磕精确字符串。

- [ ] **Step 5: 向用户汇报（中文）**

内容：两组按钮改动对照要点、提交哈希（git log -2）、测试结果（含已知遗留失败说明）、容器 healthy + 线上 CSS 校验证据、刷新页面即可查看。
