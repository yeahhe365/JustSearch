// ===========================================================================
// Settings search — AMC-aligned (SettingsSearchBar / SettingsSearchResults).
//
// A search box in the settings sidebar that indexes every setting row/label
// across all tabs. Typing lists matching results; clicking one activates the
// owning tab and scrolls to / flashes the control.
// P1: Adds <mark> highlight, keyboard nav (ArrowUp/Down/Enter/Esc), aria roles.
// Throttle 80ms on input, "/" focuses search when not editing, ring-2 flash 1.6s.
// ===========================================================================

import { t } from './i18n.js?v=1';
import { escapeHtml } from './utils.js?v=14';

export function setupSettingsSearch({ modalEl, root = document }) {
    const input = root.getElementById('settings-search-input');
    const clearBtn = root.getElementById('settings-search-clear');
    const resultsEl = root.getElementById('settings-search-results');
    if (!input || !resultsEl || !modalEl) return null;

    let index = null;
    let selectedIndex = 0;

    // Accessibility: listbox semantics
    resultsEl.setAttribute('role', 'listbox');
    resultsEl.setAttribute('aria-label', t('settings.searchPlaceholder'));
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', resultsEl.id || 'settings-search-results');
    input.setAttribute('aria-autocomplete', 'list');

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

    function escapeRegExp(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function highlightText(text, q) {
        if (!q) return escapeHtml(text);
        const esc = escapeHtml(text);
        const re = new RegExp(`(${escapeRegExp(q)})`, 'ig');
        return esc.replace(re, '<mark class="settings-search-highlight">$1</mark>');
    }

    function reveal(element) {
        if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'center' });
        // Try to focus the control inside the row (input/select/textarea/button) and add ring-2.
        const focusable = element.matches?.('input, select, textarea, button, [tabindex]') ? element
            : element.querySelector?.('input, select, textarea, button, [tabindex]');
        const target = focusable || element;
        if (target && typeof target.focus === 'function') {
            try { target.focus({ preventScroll: true }); } catch { try { target.focus(); } catch {} }
        }
        // ring-2 highlight for 1.6s — uses Tailwind ring-2 utility.
        element.classList.add('settings-search-flash', 'ring-2');
        target?.classList?.add('ring-2');
        setTimeout(() => {
            element.classList.remove('settings-search-flash', 'ring-2');
            target?.classList?.remove('ring-2');
        }, 1600);
    }

    function updateSelection() {
        const rows = resultsEl.querySelectorAll('.settings-search-result');
        rows.forEach((row, idx) => {
            const isSelected = idx === selectedIndex;
            row.setAttribute('aria-selected', isSelected ? 'true' : 'false');
            row.classList.toggle('is-selected', isSelected);
            if (isSelected) {
                const id = row.id || `settings-search-option-${idx}`;
                row.id = id;
                input.setAttribute('aria-activedescendant', id);
                if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
            }
        });
        if (!rows.length) input.removeAttribute('aria-activedescendant');
    }

    function renderResults(results) {
        const q = input.value.trim();
        resultsEl.textContent = '';
        selectedIndex = 0;
        if (!results.length) {
            const empty = root.createElement('div');
            empty.className = 'settings-search-empty';
            empty.textContent = t('settings.searchNoMatch');
            resultsEl.appendChild(empty);
        } else {
            results.forEach((r, idx) => {
                const row = root.createElement('button');
                row.type = 'button';
                row.className = 'settings-search-result';
                row.setAttribute('role', 'option');
                row.setAttribute('aria-selected', idx === selectedIndex ? 'true' : 'false');
                row.id = `settings-search-option-${idx}`;
                row.innerHTML = `
                    <span class="settings-search-result-tab">${highlightText(r.tabLabel, q)}</span>
                    <span class="settings-search-result-label">${highlightText(r.label, q)}</span>
                    ${r.desc ? `<span class="settings-search-result-desc">${highlightText(r.desc, q)}</span>` : ''}`;
                row.addEventListener('click', () => {
                    const tabBtn = modalEl.querySelector(`.settings-tab-btn[data-tab="${r.tab}"]`);
                    if (tabBtn) tabBtn.click();
                    setTimeout(() => reveal(r.element), 30);
                    clearSearch();
                });
                row.addEventListener('mouseenter', () => {
                    selectedIndex = idx;
                    updateSelection();
                });
                resultsEl.appendChild(row);
            });
        }
        resultsEl.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        updateSelection();
    }

    function clearSearch() {
        input.value = '';
        resultsEl.hidden = true;
        resultsEl.textContent = '';
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        selectedIndex = 0;
        if (clearBtn) clearBtn.hidden = true;
    }

    function activateSelected() {
        const rows = resultsEl.querySelectorAll('.settings-search-result');
        const row = rows[selectedIndex];
        if (row) row.click();
    }

    // Throttle 80ms — avoid input jitter, keep Task 4 reusable思路.
    function throttle(fn, delay) {
        let timer = null;
        let pending = false;
        let lastArgs = null;
        let lastThis = null;
        return function(...args) {
            lastArgs = args;
            lastThis = this;
            if (!timer) {
                fn.apply(lastThis, lastArgs);
                lastArgs = null;
                timer = setTimeout(() => {
                    timer = null;
                    if (pending) {
                        pending = false;
                        if (lastArgs) fn.apply(lastThis, lastArgs);
                        lastArgs = null;
                    }
                }, delay);
            } else {
                pending = true;
            }
        };
    }

    const throttledRender = throttle(() => renderResults(query()), 80);

    input.addEventListener('input', () => {
        const q = input.value.trim();
        if (clearBtn) clearBtn.hidden = !q;
        if (!q) {
            resultsEl.hidden = true;
            resultsEl.textContent = '';
            input.setAttribute('aria-expanded', 'false');
            input.removeAttribute('aria-activedescendant');
            return;
        }
        throttledRender();
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            // First Esc clears search; second Esc should bubble to close modal.
            if (input.value.trim() || !resultsEl.hidden) {
                e.stopPropagation();
                clearSearch();
            }
            return;
        }
        if (resultsEl.hidden) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const rows = resultsEl.querySelectorAll('.settings-search-result');
            if (!rows.length) return;
            selectedIndex = (selectedIndex + 1) % rows.length;
            updateSelection();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const rows = resultsEl.querySelectorAll('.settings-search-result');
            if (!rows.length) return;
            selectedIndex = (selectedIndex - 1 + rows.length) % rows.length;
            updateSelection();
        } else if (e.key === 'Enter') {
            const rows = resultsEl.querySelectorAll('.settings-search-result');
            if (rows.length) {
                e.preventDefault();
                activateSelected();
            }
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
            input.setAttribute('aria-expanded', 'false');
        }
    });

    // "/" focuses search when not editing and settings modal is open.
    function isEditableTarget(target) {
        if (!(target instanceof Element)) return false;
        if (target.closest('input, textarea, select, [contenteditable]')) return true;
        // Bare contenteditable without value still editable
        return Boolean(target.isContentEditable);
    }
    const slashHandler = (e) => {
        if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
        if (isEditableTarget(e.target)) return;
        if (!modalEl.classList.contains('active')) return;
        // Don't hijack if another modal is already handling "/" (e.g., composer slash menu)
        // The settings search is the intended target when its modal is open.
        e.preventDefault();
        input.focus();
    };
    // Listen on document so "/" works regardless of root being document or shadow.
    // Guard duplicate registration when setup is called twice (singleton modal).
    const slashRoot = (typeof document !== 'undefined' ? document : root);
    if (slashRoot._justSearchSlashHandler) {
        try { slashRoot.removeEventListener('keydown', slashRoot._justSearchSlashHandler); } catch {}
    }
    slashRoot._justSearchSlashHandler = slashHandler;
    slashRoot.addEventListener('keydown', slashHandler);

    function destroy() {
        try { slashRoot.removeEventListener('keydown', slashHandler); } catch {}
        if (slashRoot._justSearchSlashHandler === slashHandler) {
            try { delete slashRoot._justSearchSlashHandler; } catch { slashRoot._justSearchSlashHandler = null; }
        }
    }

    return { buildIndex, clearSearch, highlightText, destroy };
}
