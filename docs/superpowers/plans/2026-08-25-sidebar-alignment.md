# Sidebar AMC Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 侧边栏按钮样式与图标完全对齐 AMC HistorySidebar/SidebarActions。

**Architecture:** 仅改 `backend/static/index.html` (图标) 与 `backend/static/css/sections/sidebar.css` (+ `base.css` 变量)，保持现有 JS/数据流；构建后 `style.css` 自动内联。

**Tech Stack:** HTML/CSS, vanilla JS, `npm run build` (esbuild + tailwind), Docker Compose 验证。

## Global Constraints

- 单一代码路径，无主题分叉；复用 `var(--theme-bg-secondary/tertiary/border-primary/text-primary)`。
- 图标 stroke 统一 `2` / 主操作 `2.2`，`viewBox 0 0 24 24`，`fill none stroke currentColor round`。
- 构建必过：`npm run build` 无报错；`style.css` 含变更。

---

## File Structure

- Modify: `backend/static/index.html:106-126` — 新对话图标从铅笔改为气泡+号
- Modify: `backend/static/css/sections/sidebar.css` — 按钮/胶囊/尺寸/底部
- Modify: `backend/static/css/sections/base.css:188` — `--sidebar-width: 272px → 256px` (可选，sidebar.css 已固定 272，需同步)
- Build: `backend/static/css/style.css` — 产物验证

### Task 1: Icon Alignment — 新对话气泡+号

**Files:**
- Modify: `backend/static/index.html:106-108`
- Test: 手工对比 AMC `GeneralIcons.tsx IconNewChat` 渲染

**Interfaces:**
- Consumes: AMC `IconNewChat` 路径
- Produces: HTML 内联 SVG 供后续样式任务复用

- [ ] **Step 1: 读取当前图标并确认替换点**

Read: `backend/static/index.html:106-108` 当前为 `<path d="M12 3H5..."><path d="M18.375...">`

- [ ] **Step 2: 替换为 AMC IconNewChat**

```html
<svg class="icon-svg" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g transform="translate(12 12) scale(1.1) translate(-12 -12)"><path d="M13 4H6a2 2 0 0 0-2 2v13l4-3h10a2 2 0 0 0 2-2v-3"/><path d="M18 3.5v5"/><path d="M15.5 6h5"/></g></svg>
```

同时校验 `#mini-new-chat-btn` 同步替换（同一文件 147-148）。

- [ ] **Step 3: 验证 HTML 可解析**

Run: `node --check /Volumes/WD_BLACK/Code/JustSearch/backend/static/index.html` 或直接 `npm run build` 不报错

- [ ] **Step 4: Commit**

```bash
git -C /Volumes/WD_BLACK/Code/JustSearch add backend/static/index.html
git -C /Volumes/WD_BLACK/Code/JustSearch commit -m "feat(sidebar): align new-chat icon to AMC bubble+plus"
```

### Task 2: Button Styles — 去渐变统一为 AMC 行样式

**Files:**
- Modify: `backend/static/css/sections/sidebar.css:245-312`
- Test: `npm run build` + 视觉 `hover:bg-tertiary` 校验

**Interfaces:**
- Consumes: Task1 的图标尺寸
- Produces: 统一的行按钮样式供 Task3/5 复用

- [ ] **Step 1: 移除主按钮渐变与阴影**

```css
.new-chat-btn,
.history-search-btn,
.new-group-btn {
    width: 100%;
    background: transparent;
    border: none;
    color: var(--sb-text-primary);
    padding: 0 12px;
    height: 36px;
    border-radius: 10px; /* AMC rounded-lg */
    gap: 12px;
    font-size: 14px;
    font-weight: 500;
    box-shadow: none;
    transform: none;
}
.new-chat-btn { font-weight: 500; }
.new-chat-btn:hover, .history-search-btn:hover, .new-group-btn:hover {
    background-color: var(--sb-bg-hover);
    color: var(--sb-text-primary);
    box-shadow: none;
    transform: none;
    filter: none;
}
.new-chat-btn .icon-svg { color: var(--sb-icon); }
.new-chat-btn:hover .icon-svg { color: var(--sb-text-primary); }
```

删除原 `.new-chat-btn { background: var(--primary-gradient); color:#fff; box-shadow ... }` 及 `:active` 的 `brightness`。

- [ ] **Step 2: 保留搜索框态不变，确认图标色**

保持 `.history-search-box` 现有 `bg-primary/border-secondary/shadow-sm focus-within:border-focus`。

- [ ] **Step 3: 构建验证**

Run: `npm run build --prefix /Volumes/WD_BLACK/Code/JustSearch`

Expected: PASS，`backend/static/dist/css/style.css` 含 `background: transparent` for `.new-chat-btn`

- [ ] **Step 4: Commit**

```bash
git -C /Volumes/WD_BLACK/Code/JustSearch add backend/static/css/sections/sidebar.css
git -C /Volumes/WD_BLACK/Code/JustSearch commit -m "feat(sidebar): unify action rows to AMC transparent hover"
```

### Task 3: Kbd Capsule + Footer + Dimensions

**Files:**
- Modify: `backend/static/css/sections/sidebar.css:341-376, 842-872, 4-76`
- Modify: `backend/static/css/sections/base.css:188`
- Build: `backend/static/css/style.css`

**Interfaces:**
- Consumes: Task2 行高/间距
- Produces: 完整 AMC 侧边栏视觉

- [ ] **Step 1: Kbd 胶囊化**

```css
.sidebar-kbd {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    opacity: 0;
    transition: opacity var(--transition-fast);
    pointer-events: none;
}
.sidebar-kbd, .sidebar-kbd kbd {
    height: 20px;
    min-width: 20px;
    padding: 0 4px;
    border-radius: 6px;
    border: 1px solid var(--theme-border-secondary);
    background: var(--theme-bg-tertiary);
    color: var(--theme-text-tertiary);
    font-family: inherit;
    font-size: 11px;
    font-weight: 500;
    line-height: 1;
}
.new-chat-btn:hover .sidebar-kbd,
.history-search-btn:hover .sidebar-kbd,
.new-group-btn:hover .sidebar-kbd { opacity: 1; }
```

将原 `min-width:28px transparent` 替换。若当前为单文本 `⌘N`，保留文本，样式自动胶囊化（无需改为多 kbd）。

- [ ] **Step 2: 底部设置按钮 AMC 化**

```css
.sidebar-footer-settings-btn {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px; /* py-2.5 px-3 */
    border-radius: 12px; /* rounded-xl */
    font-weight: 500;
}
.sidebar-footer-settings-btn:hover { background-color: var(--sb-bg-hover); }
.sidebar-footer-settings-btn:active { transform: scale(0.98); }
.sidebar-footer-settings-btn .icon-svg { width: 20px; height: 20px; stroke-width: 2.2; }
```

- [ ] **Step 3: 宽度对齐 AMC**

```css
/* base.css */
--sidebar-width: 256px; /* was 272px */
```
```css
/* sidebar.css */
#sidebar { width: var(--sidebar-width); }
#sidebar.collapsed { width: 52.2px; } /* was 60px */
.sidebar-expanded-pane { width: 256px; }
.sidebar-collapsed-pane { gap: 8.96px; /* 0.56rem */ }
.sidebar-collapsed-pane .mini-btn { width: 40px !important; height: 40px; border-radius: 8px; }
```

- [ ] **Step 4: 构建与手工验证**

Run: `npm run build --prefix /Volumes/WD_BLACK/Code/JustSearch`
Run: `env PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin /usr/local/bin/docker compose -f /Volumes/WD_BLACK/Code/JustSearch/docker-compose.yml up -d --build` （若需部署）
Expected: `http://127.0.0.1:8001` 侧边栏展开 256px、折叠 52px、hover 灰底、kbd 胶囊显隐正常

- [ ] **Step 5: Commit**

```bash
git -C /Volumes/WD_BLACK/Code/JustSearch add backend/static/css/sections/sidebar.css backend/static/css/sections/base.css
git -C /Volumes/WD_BLACK/Code/JustSearch commit -m "feat(sidebar): kbd capsule + footer + width 256/52.2 align AMC"
```

## Self-Review

- Spec coverage: 5 小节均有任务对应（图标→T1，按钮→T2，kbd/底部/尺寸→T3）。
- Placeholder scan: 无 TBD/TODO，均为可执行代码块。
- Type consistency: CSS 变量均引用现有 `theme` 与 `sb-*`，无新类型。
