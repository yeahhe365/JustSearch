# Sidebar Alignment — AMC Parity Design

Date: 2026-08-25
Status: Approved
Scope: `backend/static/index.html` + `backend/static/css/sections/sidebar.css` (→ `style.css` build)

## Context
JustSearch 侧边栏按钮样式与图标与 AMC `HistorySidebar` / `SidebarActions` / `sidebarStyles.ts` 存在偏差：新对话为渐变主按钮而非透明 `SIDEBAR_ACTION_ROW_CLASS`，图标为铅笔而非气泡+号，kbd 为纯文本而非胶囊，折叠宽度 60px vs 52.2px，设置按钮为 `rounded12 py10` 而非 `rounded-xl py2.5`。

## Goals
- 完全复刻 AMC 侧边栏视觉与交互细节（用户已确认“完全复刻 AMC”）。
- 单一代码路径，无双主题分叉；与现有 `themeRegistry` 变量保持一致。

## Non-Goals
- 不新增侧边栏功能（拖拽、分组、近期弹窗已对齐，此次仅样式/图标）。
- 不改动 JS 逻辑与数据流。

## Design

### 1. Icons (HTML)
- **新对话**: `GeneralIcons.tsx IconNewChat` — `viewBox 0 0 24 24`，`strokeWidth 2.2`，含 `g transform scale1.1` 的气泡+十字路径，替换铅笔 `M12 3H5... + M18.375...`。
- **新建分组**: 保持 AMC `Folders` 双路径 (`M20 17a2...` + `M2 8v11...`)，已一致，仅确认 `stroke-width 2` 与 `data-testid="new-group-folder-icon"` 保留。
- **搜索 / 折叠 Toggle / 设置 齿轮 / 历史 时钟**: 已与 AMC `lucide Search/Settings/History` 一致，保留。
- 统一 `width 18 height 18`（主操作）与折叠态 `20` 保持 AMC `SidebarActions` 与 `MiniSidebarButton` 约定；strokeLinecap/linejoin round。

### 2. Button Styles (CSS)
源 `sidebarStyles.ts`：
```
SIDEBAR_ACTION_ROW_CLASS = group flex items-center gap-3 w-full text-left px-3 h-9 text-sm bg-transparent rounded-lg hover:bg-tertiary ...
SIDEBAR_ICON_BUTTON_CLASS = flex items-center justify-center p-2.5 rounded-lg text-primary hover:bg-tertiary ...
```
映射到 JustSearch：
- `.new-chat-btn, .history-search-btn, .new-group-btn` 重置为 `height 36px (h-9)`, `gap 12px (gap-3)`, `padding 0 12px (px-3)`, `bg transparent`, `border none`, `rounded 8-10px (≈ rounded-lg)`, `hover bg var(--sb-bg-hover)`，移除 `primary-gradient`、`box-shadow`、`brightness/transform`。
- 移除 new-chat 渐变/阴影，保留 `font-weight 500` 与 AMC 一致（非 600）。
- 搜索框态 `.history-search-box` 保持 `bg-primary border-secondary rounded-lg shadow-sm focus-within:border-focus ring-1` 与 AMC `SidebarActions` 搜索态一致。

### 3. Kbd Capsule
AMC `ShortcutHint`：`ml-auto inline-flex gap-1 opacity-0 group-hover:opacity-100` 内 `kbd h-5 min-w-5 rounded-md border border-secondary bg-tertiary px-1 text 11px text-tertiary`。
JustSearch `.sidebar-kbd` 从 `transparent` 文本改为上述胶囊，保留 `⌘N / ⌘K` 内容；hover 行为通过 `.new-chat-btn:hover .sidebar-kbd` 等控制显隐，折叠态 `mini-btn` 不显示 kbd。

### 4. Dimensions
- 展开宽度 `272px → 256px (w-64 / 16rem)`，与 `base.css --sidebar-width` 同步；折叠宽度 `60px → 52.2px`。
- 折叠容器 `.sidebar-collapsed-pane gap 12px → 0.56rem (8.96px)`，`py-4`，`mini-btn 40x40 p-2.5 rounded-lg`，divider `32px × 1px` 保持，底部 `mini-footer mt-auto`。

### 5. Footer Settings
- `.sidebar-footer-settings-btn` 调整为 `px-3 py-2.5 rounded-xl (12px)`，`gap 12px`，`hover bg-tertiary rounded-xl`，`active:scale 0.98`，图标 `20px stroke 2.2`，与 `HistorySidebar.tsx:529-537` 一致。

## Risks
- 去渐变后“新对话”不再视觉突出，用户可能需适应；已获确认。
- 宽度从 272px 缩至 256px，历史列表可用宽度略减，无功能影响。

## Verification
- 视觉对比 `AMC dist` 与 `http://127.0.0.1:8001` 侧边栏展开/折叠/hover/kbd显隐。
- 前端单测：history/sidebar 相关（如存在）通过；`npm run build` 无报错。
- 构建产物 `style.css` 含更新的 `.new-chat-btn` 与 `.sidebar-kbd`。
