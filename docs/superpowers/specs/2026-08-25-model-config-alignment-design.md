# Model Config Alignment with AMC — Design

**Date:** 2026-08-25
**Status:** Approved (4/4 sections confirmed)
**Scope:** Refactor JustSearch model configuration to AMC's global ModelSelector structure
**Approach:** Full backend + frontend structural alignment (frontend aggregation with backend migration)

## 1. Architecture Goal

JustSearch现状：`settings.providers[]` 每项含 `id, name, base_url, api_key, model_id(逗号分隔字符串)`，前端按 Provider 渲染折叠卡片，模型列表在卡片内编辑；`workflow_step_models` 按步骤存 `provider_id/model_id`。

AMC目标：全局 `availableModels[]`（`{id, name, isPinned, apiMode}`）+ 统一选择器 `ModelSelector`（`ModelListView` 只读 / `ModelListEditor` 编辑，含置顶、重名校验、重置）。

折中推荐（已否决，用户选择全量重构）：**前后端同步重构** — 前端聚合、后端新增持久化字段并迁移。

**决策：** 执行完整后端重构，前端 1:1 复刻 AMC 的 `ModelSelector` 交互，后端新增全局字段并兼容迁移。

## 2. Data Model (Backend)

新增 `settings.available_models: ModelOption[]`（全局），结构与 AMC 一致：
```ts
type ModelOption = {
  id: string;          // model id, required
  name: string;        // display name, defaults to id
  isPinned?: boolean;  // 置顶
  providerId?: string; // 关联的 provider id (JustSearch 扩展，AMC 用 apiMode)
  apiMode?: string;    // 保留 AMC 兼容字段，JustSearch 可映射 providerId
}
```

迁移策略：
- 读时：若 `available_models` 为空但 `providers[].model_id` 存在，则将后者按逗号拆分并转为 `ModelOption[]`（`isPinned` 默认 false，`providerId` 为原 provider 的 id），写入新字段并清空旧字符串（兼容期，保留读取兼容）。
- 写时：仅写 `available_models`，不再写 `providers[].model_id`；`providers` 保留 `id/name/base_url/api_key` 但不再含模型。
- `default_provider_id` 保留，但 `modelId` 的解析改为从 `available_models` 中查找（若找不到则 fallback 到 `available_models[0]`）。
- `workflow_step_models` 保持 `provider_id/model_id`，但校验时从 `available_models` 验证存在性（`providerId` + `id` 联合校验）。
- 提供 `GET /api/settings` 时同时返回 `providers` 与 `available_models`；`PUT` 时接受两者但以 `available_models` 为准。

文件：
- `backend/app/routers/settings.py` — `ProviderModel`/`SettingsUpdate` 新增 `available_models`，`normalize_providers` 新增迁移逻辑，`ensure_default_provider_id` 调整
- `backend/app/providers.py` — 新增 `normalize_available_models`、`migrate_legacy_models` 辅助
- `backend/static/js/modules/provider-catalog.js` — 新增 `buildAvailableModelsFromProviders` / `splitAvailableModelsToProviders` 转换
- `tests/test_settings_migration.py` — 迁移与校验单测

## 3. Frontend Components

在 `模型设置` Tab 内替换现有 Provider 卡片模型列表为 AMC 的 `ModelSelector` 结构：

- 顶部 `ModelSelectorHeader`（标题 + 编辑/完成切换，`isEditingList` 状态）
- 只读态 `ModelListView`（按 `isPinned` 排序、显示 `name/id`、选中态高亮、点击选择）
- 编辑态 `ModelListEditor`（每行 `id/name` 输入 + `isPinned` 开关 + `provider` 下拉 + 删除，底部 `添加模型` + `重置` + 校验信息 + `保存/取消`）
- 行组件 `ModelListEditorRow`（复刻 AMC 的 `Pin/PinOff/Trash2` 图标，`stroke 2`）
- 保留 Provider 的 `base_url/api_key` 编辑在独立的 `ProviderConfig` 子卡片（样式对齐 AMC 的 `ApiConfigSection`，卡片 + 输入 + 测试连接），与模型列表解耦
- `workflow_step_models` 保持现有 4 行下拉，但数据源改为全局 `available_models`，分组按 `providerId` 展示，校验改为基于全局列表

文件：
- Create: `backend/static/js/modules/model-selector.js` — 导出 `ModelSelector`, `ModelListView`, `ModelListEditor`, `ModelListEditorRow`
- Modify: `backend/static/js/modules/settings-modal.js` — 引入 `ModelSelector`，替换 `renderProviderList`/`setupProviderModelList` 的模型部分，保留 provider 配置
- Modify: `backend/static/index.html` — `tab-api` 面板内插入 `ModelSelector` 容器 `#model-selector-root`，保留 `#provider-list-container` 仅用于 provider 配置
- Modify: `backend/static/css/sections/input-modal.css` + `polish.css` — 新增 `model-selector-*` 样式，对齐 AMC 的 `SETTINGS_SECTION_CARD_CLASS`、`custom-scrollbar` 等
- Modify: `backend/static/js/modules/settings-icons.js` — 已有 `Trash2/Pin` 等，补充 `PinOff` 如需

## 4. Testing & Acceptance

- 后端：`normalize_available_models` 单测验证旧 `model_id` 字符串 → `available_models` 迁移，`isPinned` 默认 false，空字符串过滤；`validate_available_models` 测试重复 ID（`providerId:id` 联合）与空校验
- 前端：`ModelListEditor` 测试覆盖添加/删除/置顶/校验（空/重复）/保存/重置；`ModelSelector` 切换（View ↔ Editor）测试
- 集成：`settings-modal` 保存后 `available_models` 正确落库，`workflow_step_models` 仍可用；旧数据（无 `available_models` 但有 `providers[].model_id`）首次加载自动迁移并显示
- 回归：现有 `live_artifacts`、`settings-search`、`settings-icons` 测试保持通过；`test_project_hygiene` 通过

## 5. Implementation Order

1. Backend: `providers.py` + `routers/settings.py` 新增 `available_models` 与迁移
2. Frontend: `model-selector.js` + `settings-icons` 补充
3. Frontend: `settings-modal.js` + `index.html` 替换模型列表为 `ModelSelector`
4. CSS: `input-modal.css`/`polish.css` 新增 `model-selector` 样式
5. Tests + Build + Docker deploy
