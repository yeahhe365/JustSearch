import { buildAuthenticatedUrl } from './auth.js?v=1';
import {
    createChatGroupAPI,
    deleteChatGroupAPI,
    duplicateChatAPI,
    fetchChatGroups,
    fetchHistory,
    moveChatToGroupAPI,
    pinChatAPI,
    renameChatAPI,
    searchHistory,
    updateChatGroupAPI
} from './api.js?v=14';
import { state } from './state.js?v=5';
import { showToast } from './toast.js';
import { elements, showConfirm } from './ui.js?v=43';
import { t } from './i18n.js?v=1';
import { encodePathSegment } from './utils.js?v=14';

let _fullHistory = [];
let _chatGroups = [];
let _historySearchRequestSeq = 0;

export function getCachedHistory() {
    return _fullHistory;
}

export function getCachedGroups() {
    return _chatGroups;
}

function updateCachedHistoryTitle(chatId, title) {
    _fullHistory = _fullHistory.map(chat => (
        chat.id === chatId ? { ...chat, title } : chat
    ));
}

function updateCachedChatGroup(groupId, changes) {
    _chatGroups = _chatGroups.map(group => (
        group.id === groupId ? { ...group, ...changes } : group
    ));
}

function updateCachedChatPinned(chatId, isPinned) {
    _fullHistory = _fullHistory.map(chat => (
        chat.id === chatId ? { ...chat, is_pinned: Boolean(isPinned) } : chat
    ));
}

function sortHistoryByPinnedThenTimestamp(history) {
    return [...history].sort((a, b) => {
        const pa = a.is_pinned ? 1 : 0;
        const pb = b.is_pinned ? 1 : 0;
        if (pa !== pb) return pb - pa;
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return tb - ta;
    });
}

function groupChatsByDate(history) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7));

    const groups = {
        '今天': [],
        '昨天': [],
        '本周': [],
        '更早': []
    };

    history.forEach(chat => {
        const ts = chat.timestamp ? new Date(chat.timestamp) : null;
        if (!ts) {
            groups['更早'].push(chat);
            return;
        }
        const chatDate = new Date(ts.getFullYear(), ts.getMonth(), ts.getDate());
        if (chatDate.getTime() >= today.getTime()) {
            groups['今天'].push(chat);
        } else if (chatDate.getTime() >= yesterday.getTime()) {
            groups['昨天'].push(chat);
        } else if (chatDate.getTime() >= weekStart.getTime()) {
            groups['本周'].push(chat);
        } else {
            groups['更早'].push(chat);
        }
    });

    return groups;
}

function renderEmptyHistory(iconName, message) {
    const emptyState = document.createElement('div');
    emptyState.className = 'history-no-results';

    let svgHtml = '';
    if (iconName === 'search_off') {
        svgHtml = `<svg class="history-no-results-icon" xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>`;
    } else {
        svgHtml = `<svg class="history-no-results-icon" xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`;
    }

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = svgHtml.trim();
    const icon = tempDiv.firstChild;
    icon.setAttribute('aria-hidden', 'true');
    emptyState.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'history-no-results-label';
    label.textContent = message;
    emptyState.appendChild(label);

    elements.historyList.appendChild(emptyState);
}

function createIconButton(className, title, ariaLabel, svgHtml, onClick) {
    const button = document.createElement('button');
    button.className = className;
    button.title = title;
    button.setAttribute('aria-label', ariaLabel);
    button.innerHTML = svgHtml;
    button.onclick = onClick;
    return button;
}

function createHistoryItem(chat, currentSessionId, callbacks) {
    const { onSelect, onDelete } = callbacks;
    const item = document.createElement('div');
    item.className = 'history-item';
    if (chat.is_pinned) item.classList.add('is-pinned');
    item.draggable = true;
    item.dataset.id = chat.id;
    if (chat.id === currentSessionId) item.classList.add('active');

    item.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('text/plain', chat.id);
        event.dataTransfer.setData('sessionId', chat.id);
        event.dataTransfer.effectAllowed = 'move';
        item.classList.add('dragging');
        item.classList.add('is-dragging');
        // Ghost image — align with AMC drag feedback (clone + setDragImage)
        try {
            if (event.dataTransfer.setDragImage) {
                const ghost = item.cloneNode(true);
                ghost.style.position = 'fixed';
                ghost.style.top = '-1000px';
                ghost.style.left = '-1000px';
                ghost.style.opacity = '0.9';
                ghost.style.pointerEvents = 'none';
                ghost.style.width = `${item.offsetWidth}px`;
                document.body.appendChild(ghost);
                event.dataTransfer.setDragImage(ghost, 12, 12);
                setTimeout(() => { try { ghost.remove(); } catch {} }, 0);
            }
        } catch {}
        // Emit dragover line indicator via custom event: parent will handle .drag-over
    });
    item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        item.classList.remove('is-dragging');
        // Cleanup any lingering drag-over states
        document.querySelectorAll('.history-item.drag-over, .chat-group.drag-over').forEach(el => el.classList.remove('drag-over'));
    });

    const titleSpan = document.createElement('span');
    titleSpan.className = 'history-title';
    titleSpan.textContent = chat.title || t('history.newChat');
    item.appendChild(titleSpan);

    titleSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startRename(titleSpan, chat.id, callbacks);
    });

    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'history-item-actions';

    const pinned = Boolean(chat.is_pinned);
    const pinTitle = pinned ? t('history.unpin') : t('history.pin');
    actionsContainer.appendChild(createIconButton(
        `history-action-btn history-pin-btn${pinned ? ' is-pinned' : ''}`,
        pinTitle,
        pinTitle,
        '<svg class="icon-svg" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"></path><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"></path></svg>',
        async (e) => {
            e.stopPropagation();
            const nextPinned = !pinned;
            const summary = await pinChatAPI(chat.id, nextPinned);
            if (summary) {
                updateCachedChatPinned(chat.id, nextPinned);
                renderHistory(_fullHistory, state.currentSessionId, callbacks, _chatGroups);
                showToast(nextPinned ? t('history.pinnedToast') : t('history.unpinnedToast'), 'success');
            } else {
                showToast(t('history.pinFailed'), 'error');
            }
        }
    ));

    actionsContainer.appendChild(createIconButton(
        'history-action-btn history-rename-btn',
        t('history.rename'),
        t('history.renameChat'),
        '<svg class="icon-svg" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>',
        (e) => {
            e.stopPropagation();
            startRename(titleSpan, chat.id, callbacks);
        }
    ));

    actionsContainer.appendChild(createIconButton(
        'history-action-btn history-duplicate-btn',
        t('history.duplicate'),
        t('history.duplicateChat'),
        '<svg class="icon-svg" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>',
        async (e) => {
            e.stopPropagation();
            const summary = await duplicateChatAPI(chat.id);
            if (summary && summary.id) {
                _fullHistory = [{ ...summary }, ..._fullHistory.filter(c => c.id !== summary.id)];
                renderHistory(_fullHistory, state.currentSessionId, callbacks, _chatGroups);
                showToast(t('history.duplicated'), 'success');
            } else {
                showToast(t('history.duplicateFailed'), 'error');
            }
        }
    ));

    actionsContainer.appendChild(createIconButton(
        'history-action-btn history-share-btn',
        t('history.copyLink'),
        t('history.copyChatLink'),
        '<svg class="icon-svg" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>',
        (e) => {
            e.stopPropagation();
            const url = `${window.location.origin}/c/${encodePathSegment(chat.id)}`;
            navigator.clipboard.writeText(url).then(() => {
                showToast(t('history.linkCopied'), 'success');
            }).catch(() => {
                showToast(t('history.copyFailed'), 'error');
            });
        }
    ));

    actionsContainer.appendChild(createIconButton(
        'history-action-btn history-export-btn',
        t('common.export'),
        t('history.exportChat'),
        '<svg class="icon-svg" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" x2="12" y1="15" y2="3"></line></svg>',
        (e) => {
            e.stopPropagation();
            window.open(
                buildAuthenticatedUrl(`/api/history/${encodePathSegment(chat.id)}/export`),
                '_blank',
                'noopener,noreferrer',
            );
        }
    ));

    actionsContainer.appendChild(createIconButton(
        'history-action-btn history-delete-btn',
        t('common.delete'),
        t('history.deleteChat'),
        '<svg class="icon-svg" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path><line x1="10" x2="10" y1="11" y2="17"></line><line x1="14" x2="14" y1="11" y2="17"></line></svg>',
        (e) => {
            e.stopPropagation();
            onDelete(chat.id);
        }
    ));

    item.appendChild(actionsContainer);
    item.onclick = () => onSelect(chat.id);
    return item;
}

function getGroupSessionMap(history, groups) {
    const groupIds = new Set(groups.map(group => group.id));
    const map = new Map();
    groupIds.forEach(groupId => map.set(groupId, []));
    const ungrouped = [];

    history.forEach(chat => {
        const groupId = chat.group_id || chat.groupId || null;
        if (groupId && groupIds.has(groupId)) {
            map.get(groupId).push(chat);
        } else {
            ungrouped.push(chat);
        }
    });

    return { map, ungrouped };
}

function renderChatGroups(groups, groupedSessions, currentSessionId, callbacks, searchTerm) {
    groups.forEach(group => {
        const sessions = groupedSessions.get(group.id) || [];
        if (searchTerm && sessions.length === 0) return;

        const groupEl = document.createElement('div');
        groupEl.className = 'chat-group chat-group-drop-target';
        groupEl.dataset.groupId = group.id;
        groupEl.setAttribute('data-group-id', group.id);

        const header = document.createElement('div');
        header.className = 'chat-group-header';

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'chat-group-toggle';
        toggleBtn.setAttribute('aria-label', group.is_expanded === false ? t('history.expandGroup') : t('history.collapseGroup'));
        toggleBtn.innerHTML = '<svg class="icon-svg" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';

        const title = document.createElement('span');
        title.className = 'chat-group-title';
        title.textContent = group.title || t('history.newGroup');
        title.addEventListener('click', (event) => {
            event.stopPropagation();
        });
        title.addEventListener('dblclick', (event) => {
            event.stopPropagation();
            startGroupRename(title, group.id);
        });

        const count = document.createElement('span');
        count.className = 'chat-group-count';
        count.textContent = String(sessions.length);

        const actions = document.createElement('div');
        actions.className = 'chat-group-actions';
        actions.appendChild(createIconButton(
            'chat-group-action-btn',
            t('history.renameGroup'),
            t('history.renameGroup'),
            '<svg class="icon-svg" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>',
            (event) => {
                event.stopPropagation();
                startGroupRename(title, group.id);
            }
        ));
        actions.appendChild(createIconButton(
            'chat-group-action-btn chat-group-delete-btn',
            t('history.deleteGroup'),
            t('history.deleteGroup'),
            '<svg class="icon-svg" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg>',
            async (event) => {
                event.stopPropagation();
                if (!(await showConfirm(t('history.confirmDeleteGroup'), t('history.deleteGroup')))) return;
                if (await deleteChatGroupAPI(group.id)) {
                    _chatGroups = _chatGroups.filter(item => item.id !== group.id);
                    _fullHistory = _fullHistory.map(chat => (
                        (chat.group_id || chat.groupId) === group.id ? { ...chat, group_id: null } : chat
                    ));
                    renderHistory(_fullHistory, state.currentSessionId, callbacks, _chatGroups);
                    showToast(t('history.groupDeleted'), 'success');
                } else {
                    showToast(t('history.groupDeleteFailed'), 'error');
                }
            }
        ));

        header.appendChild(toggleBtn);
        header.appendChild(title);
        header.appendChild(count);
        header.appendChild(actions);
        header.addEventListener('click', async () => {
            const nextExpanded = group.is_expanded === false;
            const updated = await updateChatGroupAPI(group.id, { is_expanded: nextExpanded });
            if (updated) {
                updateCachedChatGroup(group.id, { is_expanded: updated.is_expanded });
                renderHistory(_fullHistory, state.currentSessionId, callbacks, _chatGroups);
            }
        });
        groupEl.appendChild(header);

        const list = document.createElement('div');
        list.className = 'chat-group-session-list';
        if (group.is_expanded === false && !searchTerm) {
            list.hidden = true;
            groupEl.classList.add('collapsed');
        }

        if (sessions.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'chat-group-empty';
            empty.textContent = t('history.dragIntoGroup');
            list.appendChild(empty);
        } else {
            const ordered = sortHistoryByPinnedThenTimestamp(sessions);
            renderDateGroups(ordered, currentSessionId, callbacks, list);
        }

        groupEl.appendChild(list);
        elements.historyList.appendChild(groupEl);
    });
}

function renderDateGroups(history, currentSessionId, callbacks, target = elements.historyList) {
    const groups = groupChatsByDate(history);
    const groupOrder = ['今天', '昨天', '本周', '更早'];

    groupOrder.forEach(groupName => {
        const items = groups[groupName];
        if (items.length === 0) return;

        const group = document.createElement('div');
        group.className = 'history-group';

        const header = document.createElement('div');
        header.className = 'history-group-header';
        header.textContent = t(`history.date.${groupName}`);
        group.appendChild(header);

        items.forEach(chat => {
            group.appendChild(createHistoryItem(chat, currentSessionId, callbacks));
        });

        target.appendChild(group);
    });
}

function renderUngroupedDropTarget(hasGroups, isEmpty = false) {
    const dropTarget = document.createElement('div');
    dropTarget.className = 'ungrouped-drop-target chat-group-drop-target';
    dropTarget.dataset.groupId = '';
    dropTarget.setAttribute('data-group-id', '');

    if (hasGroups) {
        const label = document.createElement('div');
        label.className = 'history-group-header ungrouped-group-header';
        label.textContent = t('history.ungrouped');
        dropTarget.appendChild(label);
    }

    if (isEmpty) {
        const empty = document.createElement('div');
        empty.className = 'chat-group-empty';
        empty.textContent = t('history.dragOut');
        dropTarget.appendChild(empty);
    }

    elements.historyList.appendChild(dropTarget);
}

function renderPinnedGroup(pinnedChats, currentSessionId, callbacks) {
    const ordered = sortHistoryByPinnedThenTimestamp(pinnedChats);
    const groupEl = document.createElement('div');
    groupEl.className = 'history-pinned-group';

    const header = document.createElement('div');
    header.className = 'history-group-header pinned-group-header';
    header.innerHTML = `<svg class="icon-svg" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"></path><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"></path></svg><span>${t('common.pinned')}</span>`;
    groupEl.appendChild(header);

    const list = document.createElement('div');
    list.className = 'history-pinned-list';
    ordered.forEach(chat => {
        list.appendChild(createHistoryItem(chat, currentSessionId, callbacks));
    });
    groupEl.appendChild(list);
    elements.historyList.appendChild(groupEl);
}

export function renderHistory(history, currentSessionId, callbacks, groups = _chatGroups, options = {}) {
    const visibleHistory = history || [];
    if (options.updateCache !== false) {
        _fullHistory = visibleHistory;
    }
    if (Array.isArray(groups)) {
        _chatGroups = groups;
    }

    const searchTerm = options.searchTermOverride !== undefined
        ? String(options.searchTermOverride || '').trim().toLowerCase()
        : (elements.historySearchInput ? elements.historySearchInput.value.trim().toLowerCase() : '');

    elements.historyList.innerHTML = '';

    let filtered = visibleHistory;
    if (searchTerm && !options.skipLocalFilter) {
        const terms = searchTerm.split(/\s+/).filter(t => t);
        filtered = visibleHistory.filter(chat => {
            const title = (chat.title || t('history.newChat')).toLowerCase();
            return terms.every(term => title.includes(term));
        });
    }

    const { map: groupedSessions, ungrouped } = getGroupSessionMap(filtered, _chatGroups);
    const pinnedUngrouped = ungrouped.filter(chat => chat.is_pinned);
    const restUngrouped = ungrouped.filter(chat => !chat.is_pinned);
    const hasGroups = _chatGroups.length > 0;
    const hasHistory = filtered.length > 0;

    if (!hasGroups && !hasHistory) {
        if (searchTerm) {
            renderEmptyHistory('search_off', t('history.noResults'));
        } else {
            renderEmptyHistory('chat_bubble_outline', t('history.noHistory'));
        }
        return;
    }

    renderChatGroups(_chatGroups, groupedSessions, currentSessionId, callbacks, searchTerm);

    if (pinnedUngrouped.length > 0) {
        renderPinnedGroup(pinnedUngrouped, currentSessionId, callbacks);
    }

    if (restUngrouped.length > 0) {
        renderUngroupedDropTarget(hasGroups || pinnedUngrouped.length > 0);
        renderDateGroups(restUngrouped, currentSessionId, callbacks);
    } else if (searchTerm && _chatGroups.length === 0 && pinnedUngrouped.length === 0) {
        renderEmptyHistory('search_off', '未找到匹配的对话');
    } else if (hasGroups && hasHistory && pinnedUngrouped.length === 0) {
        renderUngroupedDropTarget(true, true);
    }

    setupHistoryDragAndDrop(callbacks);
}

async function refreshHistoryView(callbacks) {
    const [history, groups] = await Promise.all([fetchHistory(), fetchChatGroups()]);
    renderHistory(history, state.currentSessionId, callbacks, groups);
}

function startRename(titleSpan, chatId, callbacks) {
    const currentTitle = titleSpan.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'history-title-edit';
    input.value = currentTitle;

    titleSpan.replaceWith(input);
    input.focus();
    input.select();

    async function save() {
        const newTitle = input.value.trim() || currentTitle;
        const newSpan = document.createElement('span');
        newSpan.className = 'history-title';
        newSpan.textContent = newTitle;
        newSpan.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            startRename(newSpan, chatId, callbacks);
        });
        input.replaceWith(newSpan);

        if (newTitle !== currentTitle) {
            const ok = await renameChatAPI(chatId, newTitle);
            if (ok) {
                updateCachedHistoryTitle(chatId, newTitle);
                showToast(t('history.renamed'), 'success');
            } else {
                newSpan.textContent = currentTitle;
                showToast(t('history.renameFailed'), 'warning');
            }
        }
    }

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
        } else if (e.key === 'Escape') {
            input.value = currentTitle;
            input.blur();
        }
    });
    input.addEventListener('blur', save);
}

function startGroupRename(titleSpan, groupId) {
    const currentTitle = titleSpan.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'history-title-edit chat-group-title-edit';
    input.value = currentTitle;

    titleSpan.replaceWith(input);
    input.focus();
    input.select();

    async function save() {
        const newTitle = input.value.trim() || currentTitle;
        const newSpan = document.createElement('span');
        newSpan.className = 'chat-group-title';
        newSpan.textContent = newTitle;
        newSpan.addEventListener('click', (event) => {
            event.stopPropagation();
        });
        newSpan.addEventListener('dblclick', (event) => {
            event.stopPropagation();
            startGroupRename(newSpan, groupId);
        });
        input.replaceWith(newSpan);

        if (newTitle !== currentTitle) {
            const updated = await updateChatGroupAPI(groupId, { title: newTitle });
            if (updated) {
                updateCachedChatGroup(groupId, { title: updated.title });
                showToast(t('history.groupRenamed'), 'success');
            } else {
                newSpan.textContent = currentTitle;
                showToast(t('history.groupRenameFailed'), 'error');
            }
        }
    }

    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            input.blur();
        } else if (event.key === 'Escape') {
            input.value = currentTitle;
            input.blur();
        }
    });
    input.addEventListener('blur', save);
}

export function updateActiveHistoryItem(sessionId) {
    document.querySelectorAll('.history-item').forEach(item => {
        item.classList.toggle('active', item.dataset.id === sessionId);
    });
}

export function setupHistoryDragAndDrop(callbacks) {
    document.querySelectorAll('.chat-group-drop-target').forEach(target => {
        target.addEventListener('dragover', (event) => {
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            target.classList.add('drag-over');
        });
        target.addEventListener('dragleave', (event) => {
            if (target.contains(event.relatedTarget)) return;
            target.classList.remove('drag-over');
        });
        target.addEventListener('drop', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            target.classList.remove('drag-over');
            const sessionId = event.dataTransfer.getData('sessionId') || event.dataTransfer.getData('text/plain');
            if (!sessionId) return;
            const groupId = target.dataset.groupId || null;
            if (await moveChatToGroupAPI(sessionId, groupId)) {
                await refreshHistoryView(callbacks);
                showToast(groupId ? t('history.movedToGroup') : t('history.movedUngrouped'), 'success');
            } else {
                showToast(t('history.moveFailed'), 'error');
            }
        });
    });
    // Per-item drag-over line indicator (insertion feedback) — mirror AMC drag ghost inset
    document.querySelectorAll('.history-item').forEach(item => {
        item.addEventListener('dragover', (event) => {
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            // Avoid self-highlight
            if (item.classList.contains('is-dragging') || item.classList.contains('dragging')) return;
            item.classList.add('drag-over');
        });
        item.addEventListener('dragleave', (event) => {
            if (item.contains(event.relatedTarget)) return;
            item.classList.remove('drag-over');
        });
        item.addEventListener('drop', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            item.classList.remove('drag-over');
            const sessionId = event.dataTransfer.getData('sessionId') || event.dataTransfer.getData('text/plain');
            const targetId = item.dataset.id;
            if (!sessionId || sessionId === targetId) return;
            // Dropping onto item => move to same group as target (or ungrouped if no group)
            const targetGroup = item.closest('.chat-group-drop-target, .ungrouped-drop-target');
            const groupId = targetGroup?.dataset?.groupId || null;
            if (await moveChatToGroupAPI(sessionId, groupId)) {
                await refreshHistoryView(callbacks);
                showToast(groupId ? t('history.movedToGroup') : t('history.movedUngrouped'), 'success');
            } else {
                showToast(t('history.moveFailed'), 'error');
            }
        });
    });
}

export function setupHistoryGroups(callbacks) {
    const newGroupBtn = document.getElementById('new-group-btn');
    newGroupBtn?.addEventListener('click', async () => {
        const group = await createChatGroupAPI(t('history.newGroup'));
        if (group) {
            _chatGroups = [group, ..._chatGroups];
            renderHistory(_fullHistory, state.currentSessionId, callbacks, _chatGroups);
            showToast(t('history.groupCreated'), 'success');
        } else {
            showToast(t('history.groupCreateFailed'), 'error');
        }
    });
}

export function openHistorySearch() {
    const historySearchOpenBtn = document.getElementById('history-search-open-btn');
    const historySearchBox = document.getElementById('history-search-box');
    const historySearchInput = document.getElementById('history-search-input');
    if (!historySearchOpenBtn || !historySearchBox || !historySearchInput) return;

    historySearchOpenBtn.hidden = true;
    historySearchBox.hidden = false;
    requestAnimationFrame(() => {
        historySearchInput.focus();
        historySearchInput.select();
    });
}

function closeHistorySearch(callbacks) {
    const historySearchOpenBtn = document.getElementById('history-search-open-btn');
    const historySearchBox = document.getElementById('history-search-box');
    const historySearchInput = document.getElementById('history-search-input');
    if (!historySearchOpenBtn || !historySearchBox || !historySearchInput) return;

    historySearchInput.value = '';
    _historySearchRequestSeq += 1;
    historySearchBox.hidden = true;
    historySearchOpenBtn.hidden = false;
    renderHistory(getCachedHistory(), state.currentSessionId, callbacks, getCachedGroups());
    historySearchOpenBtn.focus();
}

export function setupHistorySearch(callbacks) {
    const searchInput = document.getElementById('history-search-input');
    const searchOpenBtn = document.getElementById('history-search-open-btn');
    const searchCloseBtn = document.getElementById('history-search-close-btn');
    if (!searchInput) return;

    searchOpenBtn?.addEventListener('click', openHistorySearch);
    searchCloseBtn?.addEventListener('click', () => closeHistorySearch(callbacks));

    let searchTimeout;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(async () => {
            const term = searchInput.value.trim();
            const requestSeq = ++_historySearchRequestSeq;
            if (!term) {
                renderHistory(getCachedHistory(), state.currentSessionId, callbacks, getCachedGroups());
                return;
            }

            const results = await searchHistory(term);
            if (requestSeq !== _historySearchRequestSeq) return;
            renderHistory(results, state.currentSessionId, callbacks, getCachedGroups(), {
                updateCache: false,
                skipLocalFilter: true,
                searchTermOverride: term,
            });
        }, 120);
    });
    searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeHistorySearch(callbacks);
        }
    });
}
