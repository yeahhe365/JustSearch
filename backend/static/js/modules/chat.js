import {
    abortActiveStream,
    bumpChatEpoch,
    clearEditingMessage,
    isChatEpochCurrent,
    isEditingMessage,
    setEditingMessage,
    setLastUserMessageIndex,
    setSessionMessageCount,
    state,
    setAbortController,
    setCurrentSessionId,
    setIsProcessing,
    setLiveArtifactsMode,
} from './state.js?v=5';
import { createCopyButton, createMessageActionRail, createRegenerateButton, encodePathSegment } from './utils.js?v=14';
import { updateActiveHistoryItem } from './history-view.js?v=28';
import { createDynamicLogContainer, createLogEntry, scrollToBottom, appendMessage, renderMessages, createMessageShell, renderAssistantAnswerBody } from './ui.js?v=43';
import { hasCitationSources } from './source-renderer.js?v=12';
import {
    applyIntensityPresetToSettings,
    getIntensityPreset,
    getIntensityPresetHint,
    getIntensityPresetLabel,
    matchIntensityPreset,
    updateIntensityUI,
} from './search-intensity.js?v=3';
import { showToast } from './toast.js';
import * as API from './api.js?v=14';
import { ensureBridgeConnected, warnIfBridgeDisconnected } from './bridge.js?v=9';
import { setupComposerExtras } from './composer-extras.js?v=2';
import { setupTextSelectionToolbar } from './text-selection.js?v=1';
import { playCompletionSound, showCompletionNotification } from './completion-feedback.js?v=1';
import { t } from './i18n.js?v=1';

// ---------------------------------------------------------------------------
// Per-session chat state & live-stream registry (concurrent conversations)
// ---------------------------------------------------------------------------
// A deep search takes a minute or two; switching sessions / starting a new chat
// must NOT abort it. Each stream owns a record here, its DOM subtree is detached
// (kept referenced) when the user navigates away, and it keeps running in the
// background writing to its own session's state. Returning to the session
// re-attaches the live bubbles.
const sessionStore = new Map(); // sessionId -> { mirror, count, lastUserIndex, lastUserMessage }

function ensureSessionState(sessionId) {
    let s = sessionStore.get(sessionId);
    if (!s) {
        s = { mirror: [], count: 0, lastUserIndex: null, lastUserMessage: '' };
        sessionStore.set(sessionId, s);
    }
    return s;
}

const activeStreams = new Map(); // provisionalKey -> live stream record
let currentViewStream = null;    // the stream currently owning the visible view

function chatRoute(sessionId) {
    return `/c/${encodePathSegment(sessionId)}`;
}

function resetComposerChrome(uiElements = {}) {
    const banner = uiElements?.editMessageBanner || document.getElementById('edit-message-banner');
    const inputArea = uiElements?.inputArea || document.getElementById('input-area');
    if (banner) banner.hidden = true;
    if (inputArea) inputArea.classList.remove('is-editing-message');
    if (uiElements?.userInput) {
        uiElements.userInput.placeholder = t('inputArea.placeholder');
    }
    if (!uiElements?.sendBtn) return;
    const sendBtnIcon = uiElements.sendBtn.querySelector('.material-symbols-rounded');
    if (sendBtnIcon) sendBtnIcon.textContent = 'send';
    uiElements.sendBtn.classList.remove('processing');
    uiElements.sendBtn.setAttribute('aria-label', t('inputArea.send'));
    uiElements.sendBtn.title = t('inputArea.send');
    const hasText = Boolean(uiElements.userInput?.value?.trim());
    uiElements.sendBtn.disabled = !hasText;
    uiElements.sendBtn.setAttribute('aria-disabled', hasText ? 'false' : 'true');
    try {
        syncQuickSettingsFromState();
    } catch {
        // settings UI may not be ready during early init
    }
}

/**
 * Hard-abort path (destructive reset / session deleted / tests): stop the current
 * stream, drop its record, bump epoch so stale SSE cannot re-bind the session,
 * and restore the send button. Does NOT keep the stream running in the background.
 */
export function abandonActiveChatWork(uiElements = {}) {
    abortActiveStream();
    if (currentViewStream) {
        activeStreams.delete(currentViewStream.provisionalKey);
        currentViewStream = null;
    }
    bumpChatEpoch();
    clearEditingMessage();
    setLastUserMessageIndex(null);
    setSessionMessageCount(0);
    resetComposerChrome(uiElements);
}

/**
 * Switch-away path: keep the current stream running in the background instead of
 * aborting it. Its DOM subtree is detached (but kept referenced) so the stream
 * keeps rendering into it invisibly; returning to the session re-attaches it (see
 * loadChat). The composer is reset because this view no longer owns a stream —
 * a background stream never mutates the visible send button or isProcessing.
 */
export function detachCurrentStream(uiElements = {}) {
    const rec = currentViewStream;
    if (rec && rec.attached) {
        rec.attached = false;
        if (rec.userNode) rec.userNode.remove();
        if (rec.msgDiv) rec.msgDiv.remove();
    }
    currentViewStream = null;
    bumpChatEpoch();
    setAbortController(null);
    setIsProcessing(false);
    clearEditingMessage();
    setLastUserMessageIndex(null);
    setSessionMessageCount(0);
    resetComposerChrome(uiElements);
}

/**
 * Incremental-stream gate (pure, exported for tests): decide whether a throttled
 * tick must run the full render pipeline. Renders when the buffer grew enough,
 * hit a block boundary, or has gone stale too long. Keeps per-tick cost decoupled
 * from total accumulated length (avoids O(n²) re-renders on every token).
 */
export function shouldRenderStreamTick({
    length,
    lastPushedLength,
    buffer,
    now,
    lastPushTime,
    minDeltaChars = 400,
    maxStalenessMs = 800,
    blockBoundaryRe = /\n\n|```/,
} = {}) {
    if (length === lastPushedLength) return false;
    if (length - lastPushedLength >= minDeltaChars) return true;
    if (lastPushedLength === 0) return true; // first push: render promptly
    if (blockBoundaryRe.test(String(buffer || '').slice(lastPushedLength))) return true;
    if (now - lastPushTime >= maxStalenessMs) return true;
    return false;
}

/**
 * 设置聊天处理器：发送消息、加载/删除对话、输入框自动调整等。
 */
// 搜索引擎 → 显示名（含 i18n 文案）。quick 切换与状态栏共用，避免漂移。
// 提升到模块级：syncQuickSettingsFromState（页面初始化即调用）也引用它。
const ENGINE_NAMES = {
    'duckduckgo': 'DuckDuckGo',
    'google': 'Google',
    'bing': 'Bing',
    'sogou': t('engine.sogou'),
    'brave': 'Brave Search',
    'baidu': t('engine.baidu'),
    'yandex': 'Yandex',
};

export function setupChatHandler(elements, renderHistory) {
    // 记录最后一条用户消息，用于重新生成
    let lastUserMessage = '';

    // 客户端所见的完整消息镜像({role, content} 序列)。服务端截断/删除操作
    // 携带该前缀做并发校验，避免下标漂移时静默删错/追加错位。仅在与服务端
    // 同步后(loadChat/发送成功)更新。
    let messagesMirror = [];

    // 全局滚动状态跟踪（只注册一次，避免内存泄漏）
    let userScrolled = false;
    const scrollHandler = () => {
        const { scrollTop, scrollHeight, clientHeight } = elements.chatContainer;
        userScrolled = (scrollHeight - scrollTop - clientHeight) > 100;
    };
    elements.chatContainer.addEventListener('scroll', scrollHandler);

    async function refreshHistory() {
        const [history, groups] = await Promise.all([
            API.fetchHistory(),
            API.fetchChatGroups()
        ]);
        renderHistory(history, state.currentSessionId, { onSelect: loadChat, onDelete: deleteChat }, groups);
    }

    function syncEditChrome() {
        const banner = elements.editMessageBanner || document.getElementById('edit-message-banner');
        const inputArea = elements.inputArea || document.getElementById('input-area');
        const bannerText = elements.editMessageBannerText || document.getElementById('edit-message-banner-text');
        const editing = isEditingMessage();
        if (banner) banner.hidden = !editing;
        if (inputArea) inputArea.classList.toggle('is-editing-message', editing);
        if (bannerText && editing) {
            bannerText.textContent = state.editMode === 'update'
                ? t('chat.editModeUpdateBanner')
                : t('chat.editModeBanner');
        }
        if (elements.sendBtn && !state.isProcessing) {
            const btnLabel = editing
                ? (state.editMode === 'update' ? t('chat.editBtnUpdate') : t('chat.editBtnResend'))
                : t('inputArea.send');
            elements.sendBtn.setAttribute('aria-label', btnLabel);
            elements.sendBtn.title = editing
                ? (state.editMode === 'update' ? t('chat.editBtnUpdate') : t('chat.editBtnResend'))
                : t('chat.send');
        }
    }

    function cancelEdit() {
        clearEditingMessage();
        syncEditChrome();
        if (elements.userInput) {
            elements.userInput.placeholder = t('inputArea.placeholder');
        }
    }

    /**
     * AMC edit: fill composer + set editingMessageIndex (resend by default).
     * @param {{ content: string, messageIndex?: number|null, mode?: 'resend'|'update' }|string} payload
     */
    function beginEditMessage(payload) {
        const content = typeof payload === 'string' ? payload : String(payload?.content || '');
        const messageIndex = typeof payload === 'object' && payload
            ? payload.messageIndex
            : null;
        const mode = typeof payload === 'object' && payload?.mode === 'update' ? 'update' : 'resend';

        if (!content) return;
        if (state.isProcessing) {
            // AMC stops generation when starting an edit.
            if (state.abortController) {
                state.abortController.abort();
                setAbortController(null);
            }
            setIsProcessing(false);
            syncQuickSettingsFromState();
        }

        if (messageIndex !== null && messageIndex !== undefined && Number.isFinite(Number(messageIndex))) {
            setEditingMessage(Number(messageIndex), mode);
        } else {
            // No stable index (e.g. live bubble) — still prefill for convenience.
            clearEditingMessage();
        }

        elements.userInput.value = content;
        elements.userInput.placeholder = mode === 'update' ? t('chat.editPlaceholderUpdate') : t('chat.editPlaceholderResend');
        elements.userInput.dispatchEvent(new Event('input', { bubbles: true }));
        resetInputHeight();
        elements.userInput.focus({ preventScroll: true });
        scrollToBottom();
        syncEditChrome();
        showToast(
            mode === 'update' ? t('chat.editToastUpdate') : t('chat.editToastResend'),
            'info',
        );
    }

    /**
     * Remove DOM message bubbles from `fromIndex` onward (optimistic AMC truncate).
     */
    function removeMessagesFromDom(fromIndex) {
        if (!Number.isFinite(Number(fromIndex))) return;
        const cutoff = Math.floor(Number(fromIndex));
        const nodes = Array.from(elements.chatContainer.querySelectorAll('.message'));
        const lastKept = nodes
            .filter((node) => {
                const idx = Number(node.dataset.messageIndex);
                return Number.isFinite(idx) && idx < cutoff;
            })
            .pop();

        nodes.forEach((node) => {
            const idx = Number(node.dataset.messageIndex);
            if (Number.isFinite(idx)) {
                if (idx >= cutoff) node.remove();
                return;
            }
            // Unindexed stream bubbles after the last kept message are abandoned tails.
            if (
                node.classList.contains('user')
                || node.classList.contains('assistant')
                || node.classList.contains('error')
            ) {
                if (!lastKept || (lastKept.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) {
                    node.remove();
                }
            }
        });
    }

    /**
     * AMC Retry: truncate at the previous user message and re-send it.
     * If a stream is active, stop it first (retry-and-stop).
     */
    async function regenerateFromPrompt(prompt, meta = {}) {
        if (!prompt) return;
        if (state.isProcessing) {
            if (state.abortController) {
                try { state.abortController.abort(); } catch { /* ignore */ }
                setAbortController(null);
            }
            setIsProcessing(false);
            // Let the aborted stream's finally settle before starting a new turn.
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        let truncateIndex = meta.previousUserIndex;
        if (truncateIndex === null || truncateIndex === undefined) {
            truncateIndex = state.lastUserMessageIndex;
        }
        if (truncateIndex === null || truncateIndex === undefined) {
            // Fallback: resend without truncate (legacy live bubble).
            await handleSendMessage(prompt);
            return;
        }
        clearEditingMessage();
        syncEditChrome();
        await handleSendMessage(prompt, {
            truncateFromIndex: Number(truncateIndex),
        });
    }

    async function refreshAfterMessageDeleted() {
        cancelEdit();
        if (state.currentSessionId) {
            await loadChat(state.currentSessionId);
        }
        await refreshHistory();
        showToast(t('chat.messageDeleted'), 'success');
    }

    async function loadChat(sessionId) {
        // Detach (do NOT abort) any in-flight stream so it keeps running in the
        // background under its own session record. Then render the target session,
        // re-attaching its live bubbles when it has a stream of its own.
        detachCurrentStream(elements);
        cancelEdit();
        const loadEpoch = state.chatEpoch;
        setCurrentSessionId(sessionId);
        updateActiveHistoryItem(sessionId);
        // 更新浏览器地址栏
        const route = chatRoute(sessionId);
        if (window.location.pathname !== route) {
            history.pushState({ sessionId }, '', route);
        }
        const data = await API.fetchChat(sessionId);
        // Stale response: user already switched away (new chat / other history).
        if (!isChatEpochCurrent(loadEpoch) || state.currentSessionId !== sessionId) {
            return;
        }
        const s = ensureSessionState(sessionId);
        if (data) {
            const messages = Array.isArray(data.messages) ? data.messages : [];
            s.mirror = messages.map((m) => ({
                role: m?.role || '',
                content: m?.content || '',
            }));
            s.count = messages.length;
            let lastUserIdx = null;
            let lastUserContent = '';
            messages.forEach((msg, idx) => {
                if (msg?.role === 'user' && msg?.content) {
                    lastUserIdx = idx;
                    lastUserContent = msg.content;
                }
            });
            s.lastUserIndex = lastUserIdx;
            s.lastUserMessage = lastUserContent || '';
            messagesMirror = s.mirror;
            lastUserMessage = s.lastUserMessage;
            setSessionMessageCount(s.count);
            setLastUserMessageIndex(s.lastUserIndex);
            renderMessages(messages, {
                onEdit: beginEditMessage,
                onRegenerate: regenerateFromPrompt,
                onMessageDeleted: refreshAfterMessageDeleted,
                onForked: refreshHistory,
            });
        } else {
            elements.chatContainer.innerHTML = '';
            elements.heroSection.style.display = 'block';
            elements.chatContainer.appendChild(elements.heroSection);
        }

        // Re-attach a background stream belonging to this session (live, or a
        // failed/cancelled turn kept so its DOM can be shown once).
        const rec = activeStreams.get(sessionId);
        if (rec) {
            if (rec.userNode) elements.chatContainer.appendChild(rec.userNode);
            if (rec.msgDiv) elements.chatContainer.appendChild(rec.msgDiv);
            elements.heroSection.style.display = 'none';
            if (rec.phase === 'streaming') {
                rec.attached = true;
                currentViewStream = rec;
                setIsProcessing(true);
                setAbortController(rec.abortController);
                setSessionMessageCount(rec.count);
                setLastUserMessageIndex(rec.lastUserIndex);
            } else {
                // Completed turns are dropped on finalize (DB holds them); failed /
                // cancelled turns are shown via their DOM once, then released.
                activeStreams.delete(sessionId);
                if (currentViewStream === rec) currentViewStream = null;
                setIsProcessing(false);
            }
            scrollToBottom();
        }
    }

    async function deleteChat(sessionId) {
        // If a stream is still running for the session being deleted, stop it —
        // its target no longer exists and persisting would fail.
        const rec = activeStreams.get(sessionId);
        if (rec) {
            try { rec.abortController?.abort(); } catch { /* ignore */ }
            rec.attached = false;
            if (currentViewStream === rec) currentViewStream = null;
            activeStreams.delete(sessionId);
        }
        if (await API.deleteChatAPI(sessionId)) {
            if (state.currentSessionId === sessionId) {
                elements.newChatBtn.click();
            }
            await refreshHistory();
            showToast(t('chat.sessionDeleted'), 'success');
        } else {
            showToast(t('chat.deleteFailed'), 'error');
        }
    }

    /**
     * @param {string} [overrideText]
     * @param {{ truncateFromIndex?: number|null }} [options]
     */
    async function handleSendMessage(overrideText, options = {}) {
        // Guard against concurrent sends in the same visible session: if it is
        // already processing, this is the "stop" action — abort and return.
        if (state.isProcessing) {
            const controllerToAbort = state.abortController;
            if (controllerToAbort) {
                controllerToAbort.abort();
                // Don't clear the global controller here - let the finally block handle it
                // to avoid racing with the stream's own cleanup.
            }
            return;
        }

        const text = (overrideText !== undefined ? overrideText : elements.userInput.value).trim();
        if (!text) return;

        // Capture the session BEFORE any await. A new-chat / history switch during
        // the bridge check must not let us attach to another session. The send is
        // always bound to its own session record (see activeStreams), so switching
        // away later keeps it running in the background instead of aborting it.
        const requestSessionId = state.currentSessionId;
        const provisionalKey = requestSessionId
            ?? `new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

        // AMC resend: prefer explicit truncate option, else active edit state.
        let truncateFromIndex = options.truncateFromIndex;
        if (
            (truncateFromIndex === null || truncateFromIndex === undefined)
            && isEditingMessage()
            && state.editMode === 'resend'
        ) {
            truncateFromIndex = state.editingMessageIndex;
        }
        if (truncateFromIndex !== null && truncateFromIndex !== undefined) {
            truncateFromIndex = Number(truncateFromIndex);
            if (!Number.isFinite(truncateFromIndex) || truncateFromIndex < 0) {
                truncateFromIndex = null;
            } else {
                truncateFromIndex = Math.floor(truncateFromIndex);
            }
        } else {
            truncateFromIndex = null;
        }

        // Fail fast before clearing the input: all engines need the Chrome bridge.
        const bridgeReady = await ensureBridgeConnected({ forceRefresh: true });
        if (!bridgeReady) {
            showToast(t('chat.requireBridge'), 'warning', 4000);
            return;
        }
        if (state.currentSessionId !== requestSessionId) {
            // User already left this view (new chat / switched history) while
            // we were waiting on the bridge. Do not start a stray request.
            return;
        }

        lastUserMessage = text;

        // Stream record: the stream owns its DOM subtree; switching away only
        // sets attached=false and detaches the bubbles — the stream keeps running
        // and finalizing into its own session's state (see activeStreams).
        const rec = {
            provisionalKey,
            sessionId: requestSessionId,
            abortController: null,
            attached: true,
            phase: 'streaming',
            userNode: null,
            msgDiv: null,
            count: 0,
            lastUserIndex: null,
        };
        activeStreams.set(provisionalKey, rec);
        const ownsView = () => rec.attached && state.currentSessionId === (rec.sessionId ?? requestSessionId);

        // 记录发送前状态(在乐观截断之前)：失败/取消时回滚，避免 stale 下标
        // 让后续 regenerate 的服务端截断静默退化为纯追加。
        const prevSessionMessageCount = state.sessionMessageCount;
        const prevLastUserMessageIndex = state.lastUserMessageIndex;

        // Optimistic DOM truncate (AMC slice) before appending the new turn.
        if (truncateFromIndex !== null) {
            removeMessagesFromDom(truncateFromIndex);
            setSessionMessageCount(truncateFromIndex);
        }

        const userMessageIndex = truncateFromIndex !== null
            ? truncateFromIndex
            : state.sessionMessageCount;
        const assistantMessageIndex = userMessageIndex + 1;
        setLastUserMessageIndex(userMessageIndex);
        rec.count = userMessageIndex;
        rec.lastUserIndex = userMessageIndex;

        // Clear edit chrome once send starts.
        clearEditingMessage();
        syncEditChrome();
        if (elements.userInput) {
            elements.userInput.placeholder = t('inputArea.placeholder');
        }

        const modelSelect = document.getElementById('model-select');
        const selectedModelOption = modelSelect?.options[modelSelect.selectedIndex] || null;
        const selectedModel = selectedModelOption ? selectedModelOption.value : '';
        const selectedProviderId = selectedModelOption?.dataset.providerId || state.settings.default_provider_id || '';

        elements.userInput.value = '';
        resetInputHeight();
        setIsProcessing(true);
        syncQuickSettingsFromState();
        updateSendButtonState();
        elements.heroSection.style.display = 'none';

        const sendBtnIcon = elements.sendBtn.querySelector('.material-symbols-rounded');
        if (sendBtnIcon) {
            sendBtnIcon.textContent = 'stop_circle';
        }
        elements.sendBtn.classList.add('processing');

        const userMsgResult = appendMessage('user', text, null, null, null, userMessageIndex, null, {
            onEdit: beginEditMessage,
        });
        rec.userNode = userMsgResult?.msgDiv || null;
        scrollToBottom();

        // Assistant Message Placeholder
        const { msgDiv, contentDiv: answerDiv, sideColumn } = createMessageShell('assistant');
        msgDiv.dataset.messageIndex = String(assistantMessageIndex);

        const { logContainer, logSummary, logDetails, spinner, statusText, expandIcon } = createDynamicLogContainer();
        const seenLogs = new Set(); // 去重
        answerDiv.classList.add('markdown-body');
        answerDiv.appendChild(logContainer);

        const contentWrapper = document.createElement('div');
        contentWrapper.className = 'message-answer-body';
        const liveArtifactMessageId = `stream-${Date.now().toString(36)}`;
        contentWrapper.dataset.liveArtifactsMessageId = liveArtifactMessageId;
        contentWrapper.innerHTML = '<span class="blinking-cursor"></span>';
        answerDiv.appendChild(contentWrapper);
        elements.chatContainer.appendChild(msgDiv);
        rec.msgDiv = msgDiv;
        scrollToBottom();

        const controller = new AbortController();
        rec.abortController = controller;
        setAbortController(controller);

        let currentAnswerBuffer = '';
        const copyBtn = createCopyButton(() => currentAnswerBuffer);
        const regenBtn = createRegenerateButton(async () => {
            // AMC Retry: truncate at this turn's user message and re-send.
            await regenerateFromPrompt(lastUserMessage, {
                previousUserIndex: userMessageIndex,
            });
        });
        sideColumn.appendChild(createMessageActionRail([copyBtn, regenBtn], t('ui.assistantActions')));

        let currentSources = [];
        let hasReceivedChunk = false;
        let searchStats = null;
        let currentCitations = [];
        let searchStartTime = Date.now();
        let streamOutcome = 'completed';
        // 流式渲染节流：避免每个 chunk 都全量 md.render+DOMPurify（O(n²)）。
        // AMC 对齐：用 setTimeout 节流而非 rAF —— rAF 在后台标签页被冻结，
        // 会导致流式内容在后台从不推送到 Live Artifact iframe（白屏）。
        // setTimeout 在后台照常运行（浏览器至少按节流间隔触发），内容始终可达。
        let pendingRender = false;
        let pendingRenderIsStreaming = false;
        let renderTimer = null;
        const STREAM_RENDER_THROTTLE_MS = 120;
        // Render generation counter: a scheduled streaming render whose timer
        // fires after the final answer was baked must NOT overwrite the just-
        // baked srcdoc with the streaming shell (STREAM_PREVIEW_ROOT). Bumping
        // this on bake invalidates any in-flight scheduled streaming render.
        let streamRenderSeq = 0;
        let lastPushedLength = 0;
        let lastPushTime = Date.now();

        function scheduleStreamRender(isStreaming) {
            if (!ownsView()) return;
            pendingRenderIsStreaming = isStreaming;
            if (pendingRender) return;
            pendingRender = true;
            const seqAtSchedule = streamRenderSeq;
            // AMC 对齐：setTimeout 节流（120ms）。rAF 在后台标签页被冻结，
            // 会让流式内容在后台从不 push 到 Live Artifact iframe；setTimeout
            // 在后台照常触发，前台则因 120ms > 帧间隔而等效于合并到下一帧。
            renderTimer = setTimeout(() => {
                if (!ownsView()) {
                    pendingRender = false;
                    renderTimer = null;
                    return;
                }
                // 若排队期间已完成终态烘焙,跳过这次流式渲染,
                // 避免用流式壳(STREAM_PREVIEW_ROOT)覆盖刚烘焙好的最终内容
                if (seqAtSchedule !== streamRenderSeq) {
                    pendingRender = false;
                    renderTimer = null;
                    return;
                }
                const now = Date.now();
                if (!shouldRenderStreamTick({
                    length: currentAnswerBuffer.length,
                    lastPushedLength,
                    buffer: currentAnswerBuffer,
                    now,
                    lastPushTime,
                })) {
                    // Not enough new content yet — re-check after another throttle
                    // window instead of rendering the full pipeline for tiny deltas.
                    pendingRender = false;
                    renderTimer = null;
                    scheduleStreamRender(pendingRenderIsStreaming);
                    return;
                }
                pendingRender = false;
                renderTimer = null;
                lastPushedLength = currentAnswerBuffer.length;
                lastPushTime = now;
                renderCurrentAssistantAnswer(pendingRenderIsStreaming);
                if (!userScrolled) scrollToBottom();
            }, STREAM_RENDER_THROTTLE_MS);
        }

        function renderCurrentAssistantAnswer(isStreaming) {
            renderAssistantAnswerBody(contentWrapper, currentAnswerBuffer, {
                sources: currentSources,
                citations: currentCitations,
                isStreaming,
                messageId: liveArtifactMessageId,
            });
        }

        // 重置滚动跟踪（新一轮对话）
        userScrolled = false;

        // 实时耗时更新器（后台流照常更新其节点，重挂回视图时可见）
        const elapsedTimer = setInterval(() => {
            const elapsed = ((Date.now() - searchStartTime) / 1000).toFixed(1);
            if (statusText.textContent.includes(t('chat.runningPrefix'))) {
                statusText.textContent = statusText.textContent.replace(/ \([\d.]+s\)$/, '') + ` (${elapsed}s)`;
            }
        }, 500);

        try {
            await API.streamChat(text, {
                model: selectedModel,
                providerId: selectedProviderId,
                // Freeze session id at send time so a concurrent view switch
                // cannot redirect this request into another conversation.
                sessionId: requestSessionId,
                truncateFromIndex,
                // 并发校验：截断锚点之前的消息前缀（服务端比对，不一致时拒绝
                // 截断而不是按漂移下标误删）。
                expectedPrefix: truncateFromIndex !== null
                    ? messagesMirror.slice(0, truncateFromIndex)
                    : null,
                liveArtifactsMode: state.liveArtifactsMode,
                signal: controller.signal,
                onMeta: (meta) => {
                    const sessionId = typeof meta === 'string' ? meta : meta.session_id;
                    if (!sessionId) return;
                    // A stream owns the view if it is attached and the view still
                    // shows the session it started under — evaluate BEFORE migrating
                    // rec.sessionId (which flips null → real for new chats).
                    const viewOwned = rec.attached && state.currentSessionId === (rec.sessionId ?? requestSessionId);
                    // Migrate the record to its real session id (new chats start under
                    // a provisional key). Always done so background streams can be
                    // located by session id for re-attach / finalize.
                    if (rec.sessionId !== sessionId) {
                        activeStreams.delete(rec.provisionalKey);
                        rec.sessionId = sessionId;
                        rec.provisionalKey = sessionId;
                        activeStreams.set(sessionId, rec);
                    }
                    if (viewOwned) {
                        setCurrentSessionId(sessionId);
                        const route = chatRoute(sessionId);
                        if (window.location.pathname !== route) {
                            history.replaceState({ sessionId }, '', route);
                        }
                    }
                },
                onLog: (msg) => {
                    // Background streams keep logging into their (detached) log panel
                    // so re-attaching shows the full progress.
                    if (msg.includes('自动切换到')) {
                        const match = msg.match(/切换到\s*(\S+)/);
                        if (match) showToast(t('chat.engineSwitched', { engine: match[1] }), 'warning');
                    }
                    statusText.textContent = msg;

                    // 去重检查
                    const logKey = msg.trim().substring(0, 80);
                    if (seenLogs.has(logKey)) return;
                    seenLogs.add(logKey);

                    const entry = createLogEntry(msg, new Date().toLocaleTimeString());
                    logDetails.appendChild(entry);
                    logDetails.scrollTop = logDetails.scrollHeight;
                },
                onSources: (sources) => {
                    currentSources = sources;
                    if (currentAnswerBuffer && ownsView()) {
                        renderCurrentAssistantAnswer(true);
                        if (!userScrolled) scrollToBottom();
                    }
                },
                onStats: (stats) => {
                    searchStats = stats;
                },
                onAnswerChunk: (chunk) => {
                    if (!hasReceivedChunk) {
                        hasReceivedChunk = true;
                        contentWrapper.innerHTML = '';
                    }
                    currentAnswerBuffer += chunk;
                    // 节流到下一帧，避免逐 token 全量重渲染；后台流跳过 DOM 只攒数据
                    if (ownsView()) scheduleStreamRender(true);
                },
                onAnswer: (finalAnswer, sessionId, finalSources, finalCitations) => {
                    if (hasCitationSources(finalSources)) {
                        currentSources = finalSources;
                    }
                    if (Array.isArray(finalCitations)) {
                        currentCitations = finalCitations;
                    }
                    currentAnswerBuffer = finalAnswer;
                    const sid = sessionId || rec.sessionId || requestSessionId;
                    // Capture before migration — same reason as onMeta.
                    const viewOwned = rec.attached && state.currentSessionId === (rec.sessionId ?? requestSessionId);
                    if (rec.sessionId !== sid) {
                        activeStreams.delete(rec.provisionalKey);
                        rec.sessionId = sid;
                        rec.provisionalKey = sid;
                        activeStreams.set(sid, rec);
                    }
                    // 写入该会话自己的状态（与当前可见会话无关，后台流同样生效）。
                    const s = ensureSessionState(sid);
                    s.count = assistantMessageIndex + 1;
                    s.lastUserIndex = userMessageIndex;
                    // 与服务端已同步：按截断锚点重建镜像（成功路径写入恰好是
                    // 该轮 user+assistant 两条）。
                    s.mirror = [
                        ...s.mirror.slice(0, userMessageIndex),
                        { role: 'user', content: text },
                        { role: 'assistant', content: finalAnswer },
                    ];
                    s.lastUserMessage = text;
                    if (viewOwned) {
                        // 取消任何挂起的节流渲染，立即用最终态渲染一次。
                        // clearTimeout 避免排期的 timer 稍后把 renderTimer 置 null，
                        // 误清掉 bake 后新 chunk 启动的 timer 引用。
                        if (renderTimer !== null) {
                            clearTimeout(renderTimer);
                            renderTimer = null;
                        }
                        pendingRender = false;
                        streamRenderSeq += 1; // 标记终态烘焙,作废已排期的流式渲染
                        renderCurrentAssistantAnswer(false);
                        // 终态已烘焙：把流式门控重置到最终长度,后续若有迟到 chunk
                        // 触发 scheduleStreamRender 也不至于重推整个内容。
                        lastPushedLength = currentAnswerBuffer.length;
                        lastPushTime = Date.now();
                        setCurrentSessionId(sid);
                        // user + assistant persisted → count is assistantIndex + 1
                        setSessionMessageCount(s.count);
                        setLastUserMessageIndex(s.lastUserIndex);
                        messagesMirror = s.mirror;
                        lastUserMessage = s.lastUserMessage;
                    }
                    refreshHistory();
                },
                onError: (err) => {
                    // Record the failure in the stream's own bubble so it is visible
                    // whether the stream is attached or re-attached later.
                    streamOutcome = 'failed';
                    if (!hasReceivedChunk) {
                        contentWrapper.innerHTML = '';
                    }
                    const errDiv = document.createElement('div');
                    errDiv.className = 'error-box';
                    // 友好的错误消息映射
                    let errMsg = err;
                    if (typeof err === 'string') {
                        if (err.includes('请先在设置中配置 API 密钥')) {
                            errMsg = t('chat.errNoApiKey');
                        } else if (err.includes('请求失败 (429)') || err.includes('rate limit')) {
                            errMsg = t('chat.errRateLimited');
                        } else if (err.includes('请求失败 (401)') || err.includes('Unauthorized')) {
                            errMsg = t('chat.errUnauthorized');
                        } else if (err.includes('请求失败 (402)')) {
                            errMsg = t('chat.errQuotaExceeded');
                        } else if (err.includes('请求失败 (500)') || err.includes('502') || err.includes('503')) {
                            errMsg = t('chat.errServerUnavailable');
                        }
                    }
                    errDiv.textContent = t('chat.errorPrefix', { message: errMsg });
                    contentWrapper.appendChild(errDiv);
                },
                onDone: () => {}
            });
        } catch (e) {
            if (e.name === 'AbortError') {
                streamOutcome = 'cancelled';
                if (!hasReceivedChunk) {
                    contentWrapper.innerHTML = '';
                }
                const warnDiv = document.createElement('div');
                warnDiv.className = 'warning-box';
                warnDiv.textContent = t('chat.userStopped');
                contentWrapper.appendChild(warnDiv);
            } else {
                streamOutcome = 'failed';
                console.error(e);
                if (!hasReceivedChunk) {
                    contentWrapper.innerHTML = '';
                }
                const errDiv = document.createElement('div');
                errDiv.className = 'error-box';
                errDiv.textContent = t('chat.networkError', { message: e.message });
                contentWrapper.appendChild(errDiv);
            }
        } finally {
            clearInterval(elapsedTimer);
            // Always clear the controller if we still own it — even after view switch.
            if (state.abortController === controller) {
                setAbortController(null);
            }
            rec.phase = streamOutcome === 'completed'
                ? 'finalized'
                : streamOutcome === 'cancelled'
                    ? 'cancelled'
                    : 'failed';

            // 失败/取消时回滚乐观状态（作用于该流自己的会话，而非当前可见会话）：
            // 该轮 user+assistant 未入库，DOM 里的气泡(或截断后的空位)与 DB 不一致；
            // 恢复发送前计数，让后续 regenerate/截断拿到真实下标，同时保留错误提示。
            // 仅当 prevSessionMessageCount 有效（增量追加而非新会话）且镜像长度确实
            // 大于它时才回滚，避免截断其他会话的镜像。
            if (streamOutcome !== 'completed' && prevSessionMessageCount >= 0) {
                const rollbackState = ensureSessionState(rec.sessionId ?? requestSessionId);
                if (rollbackState.mirror.length > prevSessionMessageCount) {
                    rollbackState.count = prevSessionMessageCount;
                    rollbackState.lastUserIndex = prevLastUserMessageIndex;
                    rollbackState.mirror = rollbackState.mirror.slice(0, prevSessionMessageCount);
                    if (rec.attached) {
                        setSessionMessageCount(rollbackState.count);
                        setLastUserMessageIndex(rollbackState.lastUserIndex);
                        messagesMirror = rollbackState.mirror;
                    }
                }
            }

            if (rec.phase === 'finalized') {
                // Completed turn is persisted server-side — drop the record; a later
                // loadChat renders it from the DB.
                activeStreams.delete(rec.provisionalKey);
            }
            // cancelled/failed records are kept so returning to the session can show
            // their bubble once (loadChat releases them).

            if (currentViewStream === rec) {
                currentViewStream = null;
            }

            // Only mutate shared UI / processing flags when this stream still owns the
            // visible view. A background stream's finalize must not touch the composer
            // or the isProcessing flag of whichever session is now visible.
            if (!rec.attached) {
                return;
            }
            const totalElapsed = ((Date.now() - searchStartTime) / 1000).toFixed(1);
            setIsProcessing(false);
            syncQuickSettingsFromState();
            if (sendBtnIcon) {
                sendBtnIcon.textContent = 'send';
            }
            elements.sendBtn.classList.remove('processing');
            updateSendButtonState();
            spinner.classList.remove('rotating');
            spinner.classList.remove('completed', 'failed', 'cancelled');
            logContainer.classList.remove('completed', 'failed', 'cancelled');
            if (streamOutcome === 'failed') {
                spinner.textContent = 'error';
                spinner.classList.add('failed');
                logContainer.classList.add('failed');
                statusText.textContent = t('chat.statusFailed', { seconds: totalElapsed });
            } else if (streamOutcome === 'cancelled') {
                spinner.textContent = 'stop_circle';
                spinner.classList.add('cancelled');
                logContainer.classList.add('cancelled');
                statusText.textContent = t('chat.statusStopped', { seconds: totalElapsed });
            } else if (searchStats && searchStats.sites_searched > 0) {
                spinner.textContent = 'check_circle';
                spinner.classList.add('completed');
                logContainer.classList.add('completed');
                let statsText = t('chat.statusSearched', { count: searchStats.sites_searched });
                if (searchStats.sites_crawled > 0) {
                    statsText += t('chat.statusDeepRead', { count: searchStats.sites_crawled });
                }
                statsText += ` · ${totalElapsed}s`;
                statusText.textContent = statsText;
            } else {
                spinner.textContent = 'check_circle';
                spinner.classList.add('completed');
                logContainer.classList.add('completed');
                statusText.textContent = t('chat.statusDone', { seconds: totalElapsed });
            }
            // 完成反馈（AMC-aligned）：桌面通知仅在标签页位于后台时触发，避免打扰正在阅读的用户。
            if (streamOutcome !== 'failed' && streamOutcome !== 'cancelled') {
                const feedbackSettings = state.settings || {};
                if (feedbackSettings.completion_sound_enabled) {
                    playCompletionSound();
                }
                if (feedbackSettings.completion_notification_enabled && document.hidden) {
                    showCompletionNotification(t('chat.searchCompletedTitle'), statusText.textContent);
                }
            }
            // 搜索完成，自动折叠过程日志
            logDetails.classList.remove('open');
            if (expandIcon) expandIcon.classList.remove('expanded');
            if (logSummary) logSummary.setAttribute('aria-expanded', 'false');
        }
    }

    function updateSendButtonState() {
        const hasText = elements.userInput.value.trim().length > 0;
        const isActive = hasText || state.isProcessing;
        // 统一用 disabled 属性表达「不可用」，class 仅承载视觉态(processing)。
        elements.sendBtn.disabled = !isActive;
        elements.sendBtn.classList.toggle('processing', state.isProcessing);
        elements.sendBtn.setAttribute('aria-disabled', state.isProcessing ? 'false' : (!hasText ? 'true' : 'false'));
    }

    function resetInputHeight() {
        elements.userInput.style.height = '26px';
        elements.userInput.style.overflowY = 'hidden';
    }

    function autoResizeInput() {
        const maxHeight = 150; // AMC MAX_TEXTAREA_HEIGHT_PX
        // 先重置再读取 scrollHeight：否则空内容时 scrollHeight 会塌缩为当前
        // clientHeight（上一次撑开的高度），导致清空后高度卡在旧值无法恢复。
        elements.userInput.style.height = '26px';
        const scrollHeight = elements.userInput.scrollHeight;
        if (scrollHeight > maxHeight) {
            elements.userInput.style.height = maxHeight + 'px';
            elements.userInput.style.overflowY = 'auto';
        } else {
            elements.userInput.style.height = scrollHeight + 'px';
            elements.userInput.style.overflowY = 'hidden';
        }
        updateSendButtonState();

    }

    // 绑定事件
    elements.sendBtn.addEventListener('click', () => handleSendMessage());
    elements.userInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage();
        }
    });
    // Ctrl+Enter also sends (alternative shortcut)
    // ArrowUp on empty input → AMC edit last user message (resend mode)
    // Escape while editing → cancel
    elements.userInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault();
            handleSendMessage();
            return;
        }
        if (e.key === 'Escape' && isEditingMessage()) {
            e.preventDefault();
            cancelEdit();
            elements.userInput.value = '';
            resetInputHeight();
            updateSendButtonState();
            return;
        }
        if (
            e.key === 'ArrowUp'
            && !e.shiftKey
            && !e.altKey
            && !e.ctrlKey
            && !e.metaKey
            && !state.isProcessing
            && !elements.userInput.value.trim()
            && lastUserMessage
        ) {
            e.preventDefault();
            beginEditMessage({
                content: lastUserMessage,
                messageIndex: state.lastUserMessageIndex,
                mode: 'resend',
            });
        }
    });

    elements.userInput.addEventListener('input', autoResizeInput);

    // 粘贴大段文本时自动展开
    elements.userInput.addEventListener('paste', () => {
        setTimeout(autoResizeInput, 0);
    });

    // AMC cancel-edit control on the composer banner
    const cancelEditBtn = elements.cancelEditBtn || document.getElementById('cancel-edit-btn');
    if (cancelEditBtn) {
        cancelEditBtn.addEventListener('click', (e) => {
            e.preventDefault();
            cancelEdit();
            // Keep draft text so user can still send as a new message if desired;
            // clear only the edit anchor (matches AMC cancel clearing draft optionally).
            // AMC clears input on cancel — mirror that.
            elements.userInput.value = '';
            resetInputHeight();
            updateSendButtonState();
            elements.userInput.focus({ preventScroll: true });
            showToast(t('chat.editCancelled'), 'info');
        });
    }
    syncEditChrome();

    // 初始化按钮状态
    updateSendButtonState();

    // Ctrl+Shift+R: regenerate last answer (AMC retry last turn)
    const keydownHandler = (e) => {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'R') {
            e.preventDefault();
            if (lastUserMessage && !state.isProcessing) {
                regenerateFromPrompt(lastUserMessage, {
                    previousUserIndex: state.lastUserMessageIndex,
                });
            }
        }
    };
    document.addEventListener('keydown', keydownHandler);

    // 模型切换提示
    const modelSelect = document.getElementById('model-select');
    if (modelSelect) {
        modelSelect.addEventListener('change', () => {
            const selectedOption = modelSelect.options[modelSelect.selectedIndex];
            const shortName = selectedOption ? selectedOption.textContent : modelSelect.value;
            showToast(t('chat.modelSwitched', { model: shortName }), 'info');
        });
    }

    // Quick settings toolbar interaction
    const quickEngineBtn = document.getElementById('quick-engine-btn');
    const quickEngineDropdown = document.getElementById('quick-engine-dropdown');
    
    if (quickEngineBtn && quickEngineDropdown) {
        // 让下拉项可被键盘聚焦与选择（保留 <div> 结构以匹配现有测试）
        const dropdownItems = Array.from(quickEngineDropdown.querySelectorAll('.quick-dropdown-item'));
        dropdownItems.forEach((item, idx) => {
            item.setAttribute('role', 'option');
            item.setAttribute('tabindex', '-1');
            if (!item.id) item.id = `quick-engine-opt-${idx}`;
        });
        quickEngineDropdown.setAttribute('role', 'listbox');
        quickEngineDropdown.setAttribute('aria-label', t('chat.engineList'));

        quickEngineBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const willOpen = !quickEngineDropdown.classList.contains('active');
            quickEngineDropdown.classList.toggle('active');
            quickEngineBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
            if (willOpen) {
                // 打开后将焦点移到当前选中项
                const active = quickEngineDropdown.querySelector('.quick-dropdown-item.active') || dropdownItems[0];
                if (active) active.focus();
            }
        });
        quickEngineBtn.setAttribute('aria-haspopup', 'listbox');
        quickEngineBtn.setAttribute('aria-expanded', 'false');

        const clickOutsideHandler = (e) => {
            if (!quickEngineBtn.contains(e.target) && !quickEngineDropdown.contains(e.target)) {
                quickEngineDropdown.classList.remove('active');
                quickEngineBtn.setAttribute('aria-expanded', 'false');
            }
        };
        document.addEventListener('click', clickOutsideHandler);

        // 键盘导航：在按钮与选项间用方向键移动焦点
        function moveHighlight(current, dir) {
            const idx = dropdownItems.indexOf(current);
            let next = idx;
            if (dir === 'down') next = (idx + 1) % dropdownItems.length;
            else if (dir === 'up') next = (idx - 1 + dropdownItems.length) % dropdownItems.length;
            else if (dir === 'home') next = 0;
            else if (dir === 'end') next = dropdownItems.length - 1;
            dropdownItems[next]?.focus();
        }

        quickEngineBtn.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                quickEngineDropdown.classList.add('active');
                quickEngineBtn.setAttribute('aria-expanded', 'true');
                const active = quickEngineDropdown.querySelector('.quick-dropdown-item.active') || dropdownItems[0];
                if (active) active.focus();
            }
        });

        dropdownItems.forEach(item => {
            item.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); moveHighlight(item, 'down'); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); moveHighlight(item, 'up'); }
                else if (e.key === 'Home') { e.preventDefault(); moveHighlight(item, 'home'); }
                else if (e.key === 'End') { e.preventDefault(); moveHighlight(item, 'end'); }
                else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); }
                else if (e.key === 'Escape') {
                    quickEngineDropdown.classList.remove('active');
                    quickEngineBtn.setAttribute('aria-expanded', 'false');
                    quickEngineBtn.focus();
                }
            });
        });

        dropdownItems.forEach(item => {
            item.addEventListener('click', async () => {
                const newEngine = item.getAttribute('data-value');
                quickEngineDropdown.classList.remove('active');
                quickEngineBtn.setAttribute('aria-expanded', 'false');
                quickEngineBtn.focus();
                
                if (state.settings) {
                    state.settings.search_engine = newEngine;
                    
                    const modalSelect = document.getElementById('engine-select');
                    if (modalSelect) {
                        modalSelect.value = newEngine;
                    }
                    
                    await API.saveSettingsAPI(state.settings);
                    syncQuickSettingsFromState();
                    showToast(t('chat.engineSwitchedTo', { engine: item.textContent }), 'success');
                    warnIfBridgeDisconnected(item.textContent?.trim() || newEngine);
                }
            });
        });
    }

    const quickLiveArtifactsBtn = document.getElementById('quick-live-artifacts-btn');
    if (quickLiveArtifactsBtn) {
        quickLiveArtifactsBtn.addEventListener('click', async () => {
            const nextValue = !state.liveArtifactsMode;
            setLiveArtifactsMode(nextValue);
            if (state.settings) {
                state.settings.live_artifacts_mode = nextValue;
            }
            syncQuickSettingsFromState();
            showToast(nextValue ? t('chat.laOn') : t('chat.laOff'), 'info');

            if (state.settings) {
                const saved = await API.saveSettingsAPI(state.settings);
                if (!saved) {
                    setLiveArtifactsMode(!nextValue);
                    state.settings.live_artifacts_mode = !nextValue;
                    syncQuickSettingsFromState();
                    showToast(t('chat.laSaveFailed'), 'warning');
                }
            }
        });
    }

    setupSearchIntensityControls();

    syncQuickSettingsFromState();

    // AMC-style composer extras: suggestion chips, slash commands, status pill.
    setupComposerExtras({
        inputEl: elements.userInput,
        sendBtn: elements.sendBtn,
        heroEl: elements.heroSection,
        onPickSuggestion: (text) => {
            elements.userInput.value = text;
            handleSendMessage(text);
        },
        onApplyIntensity: (presetId) => {
            applyIntensityPreset(presetId);
        },
        getStatusText: () => {
            if (!state.settings) return null;
            const preset = matchIntensityPreset(state.settings.max_results, state.settings.max_iterations);
            const engine = ENGINE_NAMES[state.settings.search_engine] || state.settings.search_engine || 'Google';
            return { title: t('chat.searching'), subtitle: `${preset?.label || t('searchIntensity.custom')} · ${engine}` };
        },
    });

    // AMC-style text-selection toolbar: Copy / Quote / Search selected text.
    setupTextSelectionToolbar({
        containerEl: elements.chatContainer,
        inputEl: elements.userInput,
    });

    // Re-render the current visible session from its in-memory mirror. Used on
    // language change so the transcript (action labels, collapse toggles, etc.)
    // re-translates without a reload. No-op when no session is loaded.
    function rerenderCurrentView() {
        if (!state.currentSessionId) {
            showHomeState();
            return;
        }
        const s = ensureSessionState(state.currentSessionId);
        const messages = s.mirror.map((m, idx) => ({
            ...m,
            id: `regen-${state.currentSessionId}-${idx}`,
            message_index: idx,
            role: m.role,
            content: m.content,
        }));
        messagesMirror = s.mirror;
        renderMessages(messages, {
            onEdit: beginEditMessage,
            onRegenerate: regenerateFromPrompt,
            onMessageDeleted: refreshAfterMessageDeleted,
            onForked: refreshHistory,
        });
    }

    return { loadChat, deleteChat, rerenderCurrentView };
}

function syncSettingsFormSearchLimits(maxResults, maxIterations) {
    const maxResultsInput = document.getElementById('max-results-input');
    const maxIterationsInput = document.getElementById('max-iterations-input');
    if (maxResultsInput) maxResultsInput.value = String(maxResults);
    if (maxIterationsInput) maxIterationsInput.value = String(maxIterations);
}

/** Apply a search-intensity preset (chips / slash commands / settings share this). */
async function applyIntensityPreset(presetId) {
    if (state.isProcessing) return false;
    if (!presetId || presetId === 'custom') return false;
    const preset = getIntensityPreset(presetId);
    if (!preset || !state.settings) return false;

    const previousResults = state.settings.max_results;
    const previousIterations = state.settings.max_iterations;
    state.settings = applyIntensityPresetToSettings(state.settings, presetId);
    syncSettingsFormSearchLimits(preset.max_results, preset.max_iterations);
    syncQuickSettingsFromState();

    const saved = await API.saveSettingsAPI(state.settings);
    if (!saved) {
        state.settings.max_results = previousResults;
        state.settings.max_iterations = previousIterations;
        syncSettingsFormSearchLimits(previousResults, previousIterations);
        syncQuickSettingsFromState();
        showToast(t('chat.intensitySaveFailed'), 'warning');
        return false;
    }
    showToast(t('chat.intensityApplied', {
        label: getIntensityPresetLabel(preset),
        hint: getIntensityPresetHint(preset),
    }), 'success');
    return true;
}

function setupSearchIntensityControls() {
    const bar = document.getElementById('search-intensity-bar');
    if (!bar) return;

    const chips = Array.from(bar.querySelectorAll('.intensity-chip[data-intensity]'));
    chips.forEach((chip) => {
        chip.addEventListener('click', () => {
            const presetId = chip.getAttribute('data-intensity');
            applyIntensityPreset(presetId);
        });

        chip.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') {
                return;
            }
            const visible = chips.filter((c) => !c.hidden && c.getAttribute('data-intensity') !== 'custom');
            const currentIndex = visible.indexOf(chip);
            if (currentIndex < 0) return;
            e.preventDefault();
            let nextIndex = currentIndex;
            if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % visible.length;
            else if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + visible.length) % visible.length;
            else if (e.key === 'Home') nextIndex = 0;
            else if (e.key === 'End') nextIndex = visible.length - 1;
            visible[nextIndex]?.focus();
        });
    });
}

export function syncQuickSettingsFromState() {
    const quickEngineName = document.getElementById('quick-engine-name');
    const quickEngineDropdown = document.getElementById('quick-engine-dropdown');
    const quickLiveArtifactsBtn = document.getElementById('quick-live-artifacts-btn');

    if (!state.settings) return;
    
    const engine = state.settings.search_engine || 'google';
    if (quickEngineName) {
        quickEngineName.textContent = ENGINE_NAMES[engine] || engine;
    }
    
    if (quickEngineDropdown) {
        const dropdownItems = quickEngineDropdown.querySelectorAll('.quick-dropdown-item');
        let activeSvg = null;
        dropdownItems.forEach(item => {
            const itemVal = item.getAttribute('data-value');
            const isActive = itemVal === engine;
            item.classList.toggle('active', isActive);
            if (isActive) {
                activeSvg = item.querySelector('svg');
            }
        });
        
        const iconContainer = document.getElementById('quick-engine-icon-container');
        if (iconContainer && activeSvg) {
            iconContainer.innerHTML = '';
            iconContainer.appendChild(activeSvg.cloneNode(true));
        }
    }

    if (quickLiveArtifactsBtn) {
        const active = Boolean(state.liveArtifactsMode);
        quickLiveArtifactsBtn.classList.toggle('active', active);
        quickLiveArtifactsBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
        quickLiveArtifactsBtn.setAttribute(
            'aria-label',
            active
                ? t('chat.laActiveHint')
                : t('chat.laInactiveHintAria')
        );
        quickLiveArtifactsBtn.title = active
            ? t('chat.laActiveHint')
            : t('chat.laInactiveHint');
    }

    updateIntensityUI({
        maxResults: state.settings.max_results,
        maxIterations: state.settings.max_iterations,
        disabled: Boolean(state.isProcessing),
    });
}
