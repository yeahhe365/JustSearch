export const state = {
    currentSessionId: null,
    /**
     * Monotonic counter bumped whenever the user leaves the current chat view
     * (new chat / switch history / clear). In-flight stream callbacks must
     * compare against their captured epoch and ignore stale events so answers
     * cannot re-bind session_id to an abandoned conversation.
     */
    chatEpoch: 0,
    settings: {},
    isProcessing: false,
    abortController: null,
    liveArtifactsMode: false,
    /** null = unknown, true/false after health poll */
    bridgeConnected: null,
    bridgeWsUrl: 'ws://127.0.0.1:8000/justsearch',
    bridgeDownloadUrl: '/api/extension/download',
    bridgeLastCheckedAt: null,
    bridgeExtensionVersion: null,
    bridgeExtensionName: null,
    bridgeLatestExtensionVersion: null,
    bridgeUpdateAvailable: false,
    /**
     * AMC-style message edit/resend:
     * - editingMessageIndex: 0-based history index of the user message being edited
     * - editMode: 'resend' (truncate + send) | 'update' (content-only, reserved)
     * - lastUserMessageIndex: index of the latest user turn (for regenerate)
     */
    editingMessageIndex: null,
    editMode: 'resend',
    lastUserMessageIndex: null,
    /** Running count of messages in the open session (for stream-time indices). */
    sessionMessageCount: 0,
};

const BOOLEAN_SETTING_DEFAULTS = {
    interactive_search: true,
    live_artifacts_mode: false,
    bridge_require_before_send: true,
    bridge_show_banner: true,
    bridge_toast_on_change: true,
};

export function coerceBooleanSetting(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
    }
    if (value === undefined || value === null) return fallback;
    return Boolean(value);
}

function normalizeBooleanSettings(settings) {
    if (!settings || typeof settings !== 'object') return {};
    const normalized = { ...settings };
    Object.entries(BOOLEAN_SETTING_DEFAULTS).forEach(([key, fallback]) => {
        if (Object.prototype.hasOwnProperty.call(normalized, key)) {
            normalized[key] = coerceBooleanSetting(normalized[key], fallback);
        }
    });
    return normalized;
}

export function setCurrentSessionId(id) {
    state.currentSessionId = id;
}

export function bumpChatEpoch() {
    state.chatEpoch = (Number(state.chatEpoch) || 0) + 1;
    return state.chatEpoch;
}

/** True when a stream/load started under `epoch` is still the active view. */
export function isChatEpochCurrent(epoch) {
    return Number(epoch) === Number(state.chatEpoch);
}

/**
 * Abort any in-flight chat stream and clear the processing flag.
 * Does not bump chatEpoch — call bumpChatEpoch() when leaving the view.
 */
export function abortActiveStream() {
    if (state.abortController) {
        try {
            state.abortController.abort();
        } catch {
            // ignore repeated abort
        }
        state.abortController = null;
    }
    state.isProcessing = false;
}

export function setSettings(newSettings) {
    const normalizedSettings = normalizeBooleanSettings(newSettings);
    state.settings = { ...state.settings, ...normalizedSettings };
    if (
        normalizedSettings
        && Object.prototype.hasOwnProperty.call(normalizedSettings, 'live_artifacts_mode')
    ) {
        state.liveArtifactsMode = coerceBooleanSetting(normalizedSettings.live_artifacts_mode);
    }
}

export function setIsProcessing(flag) {
    state.isProcessing = flag;
}

export function setAbortController(controller) {
    state.abortController = controller;
}

export function setLiveArtifactsMode(flag) {
    state.liveArtifactsMode = coerceBooleanSetting(flag);
}

export function setBridgeConnected(flag) {
    if (flag === null || flag === undefined) {
        state.bridgeConnected = null;
        return;
    }
    state.bridgeConnected = Boolean(flag);
}

export function setSessionMessageCount(count) {
    const n = Number(count);
    state.sessionMessageCount = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function setLastUserMessageIndex(index) {
    if (index === null || index === undefined || index === '') {
        state.lastUserMessageIndex = null;
        return;
    }
    const n = Number(index);
    state.lastUserMessageIndex = Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * Enter AMC-style edit of a user message.
 * @param {number|null} messageIndex 0-based index in session history
 * @param {'resend'|'update'} [mode='resend']
 */
export function setEditingMessage(messageIndex, mode = 'resend') {
    if (messageIndex === null || messageIndex === undefined || messageIndex === '') {
        state.editingMessageIndex = null;
        state.editMode = 'resend';
        return;
    }
    const n = Number(messageIndex);
    state.editingMessageIndex = Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
    state.editMode = mode === 'update' ? 'update' : 'resend';
}

export function clearEditingMessage() {
    state.editingMessageIndex = null;
    state.editMode = 'resend';
}

export function isEditingMessage() {
    return state.editingMessageIndex !== null && state.editingMessageIndex !== undefined;
}
