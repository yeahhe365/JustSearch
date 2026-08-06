import { state, setSettings } from './state.js?v=5';
import { authFetch } from './auth.js?v=1';
import { applyFontSizes, applyTheme } from './utils.js?v=13';
import { t } from './i18n.js?v=1';

function encodePathSegment(value) {
    return encodeURIComponent(String(value ?? ''));
}

async function readResponseJson(response) {
    try {
        return await response.clone().json();
    } catch {
        return null;
    }
}

async function readResponseText(response) {
    try {
        return await response.clone().text();
    } catch {
        return '';
    }
}

function responseJsonDetail(data) {
    if (!data || typeof data !== 'object') return '';
    const detail = data.detail ?? data.error ?? data.message;
    if (typeof detail === 'string') return detail.trim();
    if (detail && typeof detail === 'object') {
        if (typeof detail.message === 'string' && detail.message.trim()) {
            return detail.message.trim();
        }
        try {
            return JSON.stringify(detail);
        } catch {
            return '';
        }
    }
    return '';
}

async function readResponseBridgeDetail(response) {
    const data = await readResponseJson(response);
    if (!data || typeof data !== 'object') return null;
    const detail = data.detail;
    if (detail && typeof detail === 'object') return detail;
    return null;
}

async function getResponseErrorMessage(response, fallback) {
    const jsonDetail = responseJsonDetail(await readResponseJson(response));
    if (jsonDetail) return jsonDetail;

    const text = (await readResponseText(response)).trim();
    if (text) return text.slice(0, 500);
    return fallback;
}

function applyAppearanceSettings(settings) {
    if (!settings || typeof settings !== 'object') return;
    applyTheme(settings.theme);
    applyFontSizes(settings);
    // Rebuild open Live Artifact previews when LA base size or theme changes.
    import('./live-artifacts.js?v=50')
        .then((mod) => {
            if (typeof mod.refreshLiveArtifactPreviews === 'function') {
                mod.refreshLiveArtifactPreviews(settings);
            } else if (typeof mod.refreshLiveArtifactFontSizes === 'function') {
                mod.refreshLiveArtifactFontSizes(settings);
            }
        })
        .catch(() => {
            // Live Artifacts module may be unavailable in some test harnesses.
        });
}

export async function fetchSettings() {
    try {
        const res = await authFetch('/api/settings');
        if (res.ok) {
            const settings = await res.json();
            setSettings(settings);
            applyAppearanceSettings(settings);
            return settings;
        }
    } catch (e) {
        console.error("Failed to load settings", e);
    }
    return null;
}

export async function saveSettingsAPI(newSettings) {
    try {
        const res = await authFetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newSettings)
        });
        if (res.ok) {
            const data = await res.json();
            // Update state with server response (contains masked provider api keys)
            if (data.settings) {
                setSettings(data.settings);
                applyAppearanceSettings(data.settings);
            } else {
                setSettings(newSettings);
                applyAppearanceSettings(newSettings);
            }
            return true;
        }
    } catch (e) {
        console.error(e);
    }
    return false;
}

export async function restoreDefaultSettingsAPI() {
    try {
        const res = await authFetch('/api/settings/default');
        if (res.ok) {
            return await res.json();
        }
    } catch (e) {
        console.error("Failed to load default settings", e);
    }
    return null;
}

export async function checkEnginesAPI() {
    try {
        const res = await authFetch('/api/settings/check-engines', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        if (res.ok) {
            return await res.json();
        }
    } catch (e) {
        console.error("Failed to check search engines", e);
    }
    return null;
}

export async function fetchHistory() {
    try {
        const res = await authFetch('/api/history');
        if (res.ok) {
            return await res.json();
        }
    } catch (e) {
        console.error("Failed to load history", e);
    }
    return [];
}

export async function fetchChatGroups() {
    try {
        const res = await authFetch('/api/history/groups');
        if (res.ok) {
            return await res.json();
        }
    } catch (e) {
        console.error("Failed to load chat groups", e);
    }
    return [];
}

export async function createChatGroupAPI(title = t('history.newGroup')) {
    try {
        const res = await authFetch('/api/history/groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title })
        });
        if (res.ok) {
            return await res.json();
        }
    } catch (e) {
        console.error("Failed to create chat group", e);
    }
    return null;
}

export async function updateChatGroupAPI(groupId, changes) {
    try {
        const res = await authFetch(`/api/history/groups/${encodePathSegment(groupId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(changes)
        });
        if (res.ok) {
            return await res.json();
        }
    } catch (e) {
        console.error("Failed to update chat group", e);
    }
    return null;
}

export async function deleteChatGroupAPI(groupId) {
    try {
        const res = await authFetch(`/api/history/groups/${encodePathSegment(groupId)}`, {
            method: 'DELETE'
        });
        return res.ok;
    } catch (e) {
        console.error("Failed to delete chat group", e);
        return false;
    }
}

export async function moveChatToGroupAPI(sessionId, groupId) {
    try {
        const res = await authFetch(`/api/history/${encodePathSegment(sessionId)}/group`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ group_id: groupId })
        });
        return res.ok;
    } catch (e) {
        console.error("Failed to move chat to group", e);
        return false;
    }
}

export async function deleteChatAPI(sessionId) {
    try {
        const res = await authFetch(`/api/history/${encodePathSegment(sessionId)}`, {
            method: 'DELETE'
        });
        return res.ok;
    } catch (e) {
        console.error("Failed to delete chat", e);
        return false;
    }
}

export async function renameChatAPI(sessionId, newTitle) {
    try {
        const res = await authFetch(`/api/history/${encodePathSegment(sessionId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: newTitle })
        });
        return res.ok;
    } catch (e) {
        console.error("Failed to rename chat", e);
        return false;
    }
}

export async function pinChatAPI(sessionId, isPinned) {
    try {
        const res = await authFetch(`/api/history/${encodePathSegment(sessionId)}/pin`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_pinned: Boolean(isPinned) })
        });
        if (res.ok) {
            return await res.json();
        }
    } catch (e) {
        console.error("Failed to toggle pin", e);
    }
    return null;
}

export async function duplicateChatAPI(sessionId) {
    try {
        const res = await authFetch(`/api/history/${encodePathSegment(sessionId)}/duplicate`, {
            method: 'POST'
        });
        if (res.ok) {
            return await res.json();
        }
    } catch (e) {
        console.error("Failed to duplicate chat", e);
    }
    return null;
}

export async function forkChatAPI(sessionId, uptoMessageIndex) {
    try {
        const res = await authFetch(`/api/history/${encodePathSegment(sessionId)}/fork`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ upto_message_index: Number(uptoMessageIndex) })
        });
        if (res.ok) {
            return await res.json();
        }
    } catch (e) {
        console.error("Failed to fork chat", e);
    }
    return null;
}

export async function clearHistoryAPI() {
    try {
        const res = await authFetch('/api/history', {
            method: 'DELETE'
        });
        return res.ok;
    } catch (e) {
        console.error("Failed to clear history", e);
        return false;
    }
}

export async function exportHistoryAPI() {
    try {
        const res = await authFetch('/api/history/export/all?format=json');
        if (!res.ok) {
            return false;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        link.href = url;
        link.download = `justsearch-history-${today}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return true;
    } catch (e) {
        console.error("Failed to export history", e);
        return false;
    }
}

export async function importHistoryAPI(payload) {
    try {
        const res = await authFetch('/api/history/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (res.ok) {
            return await res.json();
        }
        const detail = await getResponseErrorMessage(res, t('api.importFailed'));
        return { status: 'error', detail };
    } catch (e) {
        console.error("Failed to import history", e);
        return { status: 'error', detail: t('api.importRequestFailed') };
    }
}

export async function deleteMessageAPI(sessionId, messageIndex, expectedContent = null) {
    try {
        const res = await authFetch('/api/chat/message', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: sessionId,
                message_index: messageIndex,
                ...(typeof expectedContent === 'string' && expectedContent.length > 0
                    ? { expected_content: expectedContent }
                    : {}),
            })
        });
        return res.ok;
    } catch (e) {
        console.error("Failed to delete message", e);
        return false;
    }
}

export async function clearCacheAPI() {
    try {
        const res = await authFetch('/api/clear-cache', {
            method: 'POST'
        });
        return res.ok;
    } catch (e) {
        console.error("Failed to clear cache", e);
        return false;
    }
}

export async function searchHistory(query) {
    try {
        const res = await authFetch(`/api/history/search?q=${encodeURIComponent(query)}`);
        if (res.ok) {
            return await res.json();
        }
    } catch (e) {
        console.error("Failed to search history", e);
    }
    return [];
}

export async function fetchChat(sessionId) {
    try {
        const res = await authFetch(`/api/history/${encodePathSegment(sessionId)}`);
        if (res.ok) {
            return await res.json();
        }
    } catch (e) {
        console.error("Failed to load chat", e);
    }
    return null;
}

export const __apiTestHooks = {
    encodePathSegment,
    getResponseErrorMessage,
};

// Cache GitHub stars in memory to avoid repeated requests
let _githubStarsCache = null;
let _githubStarsCacheTime = 0;
const GITHUB_STARS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

export async function fetchGitHubStats() {
    // Use in-memory cache to avoid fetching on every settings modal open
    const now = Date.now();
    if (_githubStarsCache && (now - _githubStarsCacheTime) < GITHUB_STARS_CACHE_TTL) {
        return _githubStarsCache;
    }

    try {
        const res = await authFetch('/api/stats/github');
        if (res.ok) {
            const data = await res.json();
            _githubStarsCache = data;
            _githubStarsCacheTime = now;
            return data;
        }
    } catch (e) {
        console.error("Failed to fetch GitHub stats", e);
    }
    return _githubStarsCache || { stars: 0 };
}

export async function streamChat(query, callbacks) {
    const {
        onLog,
        onAnswerChunk,
        onAnswer,
        onSources,
        onStats,
        onError,
        onDone,
        onMeta,
        signal,
        model,
        providerId,
        liveArtifactsMode,
        // AMC resend/retry: drop this message index and everything after it server-side.
        truncateFromIndex,
        // 截断锚点之前的消息前缀({role, content})，服务端比对一致才截断，
        // 防止并发/陈旧视图下按下标漂移误删。
        expectedPrefix,
        // Prefer an explicit session id frozen by the caller so concurrent
        // "new chat" / history switches cannot redirect the request body.
        sessionId: explicitSessionId,
    } = callbacks;
    const requestSessionId = explicitSessionId !== undefined
        ? explicitSessionId
        : state.currentSessionId;

    const MAX_RETRIES = 2;
    const RETRY_DELAYS = [2000, 5000]; // 渐进式重试延迟
    let doneEmitted = false;

    const emitDone = () => {
        if (doneEmitted) return;
        doneEmitted = true;
        if (onDone) onDone();
    };

    const handleSsePayload = (dataStr) => {
        if (dataStr === '[DONE]') {
            emitDone();
            return true;
        }

        try {
            const event = JSON.parse(dataStr);

            if (event.type === 'meta' && onMeta) {
                onMeta(event);
            }
            else if (event.type === 'log' && onLog) {
                onLog(event.content);
            }
            else if (event.type === 'sources' && onSources) {
                onSources(event.content);
            }
            else if (event.type === 'stats' && onStats) {
                onStats(event.content);
            }
            else if (event.type === 'answer_chunk' && onAnswerChunk) {
                onAnswerChunk(event.content);
            }
            else if (event.type === 'answer' && onAnswer) {
                onAnswer(event.content, event.session_id, event.sources, event.citations);
            }
            else if (event.type === 'error' && onError) {
                onError(event.content);
                return true;
            }
        } catch (e) {
            console.error('Error parsing SSE event', e);
        }
        return false;
    };

    const processSseBlock = (block) => {
        const dataLines = String(block || '')
            .split(/\r?\n/)
            .filter(line => line.startsWith('data: '))
            .map(line => line.slice(6));
        if (dataLines.length === 0) return false;
        return handleSsePayload(dataLines.join('\n'));
    };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        let responseStarted = false;
        try {
            const response = await authFetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: query,
                    session_id: requestSessionId,
                    provider_id: providerId || state.settings.default_provider_id,
                    model: model,
                    search_engine: state.settings.search_engine,
                    max_results: state.settings.max_results,
                    max_iterations: state.settings.max_iterations,
                    interactive_search: state.settings.interactive_search,
                    live_artifacts_mode: Boolean(liveArtifactsMode),
                    ...(Number.isFinite(Number(truncateFromIndex)) && Number(truncateFromIndex) >= 0
                        ? { truncate_from_index: Math.floor(Number(truncateFromIndex)) }
                        : {}),
                    ...(Array.isArray(expectedPrefix) && expectedPrefix.length > 0
                        ? { expected_prefix: expectedPrefix.map((m) => ({ role: m.role || '', content: m.content || '' })) }
                        : {}),
                }),
                signal: signal
            });
            responseStarted = true;

            // Handle non-200 responses (e.g. 400 missing API key, 503 bridge offline)
            if (!response.ok) {
                const bridgeDetail = await readResponseBridgeDetail(response);
                if (
                    bridgeDetail?.code === 'BRIDGE_REQUIRED'
                    || response.status === 503
                ) {
                    try {
                        const { isBridgeRequiredError, openBridgeInstallModal, fetchBridgeStatus } = await import('./bridge.js?v=9');
                        if (isBridgeRequiredError(bridgeDetail) || response.status === 503) {
                            await fetchBridgeStatus();
                            openBridgeInstallModal();
                        }
                    } catch {
                        // Bridge UI module may be unavailable in tests.
                    }
                }
                const errMsg = bridgeDetail?.message
                    || await getResponseErrorMessage(response, `请求失败 (${response.status})`);
                if (onError) onError(errMsg);
                return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const blocks = buffer.split(/\r?\n\r?\n/);
                buffer = blocks.pop() || '';

                for (const block of blocks) {
                    if (processSseBlock(block)) {
                        return; // 正常结束，无需重试
                    }
                }
            }

            if (buffer.trim() && processSseBlock(buffer)) {
                return;
            }
            emitDone();
            return;

        } catch (e) {
            // AbortError 是用户主动取消，不重试
            if (e.name === 'AbortError') {
                throw e;
            }

            // 已经开始执行的聊天请求不是幂等操作，中途断流不能重发同一请求。
            if (responseStarted) {
                console.error('SSE 连接在响应开始后中断，不重试以避免重复生成:', e);
                throw e;
            }

            // 网络错误等可重试
            if (attempt < MAX_RETRIES) {
                const delay = RETRY_DELAYS[attempt] || 5000;
                console.warn(`SSE 连接断开 (尝试 ${attempt + 1}/${MAX_RETRIES + 1})，${delay / 1000} 秒后重连...`, e);
                if (onLog) {
                    onLog(t('api.reconnecting', { attempt: attempt + 1, total: MAX_RETRIES + 1 }));
                }
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                console.error('SSE 连接重试耗尽:', e);
                throw e;
            }
        }
    }
}
