# 设计：输入框预设按钮 AMC 样式对齐（纯 CSS）

- 日期：2026-08-26
- 状态：已批准（用户确认范围 = 搜索强度档位 + 建议问题 chips；实现方式 = 纯 CSS）
- 前序文档：`2026-08-26-composer-input-amc-alignment-design.md`（外壳/文本域/发送按钮）、`2026-08-26-composer-expand-amc-design.md`（展开功能）

## 1. 目标与范围

把 JustSearch 输入框区域两组带文字的预设按钮的视觉样式对齐到 AMC-WebUI：

1. **搜索强度档位**（快速 / 均衡 / 深入 / 研究，`.search-intensity-presets` + `.intensity-chip`）
   → 对齐 AMC `ToolbarSegmentedControl`（`src/components/chat/input/toolbar/ToolbarSegmentedControl.tsx` + `constants/designTokens.ts` 的 `TOOLBAR_SEGMENTED_TRACK_CLASS` / `TOOLBAR_SEGMENT_IDLE_CLASS` / `TOOLBAR_SEGMENT_ACTIVE_CLASS`）。
2. **建议问题 chips**（`.suggestion-chip`）
   → 对齐 AMC `SUGGESTION_CHIP_CLASS`（`constants/designTokens.ts`）。

**明确不做**：DOM 结构、任何 JS/i18n 改动；工具栏按钮（桥接状态 / 搜索引擎 / Live Artifacts）；滚动箭头；「搜索强度」左侧标签与右侧 hint 文案；chips 的 active 态（一次性发送，无选中概念）。

## 2. AMC 参照值（source of truth）

分段控件（designTokens.ts L49–L56）：

```
track   = h-9 inline-flex items-center gap-0.5 rounded-lg
          border border-[--theme-border-secondary] bg-[--theme-bg-input] p-0.5
segment = h-full inline-flex items-center justify-center gap-1.5 rounded-md px-2.5
          text-xs font-medium whitespace-nowrap transition-colors
          focus:outline-none focus-visible:ring-2 ring-inset ring-[--theme-border-focus]
idle    = segment + text-[--theme-text-tertiary]
          hover:bg-[--theme-bg-tertiary]/70 hover:text-[--theme-text-primary]
active  = segment + bg-[--theme-bg-accent]/12 text-[--theme-text-primary] shadow-sm
```

建议问题 chips（designTokens.ts L27, L30）：

```
chip     = flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3 py-2.5 sm:py-2 rounded-lg border
           text-xs sm:text-sm font-medium whitespace-nowrap transition-colors + 同款 inset focus ring
default  = border-[--theme-border-secondary]/70 bg-[--theme-bg-tertiary]/35
           text-[--theme-text-secondary]
hover    = bg-[--theme-bg-tertiary] text-[--theme-text-primary]
           border-[--theme-border-focus]
```

换算：h-9=36px、p-0.5/gap-0.5=2px、rounded-lg=8px、rounded-md=6px、px-2.5=10px、px-3=12px、py-2=8px、py-2.5=10px、text-xs=12px、text-sm=14px、shadow-sm=`0 1px 2px rgba(0,0,0,0.05)`、accent/12=`color-mix(in srgb, var(--amc-accent) 12%, transparent)`、inset ring=`inset 0 0 0 2px var(--amc-border-focus)`。

Token 映射（沿用本文件头部已定义的 `#input-area` 调色板）：AMC `bg-input → --amc-bg-input`、`bg-tertiary → --amc-btn-hover`（注释即 bgTertiary）、`border-secondary → --amc-border`、`border-focus → --amc-border-focus`、`text-* → --amc-text-*`。全部颜色经 `--amc-*` 解析，graphite/dark 由既有主题块自动生效。

## 3. 改动明细（仅 `backend/static/css/sections/input-modal.css`）

### 3.1 档位轨道 `.search-intensity-presets`

| 属性 | 现值 | 新值 |
|---|---|---|
| border-radius | 9999px | `8px` |
| padding | 3px | `2px` |
| gap | 4px | `2px` |
| background | btn-hover 80% 混合 | `var(--amc-bg-input)` |
| border | color-mix(border 70%) | `1px solid var(--amc-border)` |

保留 `inline-flex / align-items / flex-wrap`（窄屏换行回退）。

### 3.2 档位片段 `.intensity-chip`

- 圆角 `9999px → 6px`；改为定高 `height: 32px; padding: 0 10px`（轨道自然总高 36px ≙ h-9）；字重恒为 500。
- 未选中文字色 `secondary → var(--amc-text-tertiary)`。
- hover：`background: color-mix(in srgb, var(--amc-btn-hover) 70%, transparent)`，文字升 `var(--amc-text-primary)`。
- **选中态 `.active` 重做**：`background: accent 12% 染色`、`color: var(--amc-text-primary)`、`box-shadow: 0 1px 2px rgba(0,0,0,0.05)`、边框保持 transparent。删除旧的实心底+描边+600 字重规则。
- **删除** `.intensity-chip.active[data-intensity="research"], .intensity-chip.active[data-intensity="deep"]` 强调色特例（AMC 所有片段统一），以及随之失效的 `.intensity-chip-custom.active` 覆盖。
- `focus-visible`：改为 `outline: none; box-shadow: inset 0 0 0 2px var(--amc-border-focus)`。
- `:disabled { cursor: not-allowed }` 不变。

### 3.3 建议 chips `.suggestion-chip`

同时把该块内颜色从裸 `--theme-*` 切到 `--amc-*`（与整个 composer 区域一致，graphite 自动跟随）：

- 移动端内边距 `6px 10px → 10px 10px`（触控目标）；≥640px 覆盖 `8px 13px → 8px 12px`，并新增桌面端 `gap: 6px`。
- 默认底色 `--theme-bg-tertiary 35% → --amc-btn-hover 35% 混合`；默认边框 `--theme-border-secondary 70% → --amc-border 70% 混合`；文字 `--amc-text-secondary`。
- hover：底 `var(--amc-btn-hover)`、文字升 `var(--amc-text-primary)`、边框 `→ var(--amc-border-focus)`。
- 新增 `:focus-visible { outline:none; box-shadow: inset 0 0 0 2px var(--amc-border-focus); }`。
- 图标色 / 文本省略 / 过渡曲线不变；不引入 active 样式。

### 3.4 颜色纪律

新增硬编码只允许：`rgba(0,0,0,0.05)`（shadow-sm）与 `8px/6px/32px` 几何值；颜色一律走既有 `--amc-*` / `--theme-*` token，且仅落在 `#input-area` 作用域文件内。

## 4. 测试策略

TDD（先红后绿）。扩展 `tests/frontend/p1-amc-parity.test.mjs`：

- 轨道块含 `border-radius: 8px`、`background: var(--amc-bg-input)`、`gap: 2px`、`padding: 2px`；
- 片段块含 `height: 32px`、`border-radius: 6px`、`padding: 0 10px`；
- `.intensity-chip.active` 含 accent 12% color-mix 与 shadow-sm；不再含旧实心 `var(--amc-bg-input)` 底（轨道的 bg-input 断言按选择器块切片，二者不冲突）；
- 全文不含 `[data-intensity="research"]` 与 `.intensity-chip-custom.active` 规则；
- `.suggestion-chip:hover` 含 `var(--amc-border-focus)`；存在 `.suggestion-chip:focus-visible` inset ring；移动端 `10px 10px`、桌面 `8px 12px`。

断言按选择器块切片匹配，避免 `9999px`（滚动箭头等仍在使用）误报。

## 5. 交付与部署

提交拆分：① 测试（红）② CSS 实现（绿）共用一次 commit 亦可，沿用仓库惯例直接落 `main`。完成后 `npm run build && docker compose up -d --build`，校验容器 healthy、首页 200、新 CSS 版本参数含新规则后向用户汇报。生成物（style.css/dist）继续留在工作区不入镜像提交，待用户 WIP 合流后统一重建。

## 6. 权衡记录

- 定高 32px 片段替代「padding 撑高」：与 AMC h-full 语义一致，避免字体行高漂移导致总高偏离 36px。
- 删除 research/deep 特例是**有意的行为变化**：AMC 分段控件无分级强调，统一染色即对齐语义。
- 不改 DOM/类名：现类名已被 i18n 钩子、JS 状态机（aria-checked 切换）与既有测试引用，改名收益为零、回归面大。
