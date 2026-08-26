# Composer 输入框 AMC 对齐（第二轮）设计

- 日期：2026-08-26
- 状态：已获用户批准（范围 + 设计均确认）
- 参考：AMC-WebUI `src/components/chat/input/chatInputAreaLayout.ts`、`area/ChatTextArea.tsx`、`actions/SendControls.tsx`、`src/constants/buttonClasses.ts`、`src/constants/designTokens.ts`

## 背景与目标

P1 已将 JustSearch composer 的 token（颜色、44rem 宽度、padding、textarea 高度）对齐 AMC，但遗留若干与 AMC 实际实现不一致的视觉细节。本轮把用户选定的范围——**外壳 + 文本域 + 发送按钮**——收敛到 AMC 当前实现，不引入 React，不改架构。

## 范围

**改**：`.input-box` 外壳几何/阴影/聚焦/过渡；`#send-btn` 尺寸/配色/状态；相关 token。
**不改**：搜索强度条、建议 chips、工具栏文字按钮、下拉菜单（JustSearch 特有或已对齐）；文本域字号与高度（已一致）。

## 变更明细

### 1. 外壳 `.input-box`（input-modal.css）

| 属性 | 现值 | 改为（AMC 值） |
|---|---|---|
| `--amc-radius-lg`（#input-area 内） | `1.625rem` | `1.25rem`（AMC `rounded-[20px]`；该 scope 内仅 `.input-box` 使用） |
| `--amc-composer-shadow` | `var(--shadow-md)` | `0 8px 30px rgba(0,0,0,0.06)` |
| 过渡 | 部分属性 0.15s ease | `all 0.2s ease-in-out` |
| `:focus-within` 阴影 | `0 0 0 2px` ring + background-color | `0 8px 30px rgba(0,0,0,0.08)`，无 ring，无背景变化 |

删除 `[data-theme="dark"] .input-box` 与 `[data-theme="dark"] .input-box:focus-within` 的阴影覆盖（深浅同值后冗余）。编辑横幅的边框/阴影规则保持不变。

### 2. 文本域 `#user-input`

无改动。16px 字号、26px 初始高、150px 上限、placeholder 色均已对齐。右侧不留 AMC `pr-9`（JustSearch 无展开角标）。

### 3. 发送按钮 `#send-btn`

对齐 `SendControls.tsx` + `CHAT_INPUT_BUTTON_CLASS`：

- 尺寸 40px → **34px**
- 新增 token（#input-area scope）：浅色 `--amc-send-bg:#3964FE`、`--amc-send-bg-hover:#3358e0`；深色 `#679EFE` / `#5a8de0`。graphite 沿用主题 accent（现状）
- hover 由 `filter: brightness` 改为背景色切换；移除彩色光晕 box-shadow 与 `translateY(-1px)` 上浮
- 停止态（`.processing`）：危险色**圆形**，删除 border-radius 方块变形；保留 send/stop 图标交叉淡入
- 新增 `:focus-visible` ring（对应 AMC `FOCUS_VISIBLE_RING_INPUT_OFFSET_CLASS`：2px focus 色 + offset）
- 删除编辑态琥珀色覆盖（AMC 编辑时按钮仍为主题蓝，仅 aria/title 文案变化）

### 4. 测试与构建

- 更新 `tests/frontend/p1-amc-parity.test.mjs`：radius 断言由 `1.625rem|26px|18px` 改为 `1.25rem|20px`；新增 composer 阴影字符串、发送按钮 34px 与 send 配色 token 断言
- 全量 `npm run test:frontend` 保持绿灯
- `npm run build` 重新生成 `css/style.css` 与 `dist/`

## 错误处理 / 回滚

纯 CSS 视觉变更，无 JS 行为改动；单 commit 提交，可整体 revert。

## 明确的偏差（有意为之）

1. 文本域右 padding 不设 `pr-9`（无展开角标）
2. 工具栏文字 pill 按钮保留（AMC 对应位置为纯图标钮，但 JustSearch 承载引擎名/桥接状态等更多信息，改动属「整个 Composer 区域」范围，本轮不做）
