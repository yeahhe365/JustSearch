// Shortcuts settings — AMC-aligned visual parity (read-only)
// Reuses SHORTCUTS data and highlight logic from shortcuts-help.js
import { SHORTCUTS, GROUP_ORDER } from './shortcuts-help.js';
import { t } from './i18n.js?v=1';
import { highlightText } from './utils.js?v=14';

export function setupShortcutsSettings({ root = document } = {}) {
    const panel = root.getElementById('tab-shortcuts');
    if (!panel) return null;

    const searchInput = root.getElementById('shortcuts-settings-search');
    const clearBtn = root.getElementById('shortcuts-settings-clear');
    const filterSelect = root.getElementById('shortcuts-settings-filter');
    const listEl = root.getElementById('shortcuts-settings-list');
    const emptyEl = root.getElementById('shortcuts-settings-empty');
    const countEl = root.querySelector('.shortcuts-settings-count');
    if (!listEl) return null;

    function getFiltered() {
        const q = (searchInput?.value || '').trim().toLowerCase();
        const filter = filterSelect?.value || 'all';
        return SHORTCUTS.filter((s) => {
            if (filter !== 'all' && s.groupKey !== filter) return false;
            if (!q) return true;
            const groupName = t(s.groupKey).toLowerCase();
            const desc = t(s.descKey).toLowerCase();
            const key = s.key.toLowerCase();
            return groupName.includes(q) || desc.includes(q) || key.includes(q);
        });
    }

    function render() {
        const q = (searchInput?.value || '').trim();
        const filtered = getFiltered();

        if (countEl) {
            countEl.textContent = `${filtered.length} / ${SHORTCUTS.length}`;
        }

        if (clearBtn) clearBtn.hidden = !q;

        // Group
        const groups = [];
        filtered.forEach((s) => {
            let g = groups.find((x) => x.key === s.groupKey);
            if (!g) {
                g = { key: s.groupKey, name: t(s.groupKey), items: [] };
                groups.push(g);
            }
            g.items.push(s);
        });
        groups.sort((a, b) => GROUP_ORDER.indexOf(a.key) - GROUP_ORDER.indexOf(b.key));

        listEl.textContent = '';
        if (!groups.length) {
            if (emptyEl) emptyEl.hidden = false;
            return;
        }
        if (emptyEl) emptyEl.hidden = true;

        groups.forEach((g) => {
            const groupEl = root.createElement('div');
            groupEl.className = 'shortcuts-settings-group';
            const title = root.createElement('div');
            title.className = 'shortcuts-settings-group-title';
            title.innerHTML = highlightText(g.name, q);
            groupEl.appendChild(title);

            g.items.forEach((s) => {
                const row = root.createElement('div');
                row.className = 'shortcuts-settings-row';
                const kbd = root.createElement('kbd');
                kbd.className = 'shortcuts-settings-kbd';
                kbd.innerHTML = highlightText(s.key, q);
                const desc = root.createElement('span');
                desc.className = 'shortcuts-settings-desc';
                desc.innerHTML = highlightText(t(s.descKey), q);
                row.appendChild(kbd);
                row.appendChild(desc);
                groupEl.appendChild(row);
            });
            listEl.appendChild(groupEl);
        });
    }

    function clearSearch() {
        if (searchInput) {
            searchInput.value = '';
            render();
            searchInput.focus();
        }
        if (filterSelect) {
            // keep filter as is, just clear search
        }
    }

    searchInput?.addEventListener('input', render);
    filterSelect?.addEventListener('change', render);
    clearBtn?.addEventListener('click', clearSearch);

    // Initial render and on language change
    render();

    return {
        render,
        destroy() {
            searchInput?.removeEventListener('input', render);
            filterSelect?.removeEventListener('change', render);
            clearBtn?.removeEventListener('click', clearSearch);
        },
    };
}
