# Composer 展开功能对齐 AMC 设计

- 日期：2026-08-26
- 状态：已获用户批准（完整复刻：角标 + 内联展开 + 拖拽手柄）
- 参考：AMC-WebUI `src/components/chat/input/useChatInputExpandSizing.ts`、`ChatInputExpandCorner.tsx`、`useResizeDrag.ts`、`ChatInputArea.tsx`

## 背景与目标

JustSearch 输入框目前只有「随内容自动长高（≤150px）」。本轮把 AMC 的 composer 展开交互完整移植为 vanilla 实现，行为与视觉对齐：

## 交互规格（AMC 数值逐项对齐）

1. **右上角角标**（32px 热区，top/right 1px）：常显 12px 圆角弧线（text-primary 60%、上/右 1.5px 描边、圆角 16px、70% 不透明度）；hover/focus-within 时弧线缩放 0.5 并消失，浮现 22px 圆形按钮（lucide Maximize2/Minimize2 12px 图标；初始 translate(10px,-10px) rotate(-8°) scale(.8) 归位过渡 300ms）；hover 背景 bgTertiary/80
2. **内联展开**：高度动画到 `max(220px, 50vh)`；收起回自然内容高度（cap `max(220px, 40vh)`）；transition `height 260ms cubic-bezier(0,0,0.2,1)`；拖拽中禁用过渡；展开时 textarea height:100% + overflow-y:auto
3. **顶边拖拽手柄**：外壳顶边 left/right 16px、高 8px、`row-resize`；拖动设手动高度 clamp(26px, 展开最大值)；从展开态拖动先退出展开；键盘 ↑/↓ ±16px、Home/End 最小/最大；`role="separator"` + aria-value* 同步；拖拽期间 body 锁 cursor/user-select，`document.hidden` 自动取消；手柄顶部 2px 可视条 hover 显现（accent 20%→focus 40%→resizing 35%）
4. **联动**：展开或手动高度 ⇒ `.input-box.expanded` 类 + `textarea.dataset.customHeight="true"`；`chat.js` 的 `autoResizeInput/resetInputHeight` 在自定义高度时让位；发送后保持当前高度仅清空文本；textarea 右 padding 补 `pr-9`(36px) 避让角标

## 实现层

| 文件 | 改动 |
|---|---|
| `backend/static/index.html` | `.input-box` 内加手柄 div、角标容器（双 SVG）、`#composer-editor-frame` 包裹 textarea |
| `backend/static/js/modules/composer-expand.js` | 新模块：状态机（expanded/manualHeight/animatedHeight）+ rAF 动画 + 鼠标拖拽 + 键盘 + 导出 `isComposerCustomHeight()` |
| `backend/static/js/modules/chat.js` | import 新模块并在 setup 区调用；两处高度函数加让位判断 |
| `backend/static/css/sections/input-modal.css` | 角标/手柄/frame 样式，全部 `var(--theme-*)` token |
| `locales/zh.js` / `en.js` | `inputArea.expand/collapse/resizeHandle` 三组 key |
| `tests/frontend/composer-expand.test.mjs` | jsdom：toggle、键盘步进、鼠标拖拽、clamp 下限 |

## 明确不做

全屏遮罩模式（AMC 即内联展开）；移动端单独布局；`prefers-reduced-motion` 分支（AMC 未处理，保持一致）。

## 错误处理

模块对缺失 DOM 元素静默返回 null；重复初始化幂等（dataset 哨兵）。纯前端交互改动，单点回滚。
