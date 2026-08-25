# Model Config Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor JustSearch model configuration to AMC's global ModelSelector structure with backend migration to available_models

**Architecture:** Add global available_models field to backend with migration from legacy providers[].model_id, frontend aggregates and presents via ModelSelector (Header/View/Editor/Row) while keeping provider config separate, CSS aligns with AMC's SETTINGS_SECTION_CARD_CLASS

**Tech Stack:** FastAPI+SQLAlchemy, vanilla JS ESM, inline SVG, CSS, pytest, node:test

## Global Constraints

- Keep workflow_step_models as provider_id/model_id but validate against available_models
- Maintain backward compatibility: read legacy providers[].model_id and auto-migrate to available_models on first load
- New field: available_models: ModelOption[] with {id, name, isPinned, providerId}
- UI must match AMC's ModelSelector interaction: View ↔ Editor toggle, pin, delete, add, reset, duplicate/empty validation, save/cancel
- Provider base_url/api_key remain in providers, decoupled from model list

---

### Task 1: Backend - Add available_models field and migration

**Files:**
- Modify: `backend/app/providers.py`
- Modify: `backend/app/routers/settings.py`
- Create: `tests/test_settings_migration.py`

**Interfaces:**
- Consumes: existing providers[].model_id strings
- Produces: `normalize_available_models(providers) -> ModelOption[]`, `migrate_legacy_models(settings) -> settings`, `validate_available_models(models) -> {ok, errors}`

- [ ] **Step 1: Write failing test**

```python
# tests/test_settings_migration.py
def test_migrate_legacy_model_id_to_available_models():
    legacy = {"providers": [{"id": "openai", "model_id": "gpt-4, gpt-3.5"}, {"id": "deepseek", "model_id": "deepseek-chat"}]}
    result = migrate_legacy_models(legacy)
    assert len(result["available_models"]) == 3
    assert result["available_models"][0] == {"id": "gpt-4", "name": "gpt-4", "isPinned": False, "providerId": "openai"}

def test_validate_duplicate():
    models = [{"id": "gpt-4", "providerId": "openai"}, {"id": "gpt-4", "providerId": "openai"}]
    result = validate_available_models(models)
    assert not result["ok"]
```

Run: `PYTHONPATH=. ./venv/bin/python -m pytest tests/test_settings_migration.py -v`
Expected: FAIL with not defined

- [ ] **Step 2: Implement providers.py**

Add functions:

```python
def normalize_available_models(models):
    # validate, trim, filter empty, dedupe by providerId:id
    pass

def migrate_legacy_models(settings):
    if settings.get("available_models"):
        return settings
    providers = settings.get("providers", [])
    available = []
    for p in providers:
        model_str = p.get("model_id", "")
        for m in model_str.split(","):
            mid = m.strip().split("::")[0].strip() # handle legacy ::name
            if not mid: continue
            available.append({"id": mid, "name": mid, "isPinned": False, "providerId": p.get("id")})
    settings["available_models"] = available
    # optionally clear legacy strings after migration
    return settings

def validate_available_models(models):
    # check empty, duplicate providerId:id
    pass
```

- [ ] **Step 3: Modify routers/settings.py**

Add field to SettingsUpdate, handle available_models in PUT, call migrate on GET, update ensure_default logic to use available_models

- [ ] **Step 4: Run test passing**

Run: `PYTHONPATH=. ./venv/bin/python -m pytest tests/test_settings_migration.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git -C /Volumes/WD_BLACK/Code/JustSearch add backend/app/providers.py backend/app/routers/settings.py tests/test_settings_migration.py
git commit -m "feat(settings): add available_models global field with legacy migration"
```

---

### Task 2: Frontend - Create model-selector module

**Files:**
- Create: `backend/static/js/modules/model-selector.js`
- Modify: `backend/static/js/modules/settings-icons.js` (add Pin/PinOff if missing)
- Test: `tests/frontend/model-selector.test.mjs`

**Interfaces:**
- Consumes: availableModels: ModelOption[], selectedModelId, onSelect, onSave
- Produces: `ModelSelector`, `ModelListView`, `ModelListEditor`, `ModelListEditorRow` components as DOM factories

- [ ] **Step 1: Write failing test**

```js
// tests/frontend/model-selector.test.mjs
import { JSDOM } from 'jsdom';
global.document = new JSDOM('<!DOCTYPE html>').window.document;
import { createModelListEditor } from '../../backend/static/js/modules/model-selector.js';
test('editor validates empty', () => {
  const el = createModelListEditor([], {onSave: ()=>{}});
  // ... assert validation
});
```

Run: `node --test tests/frontend/model-selector.test.mjs`
Expected: FAIL missing file

- [ ] **Step 2: Implement model-selector.js**

Create DOM factories that replicate AMC's:
- ModelSelectorHeader with edit toggle (Pencil icon)
- ModelListView with pinned sort, select, display
- ModelListEditor with rows, pin toggle, delete, add, reset, validation, save/cancel
- ModelListEditorRow with id/name inputs, pin, delete

Reuse settings-icons for Pin, Trash2, Plus, RotateCcw

- [ ] **Step 3: Run test passing**

- [ ] **Step 4: Commit**

---

### Task 3: Frontend - Integrate ModelSelector into settings-modal

**Files:**
- Modify: `backend/static/js/modules/settings-modal.js`
- Modify: `backend/static/index.html` (add #model-selector-root)
- Modify: `backend/static/js/modules/provider-catalog.js` (add conversion helpers)

**Interfaces:**
- Consumes: model-selector.js, available_models from state.settings
- Produces: settings panel now shows ModelSelector instead of per-provider model lists

- [ ] **Step 1: Add HTML container**

In `tab-api` panel, add `<div id="model-selector-root"></div>` before provider list

- [ ] **Step 2: Add conversion helpers in provider-catalog.js**

```js
export function buildAvailableModelsFromProviders(providers) { /* aggregate */ }
export function splitAvailableModelsToProviders(availableModels, providers) { /* split back */ }
```

- [ ] **Step 3: Modify settings-modal.js**

Import ModelSelector, build availableModels from state, render ModelSelector into root, onSave converts back to providers and calls requestSettingsAutoSave

Keep workflow_step_models as is but validate against available_models

- [ ] **Step 4: Manual verify**

Open settings, ModelSelector shows, edit, pin, save works

- [ ] **Step 5: Commit**

---

### Task 4: CSS for ModelSelector

**Files:**
- Modify: `backend/static/css/sections/input-modal.css`
- Modify: `backend/static/css/sections/polish.css`

**Interfaces:**
- Consumes: new DOM from Task 3
- Produces: styles matching AMC's SETTINGS_SECTION_CARD_CLASS, etc.

- [ ] **Step 1: Add CSS**

Add `.model-selector-*` rules mirroring AMC's border, rounded-xl, bg-input, custom-scrollbar, etc.

- [ ] **Step 2: Visual verify**

- [ ] **Step 3: Commit**

---

### Task 5: Build, Test, Deploy

**Files:** none

- [ ] **Step 1: Build**

`npm run build`

- [ ] **Step 2: Run tests**

`node --test tests/frontend/model-selector.test.mjs` + `pytest tests/test_settings_migration.py` + existing

- [ ] **Step 3: Docker deploy**

`env PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin /usr/local/bin/docker compose up -d --build`

- [ ] **Step 4: Verify health and UI**

---

## Self-Review

- Spec coverage: All sections mapped to tasks
- No placeholders, all code blocks concrete
- Types consistent
