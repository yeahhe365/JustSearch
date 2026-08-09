// ===========================================================================
// Settings search — AMC-aligned (SettingsSearchBar / SettingsSearchResults).
//
// A search box in the settings sidebar that indexes every setting row/label
// across all tabs. Typing lists matching results; clicking one activates the
// owning tab and scrolls to / flashes the control.
// ===========================================================================

import { t } from './i18n.js?v=1';
import { escapeHtml } from './utils.js?v=14';

export function setupSettingsSearch({ modalEl, root = document }) {
    const input = root.getElementById('settings-search-input');
    const clearBtn = root.getElementById('settings-search-clear');
    const resultsEl = root.getElementById('settings-search-results');
    if (!input || !resultsEl || !modalEl) return null;

    let index = null;

    function buildIndex() {
        const entries = [];
        const tabLabels = {};
        modalEl.querySelectorAll('.settings-tab-btn[data-tab]').forEach((t) => {
            tabLabels[t.dataset.tab] = t.textContent.trim();
        });

        modalEl.querySelectorAll('.settings-panel').forEach((panel) => {
            const tab = panel.id.replace(/^tab-/, '');
            const tabLabel = tabLabels[tab] || tab;

            panel.querySelectorAll('.settings-section-heading').forEach((heading) => {
                const section = (heading.querySelector('.panel-header-title')?.textContent
                    || heading.querySelector('.settings-section-kicker')?.textContent || '').trim();
                if (section) {
                    entries.push({ tab, tabLabel, label: section, desc: '', element: heading, isSection: true });
                }
            });

            panel.querySelectorAll('label').forEach((labelEl) => {
                const label = labelEl.textContent.trim();
                if (!label) return;
                const fieldCopy = labelEl.closest('.settings-field-copy');
                const desc = fieldCopy?.querySelector('.field-desc')?.textContent?.trim() || '';
                const element = labelEl.closest('.settings-field-row, .form-group') || labelEl;
                entries.push({ tab, tabLabel, label, desc, element, isSection: false });
            });
        });
        return entries;
    }

    function query() {
        const q = input.value.trim().toLowerCase();
        if (!q) return [];
        if (!index) index = buildIndex();
        return index
            .filter((e) => `${e.label} ${e.desc} ${e.tabLabel}`.toLowerCase().includes(q))
            .slice(0, 30);
    }

    function reveal(element) {
        if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'center' });
        element.classList.add('settings-search-flash');
        setTimeout(() => element.classList.remove('settings-search-flash'), 1600);
    }

    function renderResults(results) {
        resultsEl.textContent = '';
        if (!results.length) {
            const empty = root.createElement('div');
            empty.className = 'settings-search-empty';
            empty.textContent = t('settings.searchNoMatch');
            resultsEl.appendChild(empty);
        } else {
            results.forEach((r) => {
                const row = root.createElement('button');
                row.type = 'button';
                row.className = 'settings-search-result';
                row.innerHTML = `
                    <span class="settings-search-result-tab">${escapeHtml(r.tabLabel)}</span>
                    <span class="settings-search-result-label">${escapeHtml(r.label)}</span>
                    ${r.desc ? `<span class="settings-search-result-desc">${escapeHtml(r.desc)}</span>` : ''}`;
                row.addEventListener('click', () => {
                    const tabBtn = modalEl.querySelector(`.settings-tab-btn[data-tab="${r.tab}"]`);
                    if (tabBtn) tabBtn.click();
                    // Panel activation is synchronous in switchTab, but reveal after
                    // layout so the target is visible.
                    setTimeout(() => reveal(r.element), 30);
                    clearSearch();
                });
                resultsEl.appendChild(row);
            });
        }
        resultsEl.hidden = false;
    }

    function clearSearch() {
        input.value = '';
        resultsEl.hidden = true;
        resultsEl.textContent = '';
        if (clearBtn) clearBtn.hidden = true;
    }

    input.addEventListener('input', () => {
        const q = input.value.trim();
        if (clearBtn) clearBtn.hidden = !q;
        if (!q) {
            resultsEl.hidden = true;
            resultsEl.textContent = '';
            return;
        }
        renderResults(query());
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            clearSearch();
            input.blur();
        }
    });
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            clearSearch();
            input.focus();
        });
    }
    root.addEventListener('mousedown', (e) => {
        if (!e.target.closest('.settings-search, #settings-search-results')) {
            resultsEl.hidden = true;
        }
    });

    return { buildIndex, clearSearch };
}
