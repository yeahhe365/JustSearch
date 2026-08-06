// ===========================================================================
// Keyboard shortcuts help — AMC-aligned (HelpModal).
//
// A searchable modal listing every global keyboard shortcut. Opened from the
// sidebar "?" button or by pressing `?` when the focus is not inside an
// editable element. `Esc` closes it via the shared modal Esc handler in
// main.js; this module keeps its own open/close state in sync with the modal
// class so the `?` toggle never goes stale.
// ===========================================================================

import { t } from './i18n.js?v=1';

export const SHORTCUTS = [
    { groupKey: 'shortcuts.group.input', key: 'Enter', descKey: 'shortcuts.desc.sendMessage' },
    { groupKey: 'shortcuts.group.input', key: 'Shift + Enter', descKey: 'shortcuts.desc.newline' },
    { groupKey: 'shortcuts.group.input', key: 'Ctrl / ⌘ + Enter', descKey: 'shortcuts.desc.sendAlternate' },
    { groupKey: 'shortcuts.group.input', key: '↑', descKey: 'shortcuts.desc.recallLastQuestion' },
    { groupKey: 'shortcuts.group.input', key: '/', descKey: 'shortcuts.desc.openCommandMenu' },
    { groupKey: 'shortcuts.group.input', key: '← / →', descKey: 'shortcuts.desc.switchSuggestion' },
    { groupKey: 'shortcuts.group.generation', key: 'Ctrl / ⌘ + Shift + R', descKey: 'shortcuts.desc.regenerate' },
    { groupKey: 'shortcuts.group.edit', key: 'Esc', descKey: 'shortcuts.desc.cancelEdit' },
    { groupKey: 'shortcuts.group.sidebar', key: 'Ctrl / ⌘ + N', descKey: 'shortcuts.desc.newChat' },
    { groupKey: 'shortcuts.group.sidebar', key: 'Ctrl / ⌘ + K', descKey: 'shortcuts.desc.searchHistory' },
    { groupKey: 'shortcuts.group.sidebar', key: 'Ctrl / ⌘ + /', descKey: 'shortcuts.desc.toggleSidebar' },
    { groupKey: 'shortcuts.group.help', key: '?', descKey: 'shortcuts.desc.openHelp' },
];

export function setupShortcutsHelp({ root = document } = {}) {
    const modal = root.getElementById('shortcuts-help-modal');
    const btn = root.getElementById('shortcuts-help-btn');
    const searchInput = root.getElementById('shortcuts-help-search-input');
    const listEl = root.getElementById('shortcuts-help-list');
    if (!modal || !listEl) return null;

    function isOpen() {
        return modal.classList.contains('active');
    }

    function render(query = '') {
        const q = query.trim().toLowerCase();
        const groups = [];
        SHORTCUTS.forEach((s) => {
            const sGroup = t(s.groupKey);
            const sDesc = t(s.descKey);
            if (q && !`${s.key} ${sDesc} ${sGroup}`.toLowerCase().includes(q)) return;
            let g = groups.find((x) => x.name === sGroup);
            if (!g) {
                g = { name: sGroup, items: [] };
                groups.push(g);
            }
            g.items.push({ ...s, _desc: sDesc });
        });
        listEl.textContent = '';
        if (!groups.length) {
            const empty = root.createElement('div');
            empty.className = 'shortcuts-help-empty';
            empty.textContent = t('shortcuts.noMatch');
            listEl.appendChild(empty);
            return;
        }
        groups.forEach((g) => {
            const groupEl = root.createElement('div');
            groupEl.className = 'shortcuts-help-group';
            const title = root.createElement('div');
            title.className = 'shortcuts-help-group-title';
            title.textContent = g.name;
            groupEl.appendChild(title);
            g.items.forEach((s) => {
                const row = root.createElement('div');
                row.className = 'shortcuts-help-row';
                const kbd = root.createElement('kbd');
                kbd.className = 'shortcuts-help-kbd';
                kbd.textContent = s.key;
                const desc = root.createElement('span');
                desc.className = 'shortcuts-help-desc';
                desc.textContent = s._desc;
                row.appendChild(kbd);
                row.appendChild(desc);
                groupEl.appendChild(row);
            });
            listEl.appendChild(groupEl);
        });
    }

    function open() {
        modal.classList.add('active');
        if (searchInput) {
            searchInput.value = '';
            render('');
            searchInput.focus();
        } else {
            render('');
        }
    }

    function close() {
        modal.classList.remove('active');
        btn?.focus();
    }

    btn?.addEventListener('click', open);
    const closeBtn = modal.querySelector('.shortcuts-help-close');
    closeBtn?.addEventListener('click', close);

    if (searchInput) {
        searchInput.addEventListener('input', () => render(searchInput.value));
    }

    // `?` toggles the modal. Skip when typing in an editable element (the
    // composer uses `/` for the slash menu, `?` should just type) or when
    // another modal is already open.
    const keydownHandler = (e) => {
        if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
        const target = e.target;
        if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) {
            return;
        }
        const otherOpen = Array.from(root.querySelectorAll('.modal.active')).some((m) => m !== modal);
        if (otherOpen) return;
        e.preventDefault();
        if (isOpen()) close();
        else open();
    };
    document.addEventListener('keydown', keydownHandler);

    // Click the backdrop (but not the panel) closes.
    modal.addEventListener('mousedown', (e) => {
        if (e.target === modal) close();
    });

    return { open, close, render, isOpen };
}
