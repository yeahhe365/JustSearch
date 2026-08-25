// ===========================================================================
// Keyboard shortcuts help — AMC-aligned (HelpModal).
//
// A searchable modal listing every global keyboard shortcut. Opened from the
// sidebar "?" button or by pressing `?` when the focus is not inside an
// editable element. `Esc` closes it via the shared modal Esc handler in
// main.js; this module keeps its own open/close state in sync with the modal
// class so the `?` toggle never goes stale.
// P1: grouping order input/generation/edit/sidebar/help aligns with AMC,
//     search box uses same <mark> highlight as settings-search, empty state.
// ===========================================================================

import { t } from './i18n.js?v=1';
// 高亮与 settings-search 完全共用：<mark class="settings-search-highlight">，
// 实现见 utils.js 的 highlightText / escapeRegExp（原始文本匹配 + 逐段转义）。
import { escapeRegExp, highlightText } from './utils.js?v=14';

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

export const GROUP_ORDER = [
    'shortcuts.group.input',
    'shortcuts.group.generation',
    'shortcuts.group.edit',
    'shortcuts.group.sidebar',
    'shortcuts.group.help',
];

// escapeRegExp / highlightText 已上移 utils.js，与 settings-search 共用同一实现。

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
        const q = query.trim();
        const qLower = q.toLowerCase();
        const groups = [];
        SHORTCUTS.forEach((s) => {
            const sGroup = t(s.groupKey);
            const sDesc = t(s.descKey);
            if (qLower && !`${s.key} ${sDesc} ${sGroup}`.toLowerCase().includes(qLower)) return;
            let g = groups.find((x) => x.key === s.groupKey);
            if (!g) {
                g = { key: s.groupKey, name: sGroup, items: [] };
                groups.push(g);
            }
            g.items.push({ ...s, _desc: sDesc, _group: sGroup });
        });
        // Enforce canonical AMC order regardless of translation.
        groups.sort((a, b) => GROUP_ORDER.indexOf(a.key) - GROUP_ORDER.indexOf(b.key));
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
            // Highlight group title if it matches query.
            title.innerHTML = highlightText(g.name, q);
            groupEl.appendChild(title);
            g.items.forEach((s) => {
                const row = root.createElement('div');
                row.className = 'shortcuts-help-row';
                const kbd = root.createElement('kbd');
                kbd.className = 'shortcuts-help-kbd';
                kbd.innerHTML = highlightText(s.key, q);
                const desc = root.createElement('span');
                desc.className = 'shortcuts-help-desc';
                desc.innerHTML = highlightText(s._desc, q);
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
        // Esc: first clears search, second closes modal.
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (searchInput.value.trim()) {
                    e.stopPropagation();
                    searchInput.value = '';
                    render('');
                } else {
                    // Allow global handler to close, also close directly.
                    // Don't stopPropagation — let main.js handle it if present.
                }
            }
        });
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
