// ModelSelector — AMC-aligned global model list (vanilla JS)
// Replicates AMC's ModelSelector / ModelListEditor / ModelListView in JustSearch's vanilla stack
import { t } from './i18n.js?v=1';
import { createActionIcon } from './settings-icons.js';

function createRowId() {
    return `model-row-${Math.random().toString(36).slice(2, 9)}`;
}

export function createModelSelector({ availableModels = [], selectedModelId = '', onSelect, onSave, providers = [] }) {
    const container = document.createElement('div');
    container.className = 'model-selector-root space-y-4';

    const header = document.createElement('div');
    header.className = 'model-selector-header flex items-center justify-between gap-3';
    const title = document.createElement('h4');
    title.className = 'text-sm font-semibold text-[var(--text-primary)]';
    title.textContent = t('settings.modelList') || 'Model list';
    header.appendChild(title);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'model-selector-edit-btn secondary-btn';
    editBtn.textContent = t('settings.manageModels') || 'Manage';
    header.appendChild(editBtn);
    container.appendChild(header);

    let isEditing = false;
    let tempModels = [];

    const listContainer = document.createElement('div');
    container.appendChild(listContainer);

    function toEditable(models) {
        return models.map((m) => ({
            _rowId: createRowId(),
            id: m.id || '',
            name: m.name || '',
            isPinned: !!m.isPinned,
            providerId: m.providerId || m.provider_id || '',
        }));
    }

    function renderView() {
        listContainer.textContent = '';
        const sorted = [...availableModels].sort((a, b) => (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0));
        if (!sorted.length) {
            const empty = document.createElement('div');
            empty.className = 'model-selector-empty text-xs text-muted italic p-4 text-center';
            empty.textContent = t('settings.modelManagerEmpty') || 'No models';
            listContainer.appendChild(empty);
            return;
        }
        const list = document.createElement('div');
        list.className = 'model-selector-list space-y-2';
        sorted.forEach((model) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = `model-selector-item flex w-full items-center justify-between gap-3 p-3 rounded-lg border text-left ${model.id === selectedModelId ? 'bg-[var(--primary-light)] border-[var(--primary)]' : 'bg-[var(--bg-secondary)] border-[var(--border-light)]'}`;
            row.dataset.modelId = model.id;
            const left = document.createElement('div');
            left.className = 'min-w-0 flex-1';
            const name = document.createElement('div');
            name.className = 'text-sm font-medium truncate';
            name.textContent = model.name || model.id;
            const id = document.createElement('div');
            id.className = 'text-xs text-muted truncate';
            id.textContent = `${model.providerId || ''} / ${model.id}`;
            left.append(name, id);
            const right = document.createElement('div');
            right.className = 'flex items-center gap-2 flex-shrink-0';
            if (model.isPinned) {
                const pin = document.createElement('span');
                pin.className = 'model-pin-badge';
                pin.textContent = '📌';
                right.appendChild(pin);
            }
            row.append(left, right);
            row.addEventListener('click', () => {
                if (typeof onSelect === 'function') onSelect(model.id);
            });
            list.appendChild(row);
        });
        listContainer.appendChild(list);
    }

    function renderEditor() {
        listContainer.textContent = '';
        tempModels = toEditable(availableModels);

        const card = document.createElement('div');
        card.className = 'model-editor-card border border-[var(--border-secondary)] rounded-xl bg-[var(--bg-input)]/50 overflow-hidden p-3 space-y-3';

        const list = document.createElement('div');
        list.className = 'model-editor-list max-h-[400px] overflow-y-auto custom-scrollbar space-y-2 p-1';

        function renderRows() {
            list.textContent = '';
            if (!tempModels.length) {
                const empty = document.createElement('div');
                empty.className = 'p-4 text-center text-xs text-muted italic';
                empty.textContent = t('settings.modelManagerEmpty') || 'No models';
                list.appendChild(empty);
                return;
            }
            tempModels.forEach((model, idx) => {
                const row = document.createElement('div');
                row.className = 'model-editor-row flex items-center gap-2 p-2 rounded-lg bg-[var(--bg-secondary)]';
                row.dataset.rowId = model._rowId;

                const idInput = document.createElement('input');
                idInput.type = 'text';
                idInput.placeholder = t('settings.modelIdPlaceholder') || 'Model ID';
                idInput.value = model.id;
                idInput.className = 'model-id-input flex-1 min-w-0 p-2 rounded border bg-[var(--bg-input)] text-sm';
                idInput.addEventListener('input', (e) => {
                    tempModels[idx].id = e.target.value;
                });

                const nameInput = document.createElement('input');
                nameInput.type = 'text';
                nameInput.placeholder = t('settings.modelNamePlaceholder') || 'Display name';
                nameInput.value = model.name;
                nameInput.className = 'model-name-input flex-1 min-w-0 p-2 rounded border bg-[var(--bg-input)] text-sm';
                nameInput.addEventListener('input', (e) => {
                    tempModels[idx].name = e.target.value;
                });

                const providerSelect = document.createElement('select');
                providerSelect.className = 'model-provider-select min-w-[120px] p-2 rounded border bg-[var(--bg-input)] text-xs';
                const emptyOpt = document.createElement('option');
                emptyOpt.value = '';
                emptyOpt.textContent = 'Provider';
                providerSelect.appendChild(emptyOpt);
                providers.forEach((p) => {
                    const opt = document.createElement('option');
                    opt.value = p.id;
                    opt.textContent = p.name || p.id;
                    if (p.id === model.providerId) opt.selected = true;
                    providerSelect.appendChild(opt);
                });
                providerSelect.addEventListener('change', (e) => {
                    tempModels[idx].providerId = e.target.value;
                });

                const pinBtn = document.createElement('button');
                pinBtn.type = 'button';
                pinBtn.className = 'model-pin-btn p-2 rounded hover:bg-[var(--bg-tertiary)]';
                pinBtn.title = model.isPinned ? 'Unpin' : 'Pin';
                pinBtn.appendChild(createActionIcon(model.isPinned ? 'check_circle' : 'add', 14));
                pinBtn.addEventListener('click', () => {
                    tempModels[idx].isPinned = !tempModels[idx].isPinned;
                    renderRows();
                });

                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'model-delete-btn p-2 rounded hover:bg-[var(--warning-light)] text-[var(--text-muted)] hover:text-[var(--warning)]';
                delBtn.appendChild(createActionIcon('delete', 14));
                delBtn.addEventListener('click', () => {
                    tempModels.splice(idx, 1);
                    renderRows();
                });

                row.append(idInput, nameInput, providerSelect, pinBtn, delBtn);
                list.appendChild(row);
            });
        }

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'model-add-btn inline-flex items-center gap-2 px-3 py-2 rounded border bg-[var(--bg-secondary)] text-sm';
        addBtn.appendChild(createActionIcon('add', 14));
        const addLabel = document.createElement('span');
        addLabel.textContent = t('settings.addModel') || 'Add model';
        addBtn.appendChild(addLabel);
        addBtn.addEventListener('click', () => {
            tempModels.push({ _rowId: createRowId(), id: '', name: '', isPinned: false, providerId: providers[0]?.id || '' });
            renderRows();
        });

        const actions = document.createElement('div');
        actions.className = 'model-editor-actions flex justify-between items-center gap-3 pt-2 border-t';

        const leftActions = document.createElement('div');
        leftActions.className = 'flex gap-2';
        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'secondary-btn';
        resetBtn.appendChild(createActionIcon('settings', 14));
        resetBtn.appendChild(document.createTextNode(' ' + (t('settings.resetToDefault') || 'Reset')));
        resetBtn.addEventListener('click', () => {
            tempModels = [];
            renderRows();
        });
        leftActions.appendChild(resetBtn);

        const rightActions = document.createElement('div');
        rightActions.className = 'flex gap-2';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'secondary-btn';
        cancelBtn.textContent = t('confirm.cancel') || 'Cancel';
        cancelBtn.addEventListener('click', () => {
            isEditing = false;
            editBtn.textContent = t('settings.manageModels') || 'Manage';
            renderView();
        });
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'primary-btn bg-[var(--primary)] text-white px-4 py-2 rounded';
        saveBtn.textContent = t('confirm.ok') || 'Save';
        saveBtn.addEventListener('click', () => {
            const valid = tempModels
                .map((m) => ({ id: m.id.trim(), name: m.name.trim() || m.id.trim(), isPinned: !!m.isPinned, providerId: m.providerId }))
                .filter((m) => m.id);
            if (!valid.length) {
                alert(t('settings.errModelRequired') || 'At least one model required');
                return;
            }
            const seen = new Set();
            for (const m of valid) {
                const key = `${m.providerId}:${m.id}`;
                if (seen.has(key)) {
                    alert('Duplicate: ' + key);
                    return;
                }
                seen.add(key);
            }
            if (typeof onSave === 'function') onSave(valid);
            isEditing = false;
            editBtn.textContent = t('settings.manageModels') || 'Manage';
            renderView();
        });
        rightActions.append(cancelBtn, saveBtn);
        actions.append(leftActions, rightActions);

        renderRows();
        card.append(list, addBtn, actions);
        listContainer.appendChild(card);
    }

    editBtn.addEventListener('click', () => {
        isEditing = !isEditing;
        if (isEditing) {
            editBtn.textContent = t('confirm.cancel') || 'Cancel';
            renderEditor();
        } else {
            editBtn.textContent = t('settings.manageModels') || 'Manage';
            renderView();
        }
    });

    renderView();

    return {
        container,
        refresh(newModels, newSelected) {
            availableModels = newModels || availableModels;
            if (newSelected !== undefined) selectedModelId = newSelected;
            if (isEditing) renderEditor();
            else renderView();
        },
        destroy() {
            container.remove();
        },
    };
}

export function createModelListEditor(models, opts) {
    const div = document.createElement('div');
    const handle = createModelSelector({ availableModels: models, ...opts });
    div.appendChild(handle.container);
    return div;
}
