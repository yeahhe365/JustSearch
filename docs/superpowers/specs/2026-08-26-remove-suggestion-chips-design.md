# 设计：移除输入框建议问题（suggestion chips）功能

- 日期：2026-08-26
- 状态：已批准（用户确认：彻底删除，不留死代码；方案 A = 单模块剥离）
- 背景：建议问题 chips 是空会话时显示在输入框上方的 7 条预设问题横滚条。用户要求全部去掉。

## 1. 目标

把 JustSearch 前端的建议问题功能整体移除：DOM、样式、逻辑、i18n 文案、相关测试。斜杠命令菜单与生成状态胶囊**不受影响**（同属 `composer-extras.js` 的另外两块职责）。

## 2. 删除清单（按文件）

### 2.1 `backend/static/index.html`
删除 `#suggestion-chips` 整块（当前 230–238 行）：外层容器、`#suggestion-chips-track`、`#suggestion-scroll-left`、`#suggestion-scroll-right` 两个箭头按钮。

### 2.2 `backend/static/css/sections/input-modal.css`
删除以下规则块（含「Composer extras」区块注释里对 suggestion chips 的提及，注释改为只描述 slash menu 与 status pill）：
`.suggestion-chips`、`.suggestion-chips[hidden]`、`.suggestion-chips-track`（含 `::-webkit-scrollbar`）、`.suggestion-chip`（主块/hover/focus-visible/icon/text）、`.suggestion-scroll-arrow`（含 `.is-visible`/hover/left/right）、`@media (min-width: 640px)` 内的 `.suggestion-chip` 覆盖块。

### 2.3 `backend/static/js/modules/composer-extras.js`
- 删 `SUGGESTIONS` 导出常量与头部注释中的 suggestion 条目。
- `setupComposerExtras` 签名删去 `heroEl`、`onPickSuggestion` 两个参数。
- 删元素查询 `chipsBox/chipsTrack/chipsLeft/chipsRight`；删 `renderChips`、`updateChipScrollArrows`、`scrollChips`、scroll/click 监听、`syncSuggestionsVisibility` 及其 MutationObserver 与 resize 监听。
- 返回句柄的 `update()` 只保留 `updateStatusPill()`。
- 模块内 `selectedIndex` 变量被 slash 菜单使用，**保留**。
- 文件头注释同步更新为两块职责。

### 2.4 `backend/static/js/modules/chat.js`
`setupComposerExtras({...})` 调用处删除 `heroEl: elements.heroSection` 与整个 `onPickSuggestion` 回调；上方注释去掉 "suggestion chips" 字样。

### 2.5 `backend/static/js/modules/locales/zh.js` / `en.js`
两侧同步删除键：`composer.suggestion1`–`composer.suggestion7`、`inputArea.suggestions`、`inputArea.scrollLeft`、`inputArea.scrollRight`。（i18n 覆盖测试强制 zh/en 键集一致，必须成对删。）

## 3. 测试策略

TDD：先改测试到红，再删实现到绿。

1. `tests/frontend/composer-extras.test.mjs`：
   - DOM fixture 删除 suggestion 相关节点；
   - 删除用例「suggestion chips render when the hero is visible and hide with it」「clicking a suggestion chip sends its text」；
   - 其余用例调用处若传了 `heroEl`/`onPickSuggestion` 一并清理；
   - 新增断言：模块源码不含 `SUGGESTIONS`、不含 `suggestion`（防复活）。
2. `tests/frontend/p1-amc-parity.test.mjs`：删除「P2: suggestion chips align with AMC suggestion chip tokens」整组断言（随功能退役）。
3. 新增轻量回归断言（放入 `p1-amc-parity.test.mjs`）：`index.html` 不含 `suggestion-chip`。
4. i18n 覆盖测试自动校验 zh/en 键集一致。
5. 全量 `npm run test:frontend` 回归；已知遗留失败（settings-modal untrusted fields，用户 WIP 所致）不计入。

## 4. 部署

提交后 `npm run build && docker compose up -d --build`；校验容器 healthy、首页 200、线上 HTML 无 `suggestion-chips`、线上 bundle 解码无 `composer.suggestion` 键。生成物不入 commit（沿用仓库惯例）。

## 5. 权衡记录

- 不拆模块：剥离后剩余两块职责仍小而内聚，拆分属过度重构。
- `selectedIndex` 留在模块内：slash 菜单键盘导航仍在用。
- 上轮刚做的 chips AMC 样式对齐（commit ce0a4f1 中相关部分）随之退役——功能优先于样式投入。
