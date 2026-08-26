# Composer 输入框 AMC 对齐（第二轮）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 JustSearch composer 的外壳（圆角/阴影/聚焦态/过渡）与发送按钮（尺寸/配色/状态）收敛到 AMC-WebUI 当前实现，纯 CSS 视觉对齐。

**Architecture:** 延续 P1 既有「`--amc-*` token → 规则」架构，仅修改 `backend/static/css/sections/input-modal.css` 与 parity 测试；不引入 React、不改 JS 行为。AMC 参考源：`src/components/chat/input/chatInputAreaLayout.ts:31`、`actions/SendControls.tsx`、`src/constants/buttonClasses.ts:CHAT_INPUT_BUTTON_CLASS`、`src/constants/focusClasses.ts`。

**Tech Stack:** Vanilla CSS（CSS Variables + color-mix）、Tailwind CSS 4（构建管线不动）、Node --test + jsdom、esbuild（scripts/build.mjs）

## Global Constraints

- 源码唯一真源为 `backend/static/css/sections/*.css`；`backend/static/css/style.css` 与 `backend/static/dist/*` 为生成物，改完必须 `npm run build`
- 硬编码色值只允许出现在 `#input-area` 的 token 定义处（既有约定，AMC 发送键色本身即硬编码）
- 提交只允许包含本计划明确修改的文件（工作区有大量无关未提交改动，禁止 `git add -A` / `git add .`）
- 全量前端测试 `npm run test:frontend` 必须保持绿灯
- 文本域 `#user-input` 不改动；右侧不留 AMC `pr-9`（JustSearch 无展开角标）

---

### Task 1: 外壳 `.input-box` 圆角/阴影/聚焦/过渡对齐

**Files:**
- Modify: `backend/static/css/sections/input-modal.css:80-81`（token）、`:288`（transition）、`:298-310`（dark 覆盖与 focus-within）
- Test: `tests/frontend/p1-amc-parity.test.mjs:11-17`

**Interfaces:**
- Consumes: AMC `inputContainerClass` = `rounded-[20px] … shadow-[0_8px_30px_rgba(0,0,0,0.06)] transition-all duration-200 ease-in-out focus-within:border-[…] focus-within:shadow-[0_8px_30px_rgba(0,0,0,0.08)]`
- Produces: `--amc-radius-lg: 1.25rem`、`--amc-composer-shadow: 0 8px 30px rgba(0, 0, 0, 0.06)`（Task 2 不依赖，但同文件）

- [ ] **Step 1: 更新 parity 测试（先写失败断言）**

将 `tests/frontend/p1-amc-parity.test.mjs` 第一个测试替换为：

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/frontend/p1-amc-parity.test.mjs`
Expected: FAIL — `--amc-radius-lg\s*:\s*1\.25rem` 不匹配（现值 1.625rem）

- [ ] **Step 3: 修改 input-modal.css**

3a. token 定义（约 line 80-81）：

```css
/* old */
    --amc-radius-lg: 1.625rem; /* AMC COMPOSER_SHELL_RADIUS_CLASS pill */
    --amc-composer-shadow: var(--shadow-md);
/* new */
    --amc-radius-lg: 1.25rem; /* AMC COMPOSER_SHELL_RADIUS_CLASS rounded-[20px] */
    --amc-composer-shadow: 0 8px 30px rgba(0, 0, 0, 0.06); /* AMC shadow-[0_8px_30px_rgba(0,0,0,0.06)] */
```

3b. `.input-box` 内 transition（约 line 288）：

```css
/* old */
    transition: border-color var(--transition-fast), box-shadow var(--transition-fast), background-color var(--transition-fast);
/* new */
    transition: all 0.2s ease-in-out;
```

3c. 删除深色阴影覆盖块（约 line 298-300，深浅同值后冗余）：

```css
/* delete entire block */
[data-theme="dark"] .input-box {
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.06);
}
```

3d. 重写 focus-within 并删除其深色覆盖（约 line 302-310）：

```css
/* old（两个块都删） */
.input-box:focus-within {
    border-color: var(--theme-border-focus);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-border-focus) 15%, transparent);
    background-color: var(--theme-bg-input);
}

[data-theme="dark"] .input-box:focus-within {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-border-focus) 15%, transparent);
}
/* new */
.input-box:focus-within {
    border-color: var(--theme-border-focus);
    /* AMC: no ring — the ambient shadow deepens slightly on focus. */
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.08);
}
```

注意：`#input-area.is-editing-message .input-box`（line 65-68）的编辑横幅规则**保留不动**。

- [ ] **Step 4: 运行测试验证通过**

Run: `node --test tests/frontend/p1-amc-parity.test.mjs`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
cd /Volumes/WD_BLACK/Code/JustSearch
git add backend/static/css/sections/input-modal.css tests/frontend/p1-amc-parity.test.mjs
git commit --no-verify -m "style(composer): align shell radius/shadow/focus to AMC"
```

---

### Task 2: 发送按钮 `#send-btn` AMC 化 + 构建收尾

**Files:**
- Modify: `backend/static/css/sections/input-modal.css:70-77`（删琥珀覆盖）、`:105-111`（浅色 token）、`:123-130`（深色 token）、`:147-149`（graphite token）、`:739-786`（按钮主块）
- Modify: `tests/frontend/p1-amc-parity.test.mjs`（追加 send 断言）
- Generate: `backend/static/css/style.css`、`backend/static/dist/**`（由 `npm run build` 生成后一并提交）

**Interfaces:**
- Consumes: Task 1 后的同文件；AMC `SEND_BUTTON_SIZE_CLASS='!h-[34px] !w-[34px]'`、`backgroundClass` light `#3964FE/#3358e0` dark `#679EFE/#5a8de0`、stop 态 `bg-[var(--theme-bg-danger)]`、`CHAT_INPUT_BUTTON_CLASS`（h/w 44 但被 send 尺寸类覆盖为 34；disabled:opacity-50）
- Produces: token `--amc-send-bg` / `--amc-send-bg-hover`（三主题 scope 各自定义）

- [ ] **Step 1: 追加失败的测试断言**

在 `tests/frontend/p1-amc-parity.test.mjs` 末尾追加：

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/frontend/p1-amc-parity.test.mjs`
Expected: FAIL — 无 `--amc-send-bg` token

- [ ] **Step 3: 修改 input-modal.css**

3a. 删除编辑态琥珀色覆盖（line 70-77 整块）：

```css
/* delete both blocks */
#input-area.is-editing-message #send-btn:not(.processing) { ... }
#input-area.is-editing-message #send-btn:not(.processing):hover { ... }
```

3b. 浅色 scope（`--primary-gradient: #2563eb;` 之后追加）：

```css
    --amc-send-bg: #3964fe;           /* AMC SendControls bg-[#3964FE] */
    --amc-send-bg-hover: #3358e0;     /* hover:bg-[#3358e0] */
```

3c. 深色 scope（`--primary-gradient: #4f7cf5;` 之后追加）：

```css
    --amc-send-bg: #679efe;           /* AMC dark:bg-[#679EFE] */
    --amc-send-bg-hover: #5a8de0;     /* dark:hover:bg-[#5a8de0] */
```

3d. graphite scope（`--primary-gradient: var(--theme-bg-accent);` 之后追加）：

```css
    --amc-send-bg: var(--theme-bg-accent);
    --amc-send-bg-hover: var(--theme-bg-accent-hover, #3b6bed);
```

3e. 用下块整体替换 `#send-btn` 主块及其 hover/active/disabled/.processing 规则（原 line 738-786；图标交叉淡入规则 line 788+ 保留不动）：

```css
/* Submit/Send Button — AMC flat accent circle (CHAT_INPUT_BUTTON_CLASS + SendControls) */
#send-btn {
    width: 34px;
    height: 34px;
    background: var(--amc-send-bg, var(--amc-accent));
    border: none;
    margin: 0;
    color: var(--amc-accent-text);
    cursor: pointer;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 9999px; /* rounded-full */
    transition: background-color 0.15s ease, color 0.15s ease;
    flex-shrink: 0;
    position: relative;
    overflow: hidden;
}

#send-btn:hover:not(:disabled) {
    background: var(--amc-send-bg-hover, var(--amc-accent-hover));
}

#send-btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--theme-bg-input, var(--amc-bg-input)), 0 0 0 4px var(--theme-border-focus, var(--amc-border-focus));
}

#send-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

/* Processing/Stop state — danger circle (AMC bg-danger); no square morph */
#send-btn.processing {
    background: var(--amc-danger);
    color: var(--amc-accent-text);
}

#send-btn.processing:hover:not(:disabled) {
    background: var(--amc-danger-hover);
}
```

- [ ] **Step 4: 运行全量前端测试**

Run: `npm run test:frontend`
Expected: PASS（172+ 用例全绿）

- [ ] **Step 5: 构建并核对生成物**

Run: `npm run build`
Expected: 成功输出 dist；确认 `dist/css/style.css` 含 `--amc-radius-lg:1.25rem` 与 `width:34px`

```bash
grep -o "amc-radius-lg:1.25rem" backend/static/dist/css/style.css | head -1
```

- [ ] **Step 6: Commit（仅列明文件）**

```bash
cd /Volumes/WD_BLACK/Code/JustSearch
git add backend/static/css/sections/input-modal.css tests/frontend/p1-amc-parity.test.mjs backend/static/css/style.css backend/static/dist
git commit --no-verify -m "style(composer): align send button to AMC flat accent circle + rebuild"
```
