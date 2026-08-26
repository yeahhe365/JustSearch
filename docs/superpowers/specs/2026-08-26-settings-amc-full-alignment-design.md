# 设计：设置界面全量对齐 AMC

- 日期：2026-08-26
- 状态：已批准（用户确认：全量对齐 = 纯样式 6 项 + 分段控件 + 常驻内容标题栏）
- AMC 参照：`SettingsModal.tsx` / `SettingsSidebar.tsx` / `SettingsContent.tsx`、`sections/AppearanceSection.tsx` + `appearance/FontSizeControl.tsx`、`constants/designTokens.ts` L66–96、`constants/buttonClasses.ts` L11。

## 1. 目标与原则

JustSearch 设置弹窗此前已做过布局级对齐（256px 侧栏 / 768px 内容列 / 搜索）。本轮消除剩余 8 处视觉/结构差距。原则：功能与既有测试行为不变——搜索锚点类名不动，保存状态胶囊保留（JustSearch 特有），i18n 不新增键。

## 2. 设计令牌映射（AMC → JustSearch CSS）

| AMC class | 换算值 | 用途 |
|---|---|---|
| `SETTINGS_NAV_ACTIVE_CLASS` | accent/10 染色、text-primary、font-medium(500) | 侧栏激活项 |
| `SETTINGS_NAV_IDLE_CLASS` | text-secondary、hover bg-tertiary/50 | 侧栏未激活 |
| `SETTINGS_SEARCH_INPUT_CLASS` | h-40px、rounded-lg(8px)、无边框、bg-tertiary/45、hover /70、focus 实底 + 内嵌 ring border-focus/35 | 侧栏搜索框 |
| `SETTINGS_SECTION_CARD_CLASS` | rounded-xl(12px)、border-secondary/60、bg-secondary/35、p-16px | 设置分组卡片 |
| `SETTINGS_SECTION_LABEL_CLASS` | 12px semibold 大写 tracking-wider text-secondary | 卡片组标签 |
| `SETTINGS_VALUE_BADGE_CLASS` | rounded-md(6px)、bg-tertiary、px-8 py-2、mono tabular-nums、text-primary | 数值徽标 |
| `SETTINGS_SEGMENTED_TRACK/ACTIVE/IDLE` | 轨道 rounded-lg border-secondary bg-tertiary/50 p-4px gap-2px；片段 px-12 py-6 12px medium rounded-md(6px)；选中实心 accent+反白字+shadow-sm；未选 text-secondary hover 升 primary | 主题/语言切换 |
| `MODAL_CLOSE_BUTTON_CLASS` | p-6px、rounded-full、text-tertiary hover primary/bg-tertiary | 内容区右上关闭钮 |

颜色一律走 `--theme-*` / 既有变量；accent 染色用 `color-mix(in srgb, var(--theme-bg-accent) 10%, transparent)` 形式。硬编码仅限几何值。

## 3. 改动明细

### 3.1 侧栏（纯 CSS，`input-modal.css`）
- `.settings-tab-btn.active`：`background: var(--bg-elevated); font-weight:600` → `color-mix(accent 10%)` + 字重 500。
- `.settings-tab-btn:hover`：混合底 → `color-mix(var(--theme-bg-tertiary) 50%, transparent)`。
- `.settings-tab-btn .material-symbols-rounded/svg`：`color: var(--text-muted)` → `var(--theme-text-primary)`（AMC 图标常驻 primary）。
- `.settings-search`：去边框（`border-color: transparent`）、`bg-input → color-mix(tertiary 45%)`、圆角 10→8px、高度 40px；`:focus-within` 改为内嵌 ring（`box-shadow: inset 0 0 0 2px color-mix(border-focus 35%)` + 底色升 tertiary 实底）；hover 底色 /70。
- 桌面隐藏侧栏关闭钮：`.settings-sidebar-header .settings-sidebar-close-btn { display:none }` 于 `min-width: 769px`；现有移动端断点行为保持（≤768px 显示）。

### 3.2 内容区头部（HTML + JS）
- `index.html`：`.settings-main` 内、`.settings-panels` 之前新增：

```html
<div class="settings-content-header">
    <h2 id="settings-content-title" class="settings-content-title" data-i18n="settings.tabs.general">常规设置</h2>
    <button type="button" id="settings-close-btn" class="settings-content-close" data-i18n-aria-label="modal.close" aria-label="关闭设置">
        <span class="material-symbols-rounded" aria-hidden="true">close</span>
    </button>
</div>
```

- `settings-modal.js`：tab 切换处把激活 tab 文案写入 `#settings-content-title`；绑定 `#settings-close-btn` click → 关闭弹窗（复用现有 close 路径）。初始文本随默认 tab。
- `.settings-content-header`：flex、底部无描边（AMC 无分割线）、`padding: 16px 32px 0`；`.settings-content-title` 20px semibold primary truncate。
- `.settings-panels` padding `32px 36px 28px` → `16px 32px 32px`。
- 关闭按钮样式按 MODAL_CLOSE 映射表；focus-visible ring-offset。

### 3.3 面板标题改造（HTML 移位 + CSS 重样式）
- 各 `.settings-section-heading` 从 `.settings-card` 外移入卡内作为首子元素；删除 `.settings-section-kicker` 元素（其文本已由 `panel-header-title` 承担，`data-i18n` 键保留在 title 上）。
- `.panel-header-title` 样式改为组标签：20px/650 primary → 12px/650 uppercase letter-spacing 0.08em secondary；margin 清零。
- `api-settings-heading` 行内右侧的保存状态胶囊**保留**：heading 移入卡片后与胶囊构成卡头 flex 行（`justify-content: space-between`），不使用绝对定位。
- `settings-search.js` **零改动**：索引仍扫 `.settings-section-heading > .panel-header-title`，reveal 滚动目标仍为 heading 元素。

### 3.4 卡片化与排版（CSS）
- `.settings-card`：`background: transparent; gap:10px` → `background: color-mix(in srgb, var(--theme-bg-secondary) 35%, transparent); border: 1px solid color-mix(in srgb, var(--theme-border-secondary) 60%, transparent); border-radius: 12px; padding: 16px;`
- `.settings-card` 与相邻元素间距由面板 `gap: 22px → 24px`；卡内 field row padding `14px → 12px 0`。
- `.settings-font-size-value`：纯文本 → 徽标样式（映射表 VALUE_BADGE 列）。
- `.field-desc/.toggle-desc` 保持 12px muted（AMC 一致）。

### 3.5 主题/语言分段控件（HTML + JS + CSS）
- HTML：`#theme-select`、`#language-select` 各替换为一组：

```html
<div class="settings-segmented" id="theme-segmented" role="radiogroup" data-settings-key="theme" aria-label="主题">
    <button type="button" class="settings-segment" role="radio" aria-checked="true" data-value="light">浅色</button>
    <button type="button" class="settings-segment" role="radio" aria-checked="false" data-value="dark">深色</button>
    <button type="button" class="settings-segment" role="radio" aria-checked="false" data-value="graphite">中性灰</button>
    <button type="button" class="settings-segment" role="radio" aria-checked="false" data-value="auto">跟随系统</button>
</div>
```

语言同理（容器 id `language-segmented`，3 值 zh/en/auto），文案沿用现 option 的 i18n 键（静态 option 无键者补 `data-i18n`，两语言包同步——若发现缺失才新增）。

- JS：新建小模块 `backend/static/js/modules/settings-segmented.js` 导出 `getSegmentedValue(key)` / `setSegmentedValue(key, value)` / `initSegmentedGroups({ onChange })`（读写容器内按钮的 `aria-checked`；键盘 ←→/Home/End；change 回调驱动既有保存流程）。放独立模块避免 settings-modal.js ↔ sidebar.js 循环导入。
- `settings-modal.js`：引入该模块并初始化两组；替换 4 处 select 读写点（L363 注册列表、L391 change 绑定、L540–541 表单回填、L619 收集值）。
- `sidebar.js:269`：外部主题同步点改调 `setSegmentedValue('theme', …)`。
- CSS：轨道/片段按映射表；片段 `:focus-visible` 外圈 ring（`outline:none + box-shadow 0 0 0 2px var(--theme-border-focus)`）。

### 3.6 明确不改
保存状态胶囊逻辑、engine-check/provider 卡片内部、快捷键页、关于页结构、所有后端交互。

## 4. 测试策略（TDD）

1. `p1-amc-parity.test.mjs` 新增「P2: settings surface aligns with AMC」组：
   - 激活项规则含 accent 10% color-mix 且不含 `--bg-elevated`；
   - `.settings-card` 含 12px 圆角 + border 60% + bg 35%；
   - `.panel-header-title` 含 uppercase + letter-spacing 且字号 12px；
   - `.settings-font-size-value` 含 mono/tabular；
   - `.settings-search` 含 tertiary 45% 与 inset ring；
   - `.settings-content-header` 存在于 index.html、panels padding 16px 顶部；
   - `.settings-segment[aria-checked="true"]` 含实心 accent 底 + 反白文字色。
2. jsdom 新用例（settings-modal 相关文件）：分段组点击/ArrowLeft/Right 更新 `aria-checked` 并写入设置对象；tab 切换后 `#settings-content-title` 文本更新。
3. 现有 `settings-modal.test.mjs`、`settings-search`、`shortcuts-help` 用例全部保绿（除已知遗留失败 settings-modal untrusted fields——用户 WIP 所致，不计入）。

## 5. 部署

提交拆分：①测试红 ②实现绿（可合并为一个 commit）③收尾修复单独 commit。`npm run build && docker compose up -d --build`；校验 healthy、首页 200、新 CSS 版本参数变化且含新规则、JS chunk 含分段组件标记。生成物不入 commit。

## 6. 权衡记录

- kicker 删除但 heading 结构保留：搜索锚点兼容优先，视觉由 CSS 全权接管。
- 侧栏桌面关闭钮隐藏而非删除 DOM：移动端复用同一按钮，避免双份接线。
- 分段控件不抽公共模块：仅两组使用，YAGNI；工具函数放 settings-modal.js 内并导出给 sidebar.js 复用。
- 保存状态胶囊是 JustSearch 特有功能，AMC 无对应物——保留原位仅微调容器样式。

---

## 附录：第二轮补齐（用户反馈「还不够复刻」，2026-08-26 批准：八项全补）

| # | 差距 | 补齐方案 |
|---|---|---|
| A1 | 下拉框形态 | 新模块 `settings-dropdown.js` 对原生 `<select>` 做**渐进增强**：隐藏原 select（保留 DOM 与 change 事件），渲染 trigger 按钮 + 浮层 listbox。trigger=bg-input+border-secondary+hover 边框 focus 色+chevron 旋转；面板=bg-secondary、rounded-xl(12px)、shadow-premium 级阴影、p-4px、选项 hover tertiary/50、选中项 accent/10 底。`fillSettingsForm` 写值后调用 `syncFromSelect` 回读 |
| A2 | 内容头位置 | 移入 `.settings-panels` 滚动容器内部作首子元素，宽 `var(--amc-content-width)` 居中随内容滚动；panels 顶部 padding 归零由头部自带 |
| A3 | 卡内行分隔 | `.settings-card` 内相邻字段行之间加 1px 分隔线（border-secondary/40），即 AMC divide-y |
| A4 | Toggle 开关 | 44×24 轨道不变；关底 `--border → theme-bg-tertiary`、开底 `--primary → theme-bg-accent`、拇指白色 16px 加 shadow、focus-visible ring-offset-secondary |
| A5 | 滑杆 | 轨道 6px 高、`theme-border-secondary` 底、圆角；thumb accent 圆点白边 shadow；focus-visible ring |
| A6 | 导航分组 | tabs 拆三组容器：常规+模型+桥接+数据管理 ／ 快捷键 ／ 关于，组间 gap 14px |
| A7 | 细滚动条 | `.settings-tabs/.settings-panels/.settings-search-results` 用 5px webkit 滚动条 + `scrollbar-color: var(--theme-scrollbar-thumb, …) transparent`，hover 变 focus 色 |
| A8 | 搜索结果面板 | 容器改 bg-secondary+rounded-xl+divide 行；行 padding 10px→12px 16px、hover tertiary/50；tab 徽标大写 xs secondary |
