import {
    createCopyButton,
    createDeleteMessageButton,
    createEditMessageButton,
    createExportMessageButton,
    createForkMessageButton,
    createMessageActionRail,
    createRegenerateButton
} from './utils.js?v=13';
import { extractSources, hasCitationSources, linkCitationsInElement, normalizeCitationSources, renderWithCitations } from './source-renderer.js?v=12';
import { getInlineLiveArtifact, renderLiveArtifactsForMessage } from './live-artifacts.js?v=50';
import { bindCitationEvidenceClicks } from './evidence-panel.js?v=5';
import { state } from './state.js?v=5';
import { t } from './i18n.js?v=1';

const USER_MESSAGE_COLLAPSE_CHARACTER_THRESHOLD = 600;
const USER_MESSAGE_COLLAPSE_LINE_THRESHOLD = 8;
const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * 自定义确认弹窗（替代浏览器原生 confirm）。
 * @param {string} message - 提示信息
 * @param {string} [title='确认'] - 弹窗标题
 * @returns {Promise<boolean>}
 */
export function showConfirm(message, title = t('ui.confirmTitle')) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        const titleEl = document.getElementById('confirm-title');
        const messageEl = document.getElementById('confirm-message');
        const okBtn = document.getElementById('confirm-ok-btn');
        const cancelBtn = document.getElementById('confirm-cancel-btn');
        const closeBtn = document.getElementById('confirm-close-btn');

        // 焦点恢复：记住打开前焦点所在元素，关闭后归还
        const previouslyFocused = document.activeElement;

        titleEl.textContent = title;
        messageEl.textContent = message;
        modal.classList.add('active');

        // 把焦点移入模态：默认聚焦「取消」(安全默认)，键盘用户可立即 Tab/Enter
        requestAnimationFrame(() => cancelBtn.focus());

        // 焦点陷阱：Tab/Shift+Tab 在模态内可聚焦元素间循环
        const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

        function cleanup(result) {
            modal.classList.remove('active');
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            closeBtn.removeEventListener('click', onCancel);
            closeBtn.removeEventListener('keydown', onCloseKey);
            document.removeEventListener('keydown', onKeyDown);
            modal.removeEventListener('click', onBackdropClick);
            // 焦点归还
            if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
                previouslyFocused.focus();
            }
            resolve(result);
        }

        function onOk() { cleanup(true); }
        function onCancel() { cleanup(false); }
        function onKeyDown(event) {
            if (event.key === 'Escape') {
                cleanup(false);
                return;
            }
            if (event.key !== 'Tab') return;
            const focusable = Array.from(modal.querySelectorAll(FOCUSABLE))
                .filter(el => !el.disabled && el.offsetParent !== null);
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
        function onCloseKey(event) {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onCancel();
            }
        }
        function onBackdropClick(event) {
            if (event.target === modal) {
                cleanup(false);
            }
        }

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        closeBtn.addEventListener('click', onCancel);
        closeBtn.addEventListener('keydown', onCloseKey);
        document.addEventListener('keydown', onKeyDown);
        modal.addEventListener('click', onBackdropClick);
    });
}

export const elements = {
    chatContainer: null,
    historyList: null,
    heroSection: null,
    userInput: null,
    sendBtn: null,
    newChatBtn: null,
    settingsModal: null,
    sidebar: null,
    expandSidebarBtn: null,
    collapseSidebarBtn: null,
    closeSidebarBtn: null,
    mobileOverlay: null,
    scrollNav: null,
    scrollToTopBtn: null,
    scrollToBottomBtn: null,
    historySearchInput: null,
    editMessageBanner: null,
    cancelEditBtn: null,
    editMessageBannerText: null,
    inputArea: null,
};

export function initUI() {
    elements.chatContainer = document.getElementById('chat-container');
    elements.historyList = document.getElementById('history-list');
    elements.heroSection = document.getElementById('hero-section');
    elements.userInput = document.getElementById('user-input');
    elements.sendBtn = document.getElementById('send-btn');
    elements.newChatBtn = document.getElementById('new-chat-btn');
    elements.settingsModal = document.getElementById('settings-modal');
    elements.sidebar = document.getElementById('sidebar');
    elements.expandSidebarBtn = document.getElementById('expand-sidebar-btn');
    elements.collapseSidebarBtn = document.getElementById('collapse-sidebar-btn');
    elements.closeSidebarBtn = document.getElementById('close-sidebar-btn');
    elements.mobileOverlay = document.getElementById('mobile-overlay');
    elements.scrollNav = document.getElementById('scroll-nav');
    elements.scrollToTopBtn = document.getElementById('scroll-to-top-btn');
    elements.scrollToBottomBtn = document.getElementById('scroll-to-bottom-btn');
    elements.historySearchInput = document.getElementById('history-search-input');
    elements.editMessageBanner = document.getElementById('edit-message-banner');
    elements.cancelEditBtn = document.getElementById('cancel-edit-btn');
    elements.editMessageBannerText = document.getElementById('edit-message-banner-text');
    elements.inputArea = document.getElementById('input-area');

    initScrollBehavior();
}

function initScrollBehavior() {
    const { chatContainer, scrollToBottomBtn, scrollToTopBtn, scrollNav } = elements;
    if (!chatContainer) return;

    chatContainer.addEventListener('scroll', () => {
        const { scrollTop, scrollHeight, clientHeight } = chatContainer;
        const scrollBottom = scrollHeight - scrollTop - clientHeight;

        // AMC-style scroll navigation: show ↓ when scrolled up from the bottom,
        // show ↑ when scrolled down from the top.
        if (scrollToBottomBtn) scrollToBottomBtn.classList.toggle('visible', scrollBottom > 100);
        if (scrollToTopBtn) scrollToTopBtn.classList.toggle('visible', scrollTop > 100);
    });

    if (scrollToBottomBtn) {
        scrollToBottomBtn.addEventListener('click', () => scrollToBottom());
    }
    if (scrollToTopBtn) {
        scrollToTopBtn.addEventListener('click', () => {
            if (chatContainer.scrollTo) {
                chatContainer.scrollTo({ top: 0, behavior: 'smooth' });
            } else {
                chatContainer.scrollTop = 0;
            }
        });
    }
    if (scrollNav) scrollNav.classList.add('is-initialized');
}

function findPreviousUserContent(messages, fromIndex) {
    for (let i = fromIndex - 1; i >= 0; i -= 1) {
        if (messages[i]?.role === 'user' && messages[i]?.content) {
            return messages[i].content;
        }
    }
    return '';
}

function findPreviousUserIndex(messages, fromIndex) {
    for (let i = fromIndex - 1; i >= 0; i -= 1) {
        if (messages[i]?.role === 'user' && messages[i]?.content) {
            return i;
        }
    }
    return null;
}

function parseMessageTimestamp(value) {
    if (!value) return null;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
}

function isGroupedWithPrevious(message, previousMessage) {
    if (!message || !previousMessage) return false;
    if (normalizeMessageRole(message.role) !== normalizeMessageRole(previousMessage.role)) return false;
    const currentTime = parseMessageTimestamp(message.timestamp);
    const previousTime = parseMessageTimestamp(previousMessage.timestamp);
    if (currentTime === null || previousTime === null) return false;
    return currentTime - previousTime >= 0 && currentTime - previousTime < MESSAGE_GROUP_WINDOW_MS;
}

function shouldCollapseUserMessageContent(content) {
    const text = String(content || '');
    if (text.length > USER_MESSAGE_COLLAPSE_CHARACTER_THRESHOLD) return true;
    return (text.match(/\n/g)?.length || 0) + 1 > USER_MESSAGE_COLLAPSE_LINE_THRESHOLD;
}

function normalizeMessageRole(role) {
    return role === 'model' ? 'assistant' : role;
}

function createMessageAvatar(role) {
    const avatar = document.createElement('div');
    const avatarRoleClass = role === 'assistant'
        ? 'assistant-avatar'
        : role === 'error'
            ? 'error-avatar'
            : 'user-avatar';
    avatar.className = `message-avatar ${avatarRoleClass}`;
    avatar.setAttribute('aria-hidden', 'true');

    if (role === 'assistant') {
        const img = document.createElement('img');
        // Use transparent icon (same as sidebar), not the white-background favicon.
        img.src = '/static/assets/justsearch-icon.png?v=11';
        img.alt = '';
        avatar.appendChild(img);
    } else if (role === 'error') {
        const icon = document.createElement('span');
        icon.className = 'material-symbols-rounded';
        icon.textContent = 'warning';
        avatar.appendChild(icon);
    } else {
        const icon = document.createElement('span');
        icon.className = 'material-symbols-rounded';
        icon.textContent = 'person';
        avatar.appendChild(icon);
    }

    return avatar;
}

export function createMessageShell(role, options = {}) {
    const normalizedRole = normalizeMessageRole(role);
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${normalizedRole}`;
    msgDiv.dataset.messageRole = normalizedRole;
    if (options.grouped) {
        msgDiv.classList.add('grouped');
    }
    if (options.timestamp) {
        msgDiv.dataset.messageTimestamp = options.timestamp;
    }

    const rowDiv = document.createElement('div');
    rowDiv.className = 'message-row';

    const sideColumn = document.createElement('div');
    sideColumn.className = 'message-side';
    sideColumn.appendChild(createMessageAvatar(normalizedRole));

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content message-content-container';

    if (normalizedRole === 'user') {
        rowDiv.appendChild(contentDiv);
        rowDiv.appendChild(sideColumn);
    } else {
        rowDiv.appendChild(sideColumn);
        rowDiv.appendChild(contentDiv);
    }

    msgDiv.appendChild(rowDiv);
    return { msgDiv, rowDiv, contentDiv, sideColumn };
}

function renderUserMessageContent(content, contentDiv) {
    const textDiv = document.createElement('div');
    textDiv.className = 'message-user-text';
    textDiv.textContent = content || '';
    contentDiv.appendChild(textDiv);

    if (!shouldCollapseUserMessageContent(content)) return;

    contentDiv.classList.add('is-collapsible', 'is-collapsed');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'message-collapse-toggle';
    toggle.setAttribute('aria-expanded', 'false');

    const label = document.createElement('span');
    label.textContent = t('ui.expand');
    const icon = document.createElement('span');
    icon.className = 'material-symbols-rounded';
    icon.textContent = 'expand_more';
    toggle.appendChild(label);
    toggle.appendChild(icon);

    toggle.addEventListener('click', () => {
        const expanded = contentDiv.classList.toggle('is-expanded');
        contentDiv.classList.toggle('is-collapsed', !expanded);
        toggle.setAttribute('aria-expanded', String(expanded));
        label.textContent = expanded ? t('ui.collapse') : t('ui.expand');
        icon.textContent = expanded ? 'expand_less' : 'expand_more';
    });

    contentDiv.appendChild(toggle);
}

export function renderMessages(messages, actionCallbacks = {}) {
    elements.chatContainer.innerHTML = '';
    
    if (!messages || messages.length === 0) {
        elements.heroSection.style.display = 'block';
        elements.chatContainer.appendChild(elements.heroSection);
        return;
    }
    
    elements.heroSection.style.display = 'none';
    
    messages.forEach((msg, idx) => {
        const previousMessage = idx > 0 ? messages[idx - 1] : null;
        const previousUserIndex = normalizeMessageRole(msg.role) === 'assistant'
            ? findPreviousUserIndex(messages, idx)
            : null;
        appendMessage(msg.role, msg.content, msg.logs, msg.sources, msg.stats, idx, msg.timestamp, {
            ...actionCallbacks,
            isGrouped: isGroupedWithPrevious(msg, previousMessage),
            previousUserContent: previousUserIndex !== null ? messages[previousUserIndex].content : '',
            previousUserIndex,
            citations: msg.citations,
        });
    });

    scrollToBottom();
}

/**
 * AMC: no inline bubble editor — stage content into the composer.
 * onEdit receives { content, messageIndex, mode }.
 */
function stageMessageForEdit(content, messageIndex, actionCallbacks = {}, mode = 'resend') {
    if (typeof actionCallbacks.onEdit === 'function') {
        actionCallbacks.onEdit({
            content,
            messageIndex,
            mode,
        });
        return;
    }

    if (!elements.userInput) return;
    elements.userInput.value = content;
    elements.userInput.dispatchEvent(new Event('input', { bubbles: true }));
    elements.userInput.focus({ preventScroll: true });
    scrollToBottom();
}

function createMessageActions({ role, content, msgDiv, messageIndex, actionCallbacks }) {
    const normalizedRole = normalizeMessageRole(role);
    const buttons = [createCopyButton(content)];
    if (content && typeof content === 'string' && content.trim()) {
        buttons.push(createExportMessageButton(content));
    }

    // AMC user Edit3 → resend mode (truncate from this user msg + re-send).
    if (normalizedRole === 'user') {
        buttons.push(createEditMessageButton(content, (value) => {
            stageMessageForEdit(value, messageIndex, actionCallbacks, 'resend');
        }));
        // Fork: branch a new chat from this user message's index (inclusive).
        if (messageIndex !== null && messageIndex !== undefined) {
            buttons.push(createForkMessageButton(async () => {
                const { forkChatAPI } = await import('./api.js?v=14');
                const { showToast } = await import('./toast.js');
                const summary = await forkChatAPI(state.currentSessionId, messageIndex);
                if (summary && summary.id) {
                    showToast(t('chat.forkedToNewSession'), 'success');
                    if (typeof actionCallbacks.onForked === 'function') {
                        await actionCallbacks.onForked();
                    }
                } else {
                    showToast(t('chat.forkFailed'), 'error');
                }
            }));
        }
    }

    // AMC assistant Retry → regenerate from previous user message (truncate at user).
    if (
        normalizedRole === 'assistant'
        && actionCallbacks.previousUserContent
        && typeof actionCallbacks.onRegenerate === 'function'
    ) {
        buttons.push(createRegenerateButton(() => actionCallbacks.onRegenerate(
            actionCallbacks.previousUserContent,
            {
                messageIndex,
                previousUserIndex: actionCallbacks.previousUserIndex ?? null,
            },
        )));
    }

    if (messageIndex !== null && messageIndex !== undefined) {
        buttons.push(createDeleteMessageButton(async () => {
            if (!await showConfirm(t('ui.confirmDeleteMessage'), t('ui.deleteMessage'))) return;
            const { deleteMessageAPI } = await import('./api.js?v=14');
            const ok = await deleteMessageAPI(state.currentSessionId, messageIndex, content);
            if (ok) {
                msgDiv.remove();
                if (typeof actionCallbacks.onMessageDeleted === 'function') {
                    await actionCallbacks.onMessageDeleted(messageIndex);
                }
            } else {
                const { showToast } = await import('./toast.js');
                showToast(t('ui.deleteFailed'), 'error');
            }
        }));
    }

    return createMessageActionRail(buttons, normalizedRole === 'assistant' ? t('ui.assistantActions') : t('ui.userActions'));
}

export function appendMessage(role, content, logs = null, sources = null, stats = null, messageIndex = null, timestamp = null, actionCallbacks = {}) {
    const normalizedRole = normalizeMessageRole(role);
    const { msgDiv, contentDiv, sideColumn } = createMessageShell(role, {
        grouped: Boolean(actionCallbacks.isGrouped),
        timestamp
    });
    if (messageIndex !== null && messageIndex !== undefined && Number.isFinite(Number(messageIndex))) {
        msgDiv.dataset.messageIndex = String(Math.floor(Number(messageIndex)));
    }
    const citations = Array.isArray(actionCallbacks.citations) ? actionCallbacks.citations : [];

    if (normalizedRole === 'assistant' && logs && logs.length > 0) {
         const siteCount = (stats && stats.sites_searched) ? stats.sites_searched : normalizeCitationSources(sources).length;
         contentDiv.appendChild(createLogContainer(logs, siteCount));
    }

    if (normalizedRole === 'assistant') {
        contentDiv.classList.add('markdown-body');
        const resolvedSources = hasCitationSources(sources) ? sources : extractSources(content);
        const answerBody = document.createElement('div');
        answerBody.className = 'message-answer-body';
        answerBody.dataset.liveArtifactsMessageId = `history-${messageIndex ?? Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // Live Artifacts 模式下保留内联 HTML 走 iframe 预览（样式完整、引用照常链接）；
        // 仅在该模式关闭时，遇到意外 HTML 才退回带引用的 Markdown 渲染。
        // AMC-aligned: Live Artifacts mode always prefers a single themed iframe
        // (native HTML or Markdown coerced to HTML). Only fall back to bubble
        // Markdown when the mode is off and there is no standalone HTML artifact.
        const suppressUnfencedInlineArtifact = !state.liveArtifactsMode && hasCitationSources(resolvedSources);
        const liveArtifactOptions = {
            suppressUnfencedInlineArtifact,
            liveArtifactsMode: Boolean(state.liveArtifactsMode),
        };
        // Probe once and reuse — avoids double extract/buildSrcdoc on history render.
        const inlineArtifact = getInlineLiveArtifact(
            content,
            answerBody.dataset.liveArtifactsMessageId,
            false,
            liveArtifactOptions,
        );
        if (!inlineArtifact) {
            answerBody.innerHTML = renderWithCitations(content, resolvedSources);
        }
        renderLiveArtifactsForMessage(answerBody, content, {
            messageId: answerBody.dataset.liveArtifactsMessageId,
            isStreaming: false,
            sources: resolvedSources,
            citations,
            inlineArtifact,
            ...liveArtifactOptions,
        });
        linkCitationsInElement(answerBody, resolvedSources);
        bindCitationEvidenceClicks(answerBody, { sources: resolvedSources, citations });
        contentDiv.appendChild(answerBody);
    } else {
        renderUserMessageContent(content, contentDiv);
    }

    sideColumn.appendChild(createMessageActions({ role: normalizedRole, content, msgDiv, messageIndex, actionCallbacks }));

    elements.chatContainer.appendChild(msgDiv);
    return { msgDiv, contentDiv };
}

export function scrollToBottom() {
    // 尊重 prefers-reduced-motion；流式期间用 instant 避免每帧 smooth 抖动
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    elements.chatContainer.scrollTo({
        top: elements.chatContainer.scrollHeight,
        behavior: reducedMotion ? 'auto' : 'smooth'
    });
}

function classifyLogMessage(message) {
    if (/search|搜索|query/i.test(message)) return 'log-search';
    if (/crawl|爬取|fetch|reading|读取|阅读/i.test(message)) return 'log-crawl';
    if (/analyz|分析|assess|评估|总结|生成/i.test(message)) return 'log-analysis';
    if (/error|失败|fail|错误/i.test(message)) return 'log-error';
    return '';
}

export function createLogEntry(message, timestamp = '') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${classifyLogMessage(message)}`.trim();

    const dot = document.createElement('span');
    dot.className = 'log-entry-dot';
    dot.setAttribute('aria-hidden', 'true');
    entry.appendChild(dot);

    if (timestamp) {
        const tsSpan = document.createElement('span');
        tsSpan.className = 'log-timestamp';
        tsSpan.textContent = timestamp;
        entry.appendChild(tsSpan);
    }

    const msgSpan = document.createElement('span');
    msgSpan.className = 'log-entry-message';
    msgSpan.textContent = message;
    entry.appendChild(msgSpan);

    return entry;
}

function wireLogToggle(logSummary, logDetails, expandIcon) {
    const toggle = () => {
        const isOpen = logDetails.classList.toggle('open');
        expandIcon.classList.toggle('expanded', isOpen);
        logSummary.setAttribute('aria-expanded', String(isOpen));
    };

    logSummary.onclick = toggle;
    logSummary.onkeydown = (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggle();
    };
}

export function createLogContainer(logs, sourceCount = 0) {
    const logContainer = document.createElement('div');
    logContainer.className = 'log-container message-thoughts-block completed';
    
    const logSummary = document.createElement('div');
    logSummary.className = 'log-summary';
    logSummary.setAttribute('role', 'button');
    logSummary.setAttribute('tabindex', '0');
    logSummary.setAttribute('aria-expanded', 'false');
    
    const statusLeft = document.createElement('div');
    statusLeft.className = 'log-status-left';
    
    const spinner = document.createElement('span');
    spinner.className = 'material-symbols-rounded log-spinner completed';
    spinner.textContent = 'check_circle';
    
    const statusText = document.createElement('span');
    statusText.className = 'log-status-text';
    statusText.textContent = sourceCount > 0 ? t('ui.searchCompletedSources', { count: sourceCount }) : t('ui.thinkingStatus');
    
    statusLeft.appendChild(spinner);
    statusLeft.appendChild(statusText);
    
    const expandIcon = document.createElement('span');
    expandIcon.className = 'material-symbols-rounded expand-icon';
    expandIcon.textContent = 'expand_more';
    
    logSummary.appendChild(statusLeft);
    logSummary.appendChild(expandIcon);
    
    const logDetails = document.createElement('div');
    logDetails.className = 'log-details';
    
    if (logs && Array.isArray(logs)) {
        logs.forEach(log => {
            logDetails.appendChild(createLogEntry(log));
        });
    }
    
    wireLogToggle(logSummary, logDetails, expandIcon);
    
    logContainer.appendChild(logSummary);
    logContainer.appendChild(logDetails);
    
    return logContainer;
}

export function createDynamicLogContainer() {
    const logContainer = document.createElement('div');
    logContainer.className = 'log-container message-thoughts-block';
    
    const logSummary = document.createElement('div');
    logSummary.className = 'log-summary';
    logSummary.setAttribute('role', 'button');
    logSummary.setAttribute('tabindex', '0');
    logSummary.setAttribute('aria-expanded', 'true');
    
    const statusLeft = document.createElement('div');
    statusLeft.className = 'log-status-left';
    
    const spinner = document.createElement('span');
    spinner.className = 'material-symbols-rounded log-spinner rotating';
    spinner.textContent = 'progress_activity';
    
    const statusText = document.createElement('span');
    statusText.className = 'log-status-text';
    statusText.textContent = t('ui.thinking');
    
    statusLeft.appendChild(spinner);
    statusLeft.appendChild(statusText);
    
    const expandIcon = document.createElement('span');
    expandIcon.className = 'material-symbols-rounded expand-icon expanded';
    expandIcon.textContent = 'expand_more';
    
    logSummary.appendChild(statusLeft);
    logSummary.appendChild(expandIcon);
    
    const logDetails = document.createElement('div');
    logDetails.className = 'log-details open';
    
    wireLogToggle(logSummary, logDetails, expandIcon);
    
    logContainer.appendChild(logSummary);
    logContainer.appendChild(logDetails);
    
    return { logContainer, logSummary, logDetails, spinner, statusText, expandIcon };
}

/**
 * Copy entire conversation to clipboard as plain text
 */
export function copyConversation(messages) {
    if (!messages || messages.length === 0) return;
    const text = messages.map(msg => {
        const role = msg.role === 'user' ? '👤 You' : '🤖 JustSearch';
        const content = msg.content || '';
        return `${role}:
${content}`;
    }).join(`

---

`);
    navigator.clipboard.writeText(text).catch(err => console.error('Copy failed:', err));
}
