import { authFetch } from './auth.js?v=1';
import { coerceBooleanSetting, setCurrentSessionId, state } from './state.js?v=5';
import { abandonActiveChatWork } from './chat.js?v=53';
import { showToast } from './toast.js';
import { elements, showConfirm } from './ui.js?v=40';
import { t, getLanguage, setLanguage } from './i18n.js?v=1';
import { setupSettingsSearch } from './settings-search.js?v=2';
import { renderHistory } from './history-view.js?v=25';
import {
    getModelDisplayName,
    getSupportedModelItems,
    isUnsupportedGemini25Model,
    splitModelItem,
} from './provider-models.js?v=1';
import {
    buildDisplayProviderRows,
    getBaseUrlWarning,
    getProviderCatalogEntry,
    isProviderEnabled,
    mergeModelOptions,
    parseModelListText,
    serializeModels,
} from './provider-catalog.js?v=2';
import * as API from './api.js?v=14';
import {
    clampBaseFontSize,
    clampLiveArtifactsFontSize,
    resolveBaseFontSize,
    resolveLiveArtifactsFontSize,
} from './utils.js?v=13';
import {
    applyBridgePreferencesFromSettings,
    fetchBridgeStatus,
    normalizeBridgePollIntervalSec,
    wireBridgeSettingsPanel,
} from './bridge.js?v=9';

const WORKFLOW_STEPS = [
    { id: 'analysis', labelKey: 'settings.stepAnalysis' },
    { id: 'relevance', labelKey: 'settings.stepRelevance' },
    { id: 'interaction', labelKey: 'settings.stepInteraction' },
    { id: 'answer', labelKey: 'settings.stepAnswer' },
];

const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SETTINGS_SAVE_STATES = {
    saved: { icon: 'check_circle', textKey: 'settings.saveSaved' },
    pending: { icon: 'sync', textKey: 'settings.savePending' },
    saving: { icon: 'progress_activity', textKey: 'settings.saveSaving' },
    invalid: { icon: 'error', textKey: 'settings.saveInvalid' },
    error: { icon: 'warning', textKey: 'settings.saveError' },
};
const SETTINGS_LAST_TAB_STORAGE_KEY = 'justsearch_settings_last_tab';

let isApplyingSettingsForm = false;
let requestSettingsAutoSave = () => {};
let flushSettingsAutoSave = () => Promise.resolve(false);

function safeGetLocalStorageItem(key, fallback = '') {
    try {
        return localStorage.getItem(key) ?? fallback;
    } catch {
        return fallback;
    }
}

function safeSetLocalStorageItem(key, value) {
    try {
        localStorage.setItem(key, String(value));
    } catch {
        // Storage can be unavailable in private browsing or embedded contexts.
    }
}

export function setupSettingsModal({ updateModelSelector, historyCallbacks, onSettingsSaved, onLanguageChanged }) {
    const settingsBtn = document.getElementById('settings-btn');
    // Guard: if ui.js was loaded as a separate module instance (mismatched ?v=),
    // elements.settingsModal may be null and the whole setup would throw before binding clicks.
    if (!elements?.settingsModal) {
        console.error(
            '[JustSearch] settings modal element missing — check that all modules import the same ui.js?v= version'
        );
        return;
    }
    if (!settingsBtn) {
        console.error('[JustSearch] #settings-btn not found');
        return;
    }
    const closeBtn = elements.settingsModal.querySelector('.close-btn');
    const resetSettingsBtn = document.getElementById('reset-settings-btn');
    const clearHistoryBtn = document.getElementById('clear-history-btn');
    const clearCacheBtn = document.getElementById('clear-cache-btn');
    const exportHistoryBtn = document.getElementById('export-history-btn');
    const importHistoryBtn = document.getElementById('import-history-btn');
    const historyImportInput = document.getElementById('history-import-input');

    // Tab Switching Logic
    const tabs = elements.settingsModal.querySelectorAll('.settings-tab-btn');
    const panels = elements.settingsModal.querySelectorAll('.settings-panel');

    function switchTab(tabId) {
        // Validate tabId exists, otherwise fallback to 'general'
        const hasTab = Array.from(tabs).some(tab => tab.getAttribute('data-tab') === tabId);
        const activeTabId = hasTab ? tabId : 'general';

        tabs.forEach(tab => {
            const isActive = tab.getAttribute('data-tab') === activeTabId;
            tab.classList.toggle('active', isActive);
            tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        panels.forEach(panel => {
            panel.classList.toggle('active', panel.id === `tab-${activeTabId}`);
        });
        safeSetLocalStorageItem(SETTINGS_LAST_TAB_STORAGE_KEY, activeTabId);
        if (activeTabId === 'bridge') {
            wireBridgeSettingsPanel();
            fetchBridgeStatus().catch(() => {});
        }
    }

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabId = tab.getAttribute('data-tab');
            switchTab(tabId);
        });
    });

    // AMC-style settings search across all tabs.
    setupSettingsSearch({ modalEl: elements.settingsModal });

    let _settingsPreviouslyFocused = null;

    const openSettings = async () => {
        const sidebar = document.getElementById('sidebar');
        const mobileOverlay = document.getElementById('mobile-overlay');
        if (sidebar) {
            sidebar.classList.remove('mobile-open');
        }
        if (mobileOverlay) {
            mobileOverlay.classList.remove('active');
        }
        _settingsPreviouslyFocused = document.activeElement;
        const lastTab = safeGetLocalStorageItem(SETTINGS_LAST_TAB_STORAGE_KEY, 'general');
        switchTab(lastTab);
        elements.settingsModal.classList.add('active');
        // 焦点移入模态，便于键盘用户操作
        requestAnimationFrame(() => {
            const firstFocusable = elements.settingsModal.querySelector(
                '.settings-sidebar-close-btn, button, [tabindex]:not([tabindex="-1"])'
            );
            if (firstFocusable) firstFocusable.focus();
        });
        await updateVersionDisplay();
        await API.fetchSettings();
        await populateSettingsForm(rememberCurrentSettingsPayload);
        wireBridgeSettingsPanel();
        fetchBridgeStatus().catch(() => {});
    };

    settingsBtn.addEventListener('click', openSettings);

    const miniSettingsBtn = document.getElementById('mini-settings-btn');
    if (miniSettingsBtn) {
        miniSettingsBtn.addEventListener('click', openSettings);
    }

    const closeSettingsModal = async () => {
        try {
            await flushSettingsAutoSave();
        } finally {
            elements.settingsModal.classList.remove('active');
            // 焦点归还到打开者
            if (_settingsPreviouslyFocused && typeof _settingsPreviouslyFocused.focus === 'function') {
                _settingsPreviouslyFocused.focus();
            }
        }
    };

    closeBtn.addEventListener('click', closeSettingsModal);

    // 焦点陷阱：在设置模态内循环 Tab，防止跑到背景页面
    const SETTINGS_FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    elements.settingsModal.addEventListener('keydown', (event) => {
        if (event.key !== 'Tab' || !elements.settingsModal.classList.contains('active')) return;
        const focusable = Array.from(elements.settingsModal.querySelectorAll(SETTINGS_FOCUSABLE))
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
    });

    window.addEventListener('click', (event) => {
        if (event.target === elements.settingsModal) {
            closeSettingsModal();
        }
    });

    resetSettingsBtn.addEventListener('click', async () => {
        if (!(await showConfirm(t('settings.confirmReset'), t('settings.resetSettings')))) return;
        const defaults = await API.restoreDefaultSettingsAPI();
        if (defaults) {
            fillSettingsForm(defaults);
            if (await flushSettingsAutoSave()) {
                // Reset the client-only language preference back to Chinese too.
                try { localStorage.removeItem('justsearch_language'); } catch (e) { /* ignore */ }
                setLanguage('zh');
                if (typeof onLanguageChanged === 'function') onLanguageChanged();
                showToast(t('settings.resetDone'), 'success');
            } else {
                showToast(t('settings.resetFailed'), 'error');
            }
        } else {
            showToast(t('settings.loadDefaultsFailed'), 'error');
        }
    });

    clearHistoryBtn.addEventListener('click', async () => {
        if (!(await showConfirm(t('settings.confirmClearHistory'), t('settings.clearHistory')))) return;
        if (await API.clearHistoryAPI()) {
            resetConversationView(historyCallbacks);
            elements.settingsModal.classList.remove('active');
            showToast(t('settings.historyCleared'), 'success');
        } else {
            showToast(t('settings.historyClearFailed'), 'error');
        }
    });

    if (exportHistoryBtn) {
        exportHistoryBtn.addEventListener('click', async () => {
            exportHistoryBtn.disabled = true;
            try {
                if (await API.exportHistoryAPI()) {
                    showToast(t('settings.exportDone'), 'success');
                } else {
                    showToast(t('settings.exportFailed'), 'error');
                }
            } finally {
                exportHistoryBtn.disabled = false;
            }
        });
    }

    if (importHistoryBtn && historyImportInput) {
        importHistoryBtn.addEventListener('click', () => {
            historyImportInput.click();
        });
        historyImportInput.addEventListener('change', async () => {
            const file = historyImportInput.files?.[0];
            historyImportInput.value = '';
            if (!file) return;
            await importHistoryFile(file, historyCallbacks, importHistoryBtn);
        });
    }

    if (clearCacheBtn) {
        clearCacheBtn.addEventListener('click', async () => {
            if (!(await showConfirm(t('settings.confirmClearCache'), t('settings.clearCache')))) return;
            if (await API.clearCacheAPI()) {
                resetConversationView(historyCallbacks);
                elements.settingsModal.classList.remove('active');
                showToast(t('settings.cacheCleared'), 'success');
                setTimeout(() => window.location.reload(), 1500);
            } else {
                showToast(t('settings.cacheClearFailed'), 'error');
            }
        });
    }

    setupEngineCheckControls();
    initProviderListUI();

    let saveTimeout = null;
    let saveInFlight = false;
    let saveAgain = false;
    let lastSavedPayload = '';

    setSettingsSaveStatus('saved');

    function rememberCurrentSettingsPayload() {
        const currentSettings = collectSettingsForm();
        lastSavedPayload = canAutoSaveSettings(currentSettings)
            ? JSON.stringify(currentSettings)
            : '';
        updateProviderValidationUI(currentSettings);
        updateProviderCountLabel(currentSettings.providers.filter(p => isProviderEnabled(p)).length);
        setSettingsSaveStatus('saved');
    }

    async function persistSettings() {
        if (isApplyingSettingsForm) return false;
        if (saveInFlight) {
            saveAgain = true;
            return false;
        }

        const newSettings = collectSettingsForm();
        const validation = validateSettingsForm(newSettings);
        updateProviderValidationUI(newSettings, validation);
        updateProviderCountLabel(newSettings.providers.filter(p => isProviderEnabled(p)).length);
        if (!validation.ok) {
            setSettingsSaveStatus('invalid', validation.message);
            return false;
        }

        const payload = JSON.stringify(newSettings);
        if (payload === lastSavedPayload) {
            setSettingsSaveStatus('saved');
            return true;
        }

        saveInFlight = true;
        setSettingsSaveStatus('saving');
        try {
            if (await API.saveSettingsAPI(newSettings)) {
                markSavedProviderIdentities();
                lastSavedPayload = JSON.stringify(collectSettingsForm());
                setSettingsSaveStatus('saved');
                updateModelSelector(state.settings);
                if (typeof onSettingsSaved === 'function') {
                    onSettingsSaved();
                }
                return true;
            }
            setSettingsSaveStatus('error', t('settings.saveErrorRetry'));
            showToast(t('settings.saveFailed'), 'error');
            return false;
        } finally {
            saveInFlight = false;
            if (saveAgain) {
                saveAgain = false;
                requestSettingsAutoSave();
            }
        }
    }

    requestSettingsAutoSave = ({ immediate = false } = {}) => {
        if (isApplyingSettingsForm) return;
        if (saveTimeout) clearTimeout(saveTimeout);
        const settings = collectSettingsForm();
        const validation = validateSettingsForm(settings);
        updateProviderValidationUI(settings, validation);
        updateProviderCountLabel(settings.providers.filter(p => isProviderEnabled(p)).length);
        setSettingsSaveStatus(validation.ok ? 'pending' : 'invalid', validation.ok ? '' : validation.message);
        saveTimeout = setTimeout(persistSettings, immediate ? 0 : 700);
    };

    flushSettingsAutoSave = async () => {
        if (saveTimeout) {
            clearTimeout(saveTimeout);
            saveTimeout = null;
        }
        return persistSettings();
    };

    const autoSaveInputs = [
        'theme-select',
        'engine-select',
        'max-results-input',
        'max-iterations-input',
        'history-window-input',
        'history-char-budget-input',
        'assistant-turn-char-budget-input',
        'interactive-search-input',
        'base-font-size-input',
        'live-artifacts-font-size-input',
        'completion-notification-input',
        'completion-sound-input',
        'bridge-require-before-send-input',
        'bridge-show-banner-input',
        'bridge-toast-on-change-input',
        'bridge-poll-interval-select',
    ];

    autoSaveInputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            const eventType = (el.tagName === 'SELECT' || el.type === 'checkbox') ? 'change' : 'input';
            el.addEventListener(eventType, () => requestSettingsAutoSave());
        }
    });

    // Language select — client-only preference, deliberately OUTSIDE
    // autoSaveInputs/collectSettingsForm so it never enters the backend payload.
    const langSelect = document.getElementById('language-select');
    if (langSelect) {
        langSelect.addEventListener('change', () => {
            setLanguage(langSelect.value);
            if (typeof onLanguageChanged === 'function') onLanguageChanged();
        });
    }

    // 开启「桌面通知」开关时申请浏览器通知权限（仅申请一次；已拒绝/已授权时不打扰）。
    const completionNotificationInput = document.getElementById('completion-notification-input');
    if (completionNotificationInput) {
        completionNotificationInput.addEventListener('change', async () => {
            if (!completionNotificationInput.checked) return;
            if (typeof window === 'undefined' || !('Notification' in window)) {
                showToast(t('settings.notifyUnsupported'), 'warning');
                return;
            }
            if (Notification.permission === 'denied') {
                showToast(t('settings.notifyDenied'), 'warning');
                return;
            }
            if (Notification.permission === 'default') {
                try {
                    await Notification.requestPermission();
                } catch (err) {
                    showToast(t('settings.notifyRequestFailed'), 'warning');
                }
            }
        });
    }

    const baseFontSizeInput = document.getElementById('base-font-size-input');
    if (baseFontSizeInput) {
        baseFontSizeInput.addEventListener('input', () => {
            updateFontSizeValueLabel('base-font-size-input', 'base-font-size-value');
        });
    }
    const liveArtifactsFontSizeInput = document.getElementById('live-artifacts-font-size-input');
    if (liveArtifactsFontSizeInput) {
        liveArtifactsFontSizeInput.addEventListener('input', () => {
            updateFontSizeValueLabel('live-artifacts-font-size-input', 'live-artifacts-font-size-value');
        });
    }

    return {
        // Re-fill the whole form (localized labels re-resolve via data-i18n scan
        // in applyI18n; this re-syncs the language <select> and dynamic values).
        refreshSettingsForm: () => {
            if (typeof state.settings === 'object' && state.settings) {
                fillSettingsForm(state.settings);
            }
        },
    };
}

function updateFontSizeValueLabel(inputId, labelId) {
    const input = document.getElementById(inputId);
    const label = document.getElementById(labelId);
    if (!input || !label) return;
    const value = inputId === 'live-artifacts-font-size-input'
        ? clampLiveArtifactsFontSize(input.value)
        : clampBaseFontSize(input.value);
    label.textContent = `${value}px`;
    input.setAttribute('aria-valuenow', String(value));
}

async function importHistoryFile(file, historyCallbacks, importHistoryBtn) {
    if (!file.name.toLowerCase().endsWith('.json')) {
        showToast(t('settings.importNeedJson'), 'warning');
        return;
    }

    importHistoryBtn.disabled = true;
    try {
        const text = await file.text();
        let payload;
        try {
            payload = JSON.parse(text);
        } catch (e) {
            showToast(t('settings.importInvalidJson'), 'error');
            return;
        }

        const result = await API.importHistoryAPI(payload);
        if (!result || result.status !== 'ok') {
            showToast(result?.detail || t('settings.importFailed'), 'error');
            return;
        }

        const [history, groups] = await Promise.all([
            API.fetchHistory(),
            API.fetchChatGroups(),
        ]);
        renderHistory(history, state.currentSessionId, historyCallbacks, groups);
        showToast(
            t('settings.importDone', {
                imported: result.imported_sessions || 0,
                skipped: result.skipped_sessions || 0,
            }),
            'success',
        );
    } finally {
        importHistoryBtn.disabled = false;
    }
}

async function updateVersionDisplay() {
    const versionEl = document.getElementById('version-display');
    const aboutVersionEl = document.getElementById('about-version');
    if (!versionEl && !aboutVersionEl) return;

    try {
        const healthRes = await authFetch('/api/health');
        if (healthRes.ok) {
            const health = await healthRes.json();
            const versionText = formatVersionText(health.version);
            if (versionEl) {
                versionEl.textContent = versionText;
            }
            if (aboutVersionEl) {
                aboutVersionEl.textContent = versionText;
            }
            if (versionEl && health.memory_mb) {
                versionEl.title = `Memory: ${health.memory_mb} MB`;
            }
        }
    } catch (e) {
        // Version metadata is non-critical.
    }
}

function formatVersionText(version) {
    const rawVersion = String(version || '?.?.?').trim();
    if (!rawVersion || rawVersion === '?.?.?') return 'v?.?.?';
    return rawVersion.startsWith('v') || /[^\d.]/.test(rawVersion)
        ? rawVersion
        : `v${rawVersion}`;
}

async function populateSettingsForm(onFilled) {
    fillSettingsForm(state.settings);
    if (typeof onFilled === 'function') {
        onFilled();
    }

    const starsCountElement = document.getElementById('github-stars-count');
    const aboutStarsCountElement = document.getElementById('about-stars-count');
    if (starsCountElement || aboutStarsCountElement) {
        const stats = await API.fetchGitHubStats();
        if (stats && stats.stars !== undefined) {
            if (starsCountElement) {
                starsCountElement.textContent = stats.stars;
            }
            if (aboutStarsCountElement) {
                aboutStarsCountElement.textContent = stats.stars;
            }
        }
    }
}

function fillSettingsForm(settings) {
    isApplyingSettingsForm = true;
    try {
        document.getElementById('theme-select').value = settings.theme || 'light';
        const langSel = document.getElementById('language-select');
        if (langSel) langSel.value = getLanguage();
        document.getElementById('engine-select').value = settings.search_engine || 'google';
        document.getElementById('max-results-input').value = normalizeNumberSetting(settings.max_results, 50, 1, 50);
        document.getElementById('max-iterations-input').value = normalizeNumberSetting(settings.max_iterations, 5, 1, 10);
        document.getElementById('history-window-input').value = normalizeNumberSetting(settings.history_window, 12, 2, 30);
        document.getElementById('history-char-budget-input').value = normalizeNumberSetting(settings.history_char_budget, 12000, 2000, 60000);
        document.getElementById('assistant-turn-char-budget-input').value = normalizeNumberSetting(settings.assistant_turn_char_budget, 900, 200, 5000);
        const baseFontSize = resolveBaseFontSize(settings);
        const liveArtifactsFontSize = resolveLiveArtifactsFontSize(settings);
        const baseFontSizeInput = document.getElementById('base-font-size-input');
        if (baseFontSizeInput) {
            baseFontSizeInput.value = String(baseFontSize);
            updateFontSizeValueLabel('base-font-size-input', 'base-font-size-value');
        }
        const liveArtifactsFontSizeInput = document.getElementById('live-artifacts-font-size-input');
        if (liveArtifactsFontSizeInput) {
            liveArtifactsFontSizeInput.value = String(liveArtifactsFontSize);
            updateFontSizeValueLabel('live-artifacts-font-size-input', 'live-artifacts-font-size-value');
        }
        renderProviderList(settings.providers || [], settings.default_provider_id || '');
        renderWorkflowStepModels(
            settings.workflow_step_models || {},
            settings.providers || [],
            settings.default_provider_id || '',
        );
        document.getElementById('interactive-search-input').checked = coerceBooleanSetting(settings.interactive_search, true);
        const citationVerifyInput = document.getElementById('citation-verify-input');
        if (citationVerifyInput) {
            citationVerifyInput.checked = coerceBooleanSetting(settings.citation_verification_enabled, false);
        }
        const completionNotificationInput = document.getElementById('completion-notification-input');
        if (completionNotificationInput) {
            completionNotificationInput.checked = coerceBooleanSetting(settings.completion_notification_enabled, false);
        }
        const completionSoundInput = document.getElementById('completion-sound-input');
        if (completionSoundInput) {
            completionSoundInput.checked = coerceBooleanSetting(settings.completion_sound_enabled, false);
        }
        const requireBridgeInput = document.getElementById('bridge-require-before-send-input');
        if (requireBridgeInput) {
            requireBridgeInput.checked = coerceBooleanSetting(settings.bridge_require_before_send, true);
        }
        const showBannerInput = document.getElementById('bridge-show-banner-input');
        if (showBannerInput) {
            showBannerInput.checked = coerceBooleanSetting(settings.bridge_show_banner, true);
        }
        const toastOnChangeInput = document.getElementById('bridge-toast-on-change-input');
        if (toastOnChangeInput) {
            toastOnChangeInput.checked = coerceBooleanSetting(settings.bridge_toast_on_change, true);
        }
        const pollIntervalSelect = document.getElementById('bridge-poll-interval-select');
        if (pollIntervalSelect) {
            pollIntervalSelect.value = String(
                normalizeBridgePollIntervalSec(settings.bridge_poll_interval_sec, 5)
            );
        }
        updateProviderValidationUI();
        updateProviderCountLabel(getEnabledProviderCount());
        setSettingsSaveStatus('saved');
        applyBridgePreferencesFromSettings();
    } finally {
        isApplyingSettingsForm = false;
    }
}

function collectSettingsForm() {
    const providers = collectProvidersForm();
    const defaultProvider = document.querySelector('input[name="default-provider-radio"]:checked');
    const baseFontSizeInput = document.getElementById('base-font-size-input');
    const liveArtifactsFontSizeInput = document.getElementById('live-artifacts-font-size-input');
    const requireBridgeInput = document.getElementById('bridge-require-before-send-input');
    const showBannerInput = document.getElementById('bridge-show-banner-input');
    const toastOnChangeInput = document.getElementById('bridge-toast-on-change-input');
    const pollIntervalSelect = document.getElementById('bridge-poll-interval-select');
    const citationVerifyInput = document.getElementById('citation-verify-input');
    return {
        theme: document.getElementById('theme-select').value,
        search_engine: document.getElementById('engine-select').value,
        max_results: normalizeNumberSetting(document.getElementById('max-results-input').value, 50, 1, 50),
        max_iterations: normalizeNumberSetting(document.getElementById('max-iterations-input').value, 5, 1, 10),
        history_window: normalizeNumberSetting(document.getElementById('history-window-input').value, 12, 2, 30),
        history_char_budget: normalizeNumberSetting(document.getElementById('history-char-budget-input').value, 12000, 2000, 60000),
        assistant_turn_char_budget: normalizeNumberSetting(document.getElementById('assistant-turn-char-budget-input').value, 900, 200, 5000),
        base_font_size: clampBaseFontSize(baseFontSizeInput?.value ?? 16),
        live_artifacts_font_size: clampLiveArtifactsFontSize(liveArtifactsFontSizeInput?.value ?? 16),
        default_provider_id: defaultProvider?.value || providers[0]?.id || '',
        providers,
        workflow_step_models: collectWorkflowStepModels(),
        interactive_search: document.getElementById('interactive-search-input').checked,
        citation_verification_enabled: citationVerifyInput
            ? citationVerifyInput.checked
            : coerceBooleanSetting(state.settings?.citation_verification_enabled, false),
        completion_notification_enabled: coerceBooleanSetting(
            document.getElementById('completion-notification-input')?.checked,
            coerceBooleanSetting(state.settings?.completion_notification_enabled, false),
        ),
        completion_sound_enabled: coerceBooleanSetting(
            document.getElementById('completion-sound-input')?.checked,
            coerceBooleanSetting(state.settings?.completion_sound_enabled, false),
        ),
        bridge_require_before_send: requireBridgeInput
            ? requireBridgeInput.checked
            : coerceBooleanSetting(state.settings?.bridge_require_before_send, true),
        bridge_show_banner: showBannerInput
            ? showBannerInput.checked
            : coerceBooleanSetting(state.settings?.bridge_show_banner, true),
        bridge_toast_on_change: toastOnChangeInput
            ? toastOnChangeInput.checked
            : coerceBooleanSetting(state.settings?.bridge_toast_on_change, true),
        bridge_poll_interval_sec: normalizeBridgePollIntervalSec(
            pollIntervalSelect?.value ?? state.settings?.bridge_poll_interval_sec,
            5
        ),
    };
}

function normalizeNumberSetting(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function canAutoSaveSettings(settings) {
    return validateSettingsForm(settings).ok;
}

function validateSettingsForm(settings) {
    const providers = Array.isArray(settings?.providers) ? settings.providers : [];
    const errors = [];
    const providerIds = new Map();
    const enabledProviderIds = new Set();
    const enabledCount = providers.filter(provider => isProviderEnabled(provider)).length;

    if (enabledCount === 0) {
        errors.push({ message: t('settings.errNoEnabledProvider') });
    }

    providers.forEach((provider, index) => {
        const enabled = isProviderEnabled(provider);
        const id = String(provider.id || '').trim();
        const baseUrl = String(provider.base_url || '').trim();
        const modelId = String(provider.model_id || '').trim();

        if (!id) {
            errors.push({ index, field: 'id', message: t('settings.errProviderIdEmpty') });
        } else if (!PROVIDER_ID_PATTERN.test(id)) {
            errors.push({ index, field: 'id', message: t('settings.errProviderIdChars') });
        } else if (providerIds.has(id)) {
            errors.push({ index, field: 'id', message: t('settings.errProviderIdDuplicate') });
            errors.push({ index: providerIds.get(id), field: 'id', message: t('settings.errProviderIdDuplicate') });
        } else {
            providerIds.set(id, index);
        }

        // Disabled providers may stay unconfigured (e.g. a preset you haven't set up yet).
        if (enabled) {
            enabledProviderIds.add(id);
            if (!baseUrl) {
                errors.push({ index, field: 'base_url', message: t('settings.errBaseUrlEmpty') });
            }
            if (!modelId) {
                errors.push({ index, field: 'model_id', message: t('settings.errModelRequired') });
            }
        }
    });

    const defaultProviderId = String(settings.default_provider_id || '').trim();
    if (defaultProviderId && !enabledProviderIds.has(defaultProviderId)) {
        errors.push({ message: t('settings.errDefaultProviderDisabled') });
    }

    return {
        ok: errors.length === 0,
        errors,
        message: errors[0]?.message || '',
    };
}

function setSettingsSaveStatus(status, message = '') {
    const el = document.getElementById('settings-save-status');
    if (!el) return;

    const nextStatus = SETTINGS_SAVE_STATES[status] ? status : 'saved';
    const stateConfig = SETTINGS_SAVE_STATES[nextStatus];
    el.className = `settings-save-status is-${nextStatus}`;
    const icon = el.querySelector('.material-symbols-rounded');
    const text = el.querySelector('span:last-child');
    if (icon) {
        icon.textContent = stateConfig.icon;
    }
    if (text) {
        text.textContent = message || t(stateConfig.textKey);
    }
}

function updateProviderCountLabel(count) {
    const label = document.getElementById('provider-count-label');
    if (!label) return;
    label.textContent = t('settings.providerEnabledCount', { count: count || 0 });
}

function getEnabledProviderCount() {
    return Array.from(document.querySelectorAll('.provider-card'))
        .filter(card => card.querySelector('.provider-enable-input')?.checked)
        .length;
}

function updateProviderValidationUI(settings = collectSettingsForm(), validation = validateSettingsForm(settings)) {
    clearProviderValidationUI();
    const cards = Array.from(document.querySelectorAll('.provider-card'));
    validation.errors.forEach((error) => {
        if (typeof error.index !== 'number') return;
        const card = cards[error.index];
        if (!card) return;
        const fieldMap = {
            id: '.provider-id-input',
            base_url: '.provider-base-url-input',
            model_id: '.model-settings-group',
        };
        const target = card.querySelector(fieldMap[error.field]);
        if (target) {
            markProviderFieldError(target, error.message);
        }
    });
}

function clearProviderValidationUI() {
    document.querySelectorAll('.provider-field-error').forEach(el => el.remove());
    document.querySelectorAll('.provider-card .has-error').forEach(el => el.classList.remove('has-error'));
    document.querySelectorAll('.provider-card [aria-invalid="true"]').forEach(el => {
        el.removeAttribute('aria-invalid');
    });
}

function markProviderFieldError(target, message) {
    const group = target.classList.contains('form-group') || target.classList.contains('model-settings-group')
        ? target
        : target.closest('.form-group');
    if (!group) return;
    group.classList.add('has-error');
    if ('setAttribute' in target && target.tagName !== 'DIV') {
        target.setAttribute('aria-invalid', 'true');
    }
    const error = document.createElement('div');
    error.className = 'provider-field-error';
    error.textContent = message;
    group.appendChild(error);
}

function setupEngineCheckControls() {
    const checkEnginesBtn = document.getElementById('check-engines-btn');
    if (checkEnginesBtn) {
        checkEnginesBtn.addEventListener('click', checkSearchEngines);
    }
}

async function checkSearchEngines(e) {
    e.preventDefault();
    const checkEnginesBtn = e.currentTarget;
    const resultsEl = document.getElementById('engine-check-results');
    const checkIcon = checkEnginesBtn.querySelector('.material-symbols-rounded');

    checkEnginesBtn.disabled = true;
    checkEnginesBtn.classList.add('is-checking');
    if (checkIcon) {
        checkIcon.textContent = 'progress_activity';
    }
    if (resultsEl) {
        resultsEl.classList.add('active');
        renderEngineCheckStatus(resultsEl, 'engine-check-pending', 'progress_activity', t('settings.engineCheckPending'));
    }

    try {
        const data = await API.checkEnginesAPI();
        if (!data || !Array.isArray(data.results)) {
            showToast(t('settings.engineCheckFailed'), 'error');
            renderEngineCheckResults({ results: [] });
            return;
        }

        renderEngineCheckResults(data);
        const availableCount = data.results.filter(item => item.available).length;
        const totalCount = data.results.length;
        const toastType = availableCount === totalCount ? 'success' : 'warning';
        showToast(t('settings.engineCheckDone', { available: availableCount, total: totalCount }), toastType);
    } catch (err) {
        showToast(t('settings.engineCheckRequestFailed'), 'error');
        renderEngineCheckResults({ results: [] });
    } finally {
        checkEnginesBtn.disabled = false;
        checkEnginesBtn.classList.remove('is-checking');
        if (checkIcon) {
            checkIcon.textContent = 'network_check';
        }
    }
}

function renderEngineCheckResults(data) {
    const resultsEl = document.getElementById('engine-check-results');
    if (!resultsEl) return;

    const results = Array.isArray(data.results) ? data.results : [];
    resultsEl.classList.add('active');
    resultsEl.replaceChildren();

    if (results.length === 0) {
        renderEngineCheckStatus(resultsEl, 'engine-check-empty', 'error', t('settings.engineCheckEmpty'));
        return;
    }

    if (data.query) {
        const queryEl = document.createElement('div');
        queryEl.className = 'engine-check-query';
        queryEl.textContent = t('settings.engineCheckQuery', { query: data.query });
        resultsEl.appendChild(queryEl);
    }

    const list = document.createElement('div');
    list.className = 'engine-check-list';

    results.forEach(result => {
        const available = Boolean(result.available);
        const statusClass = available ? 'available' : 'unavailable';
        const icon = available ? 'check_circle' : 'error';
        const label = getEngineDisplayName(result.engine);
        const resultCount = Number(result.result_count || 0);
        const detail = available
            ? t('settings.engineAvailable', { count: Number.isFinite(resultCount) ? resultCount : 0 })
            : t('settings.engineUnavailable', { error: result.error || t('settings.engineNoResult') });

        const item = document.createElement('div');
        item.className = `engine-check-result ${statusClass}`;

        const iconEl = document.createElement('span');
        iconEl.className = 'material-symbols-rounded';
        iconEl.textContent = icon;

        const copy = document.createElement('div');
        copy.className = 'engine-check-copy';

        const name = document.createElement('div');
        name.className = 'engine-check-name';
        name.textContent = label;

        const detailEl = document.createElement('div');
        detailEl.className = 'engine-check-detail';
        detailEl.textContent = detail;

        copy.append(name, detailEl);
        item.append(iconEl, copy);
        list.appendChild(item);
    });

    resultsEl.appendChild(list);
}

function renderEngineCheckStatus(resultsEl, className, icon, message) {
    resultsEl.replaceChildren();

    const wrapper = document.createElement('div');
    wrapper.className = className;

    const iconEl = document.createElement('span');
    iconEl.className = 'material-symbols-rounded';
    iconEl.textContent = icon;

    const copy = document.createElement('span');
    copy.textContent = message;

    wrapper.append(iconEl, copy);
    resultsEl.appendChild(wrapper);
}

function getEngineDisplayName(engine) {
    const names = {
        bing: 'Bing',
        sogou: t('settings.engineSogou'),
        baidu: t('settings.engineBaidu'),
        yandex: 'Yandex',
        duckduckgo: 'DuckDuckGo',
        google: t('settings.engineGoogle'),
        brave: 'Brave Search',
    };
    return names[engine] || engine || 'Unknown';
}

async function runProviderConnectionTest(e) {
    e.preventDefault();
    const testBtn = e.currentTarget;
    const providerCard = testBtn.closest('.provider-card');
    const resultEl = providerCard.querySelector('.provider-test-result');
    const apiKey = providerCard.querySelector('.provider-api-key-input').value.trim();
    const baseUrl = providerCard.querySelector('.provider-base-url-input').value.trim();
    const modelId = providerCard.querySelector('.provider-model-input').value.trim();
    const providerId = providerCard.querySelector('.provider-id-input').value.trim();
    if (isUnsupportedGemini25Model(modelId)) {
        renderConnectionTestResult(resultEl, 'error', t('settings.connGemini25Unsupported'));
        return;
    }

    testBtn.disabled = true;
    testBtn.classList.add('is-testing');
    renderConnectionTestResult(resultEl, 'pending', t('settings.connTesting'));
    try {
        const res = await authFetch('/api/settings/validate-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider_id: providerId,
                previous_provider_id: providerCard.dataset.savedProviderId || providerId,
                api_key: apiKey,
                base_url: baseUrl,
                model_id: (() => {
                    let first = modelId.split(',')[0].trim();
                    return splitModelItem(first).modelId;
                })(),
            }),
        });
        const data = await res.json();
        if (data.valid) {
            renderConnectionTestResult(resultEl, 'success', t('settings.connSuccess', { model: data.model || modelId }));
        } else {
            renderConnectionTestResult(resultEl, 'error', data.error || t('settings.connFailed'));
        }
    } catch (err) {
        renderConnectionTestResult(resultEl, 'error', t('settings.connRequestFailed'));
    } finally {
        testBtn.disabled = false;
        testBtn.classList.remove('is-testing');
    }
}

function renderConnectionTestResult(resultEl, state, message) {
    if (!resultEl) return;
    resultEl.hidden = false;
    resultEl.className = `provider-test-result is-${state}`;
    resultEl.replaceChildren();
    const icon = document.createElement('span');
    icon.className = 'material-symbols-rounded';
    icon.textContent = state === 'success' ? 'check_circle' : state === 'error' ? 'error' : 'progress_activity';
    const text = document.createElement('span');
    text.textContent = message;
    resultEl.append(icon, text);
}

function resetConversationView(historyCallbacks) {
    abandonActiveChatWork(elements);
    setCurrentSessionId(null);
    if (elements.historySearchInput) {
        elements.historySearchInput.value = '';
    }
    renderHistory([], state.currentSessionId, historyCallbacks, []);
    elements.chatContainer.innerHTML = '';
    elements.heroSection.style.display = 'block';
    elements.chatContainer.appendChild(elements.heroSection);
}

function initProviderListUI() {
    const addButton = document.getElementById('add-provider-btn');
    if (!addButton) return;

    addButton.addEventListener('click', () => {
        const providers = collectProvidersForm();
        const currentDefaultProviderId = getSelectedDefaultProviderId();
        const newProvider = createEmptyProvider();
        providers.push(newProvider);
        renderProviderList(
            providers,
            resolveProviderDefaultId(providers, currentDefaultProviderId),
            { preserveCollapsed: true, expandedProviderId: newProvider.id },
        );
        requestSettingsAutoSave({ immediate: true });
    });
}

function renderProviderList(providers, defaultProviderId, options = {}) {
    const container = document.getElementById('provider-list-container');
    if (!container) return;

    const collapseStates = options.preserveCollapsed ? getProviderCollapseStates() : new Map();
    const expandedProviderId = String(options.expandedProviderId || '').trim();
    const displayRows = buildDisplayProviderRows(providers);
    const normalizedDefaultProviderId = String(defaultProviderId || '').trim();
    const enabledIds = displayRows
        .map(row => String(row.provider.id || '').trim())
        .filter((id, index, ids) => id && ids.indexOf(id) === index)
        .filter(id => {
            const row = displayRows.find(r => String(r.provider.id || '').trim() === id);
            return row && isProviderEnabled(row.provider);
        });
    const fallbackDefault = normalizedDefaultProviderId && enabledIds.includes(normalizedDefaultProviderId)
        ? normalizedDefaultProviderId
        : (enabledIds[0] || '');

    container.innerHTML = '';
    displayRows.forEach((row, index) => {
        const providerId = String(row.provider.id || `provider-${index + 1}`).trim();
        const collapsed = expandedProviderId && providerId === expandedProviderId
            ? false
            : collapseStates.has(providerId)
                ? collapseStates.get(providerId)
                : null;
        container.appendChild(createProviderCard(
            row.provider,
            row.logo,
            fallbackDefault,
            index,
            { collapsed, isPreset: row.isPreset },
        ));
    });
    updateProviderCountLabel(enabledIds.length);
    syncDefaultProviderBadges();
    refreshWorkflowStepModelOptions();
}

function getProviderCollapseStates() {
    const states = new Map();
    document.querySelectorAll('.provider-card').forEach((card) => {
        const providerId = card.querySelector('.provider-id-input')?.value.trim() || '';
        if (providerId) {
            states.set(providerId, card.classList.contains('collapsed'));
        }
    });
    return states;
}

function renderWorkflowStepModels(stepModels, providers, defaultProviderId) {
    const container = document.getElementById('workflow-step-models-container');
    if (!container) return;

    const options = getConfiguredModelOptions(providers);
    container.innerHTML = '';

    WORKFLOW_STEPS.forEach((step) => {
        const row = document.createElement('div');
        row.className = 'workflow-step-model-row';
        const selectId = `workflow-step-model-${step.id}`;
        const selected = stepModels?.[step.id] || {};
        const selectedValue = selected.provider_id && selected.model_id
            ? encodeStepModelValue(selected.provider_id, selected.model_id)
            : '';

        const optionHtml = [
            `<option value="">${t('settings.followDefaultModel')}</option>`,
            ...getGroupedWorkflowModelOptions(options, selectedValue),
        ].join('');

        row.innerHTML = `
            <label for="${selectId}">${escapeHtml(t(step.labelKey))}</label>
            <select id="${selectId}" class="workflow-step-model-select" data-step-id="${escapeHtml(step.id)}">
                ${optionHtml}
            </select>
        `;

        container.appendChild(row);
        row.querySelector('select').addEventListener('change', () => {
            requestSettingsAutoSave({ immediate: true });
        });
    });

    container.classList.toggle('is-empty', options.length === 0);
}

function refreshWorkflowStepModelOptions({ providerIdMap = null } = {}) {
    const container = document.getElementById('workflow-step-models-container');
    if (!container) return;
    const current = collectWorkflowStepModels();
    if (providerIdMap) {
        Object.values(current).forEach((stepModel) => {
            if (providerIdMap.has(stepModel.provider_id)) {
                stepModel.provider_id = providerIdMap.get(stepModel.provider_id);
            }
        });
    }
    const providers = collectProvidersForm();
    renderWorkflowStepModels(current, providers, getSelectedDefaultProviderId() || providers[0]?.id || '');
}

function getSelectedDefaultProviderId() {
    return document.querySelector('input[name="default-provider-radio"]:checked')?.value || '';
}

function resolveProviderDefaultId(providers, preferredProviderId = '') {
    const providerIds = (Array.isArray(providers) ? providers : [])
        .map(provider => String(provider.id || '').trim())
        .filter(Boolean);
    const preferred = String(preferredProviderId || '').trim();
    return providerIds.includes(preferred) ? preferred : (providerIds[0] || '');
}

function collectWorkflowStepModels() {
    const result = {};
    WORKFLOW_STEPS.forEach((step) => {
        result[step.id] = { provider_id: '', model_id: '' };
    });

    document.querySelectorAll('.workflow-step-model-select').forEach((select) => {
        const stepId = select.dataset.stepId;
        if (!stepId || !result[stepId]) return;
        const parsed = decodeStepModelValue(select.value);
        result[stepId] = parsed || { provider_id: '', model_id: '' };
    });

    return result;
}

function getConfiguredModelOptions(providers) {
    const options = [];
    (Array.isArray(providers) ? providers : []).forEach((provider) => {
        const providerId = String(provider.id || '').trim();
        if (!providerId || !isProviderEnabled(provider)) return;

        getSupportedModelItems(provider.model_id).forEach((modelValue) => {
            const { modelId, displayName } = splitModelItem(modelValue);
            if (!modelId) return;
            const providerName = String(provider.name || providerId).trim() || providerId;
            options.push({
                value: encodeStepModelValue(providerId, modelId),
                providerId,
                modelId,
                modelLabel: displayName,
                providerLabel: providerName,
                label: displayName,
                title: `${providerId} / ${modelId}`,
            });
        });
    });
    return options;
}

function getGroupedWorkflowModelOptions(options, selectedValue) {
    const groups = new Map();
    options.forEach((option) => {
        const key = option.providerId || '';
        if (!groups.has(key)) {
            groups.set(key, {
                label: option.providerLabel || option.providerId || 'Provider',
                options: [],
            });
        }
        groups.get(key).options.push(option);
    });

    return Array.from(groups.values()).map((group) => {
        const items = group.options.map((option) => {
            const isSelected = option.value === selectedValue ? 'selected' : '';
            return `<option value="${escapeHtml(option.value)}" title="${escapeHtml(option.title)}" ${isSelected}>${escapeHtml(option.modelLabel || option.label)}</option>`;
        }).join('');
        return `<optgroup label="${escapeHtml(group.label)}">${items}</optgroup>`;
    });
}

function encodeStepModelValue(providerId, modelId) {
    return `${encodeURIComponent(providerId)}|||${encodeURIComponent(modelId)}`;
}

function decodeStepModelValue(value) {
    if (!value) return null;
    const parts = String(value).split('|||');
    if (parts.length !== 2) return null;
    try {
        return {
            provider_id: decodeURIComponent(parts[0]),
            model_id: decodeURIComponent(parts[1]),
        };
    } catch (e) {
        return null;
    }
}

function createProviderCard(provider, logo, defaultProviderId, index, options = {}) {
    const card = document.createElement('div');
    card.className = 'provider-card collapsed';
    const providerId = String(provider.id || `provider-${index + 1}`).trim();
    const isDefaultProvider = providerId === String(defaultProviderId || '').trim();
    const isEnabled = isProviderEnabled(provider);
    const isPreset = Boolean(options.isPreset);
    card.dataset.savedProviderId = provider.previous_id || providerId;
    card.dataset.liveProviderId = providerId;
    card.dataset.isPreset = isPreset ? 'true' : 'false';
    const radioId = `default-provider-${index}`;
    const displayName = String(provider.name || '').trim() || providerId;
    card.classList.toggle('is-default', isDefaultProvider);
    card.classList.toggle('is-disabled', !isEnabled);
    card.innerHTML = `
        <div class="provider-card-header">
            <label class="ios-switch provider-enable-switch" title="${isEnabled ? t('settings.providerDisable') : t('settings.providerEnable')}">
                <input type="checkbox" class="provider-enable-input" ${isEnabled ? 'checked' : ''} role="switch" aria-label="${t('settings.providerEnableLabel', { name: escapeHtml(displayName) })}">
                <span class="ios-slider"></span>
            </label>
            <button type="button" class="provider-collapse-btn" aria-expanded="false">
                <span class="provider-collapse-copy">
                    <img class="provider-logo" src="${escapeHtml(logo || '')}" alt="" width="20" height="20" draggable="false" decoding="async">
                    <span class="provider-collapse-text">
                        <span class="provider-title-row">
                            <span class="provider-card-name">${escapeHtml(displayName)}</span>
                            <span class="provider-default-badge">${t('settings.providerDefaultBadge')}</span>
                        </span>
                        <span class="provider-meta-row">
                            <span class="provider-card-subtitle">${escapeHtml(providerId)}</span>
                            <span class="provider-status-badge" data-state="" hidden></span>
                        </span>
                    </span>
                </span>
                <span class="material-symbols-rounded provider-collapse-icon">expand_more</span>
            </button>
            <div class="provider-card-actions">
                <button type="button" class="remove-provider-btn" title="${t('settings.providerDelete')}" aria-label="${t('settings.providerDelete')}">
                    <span class="material-symbols-rounded">delete</span>
                </button>
            </div>
        </div>
        <div class="provider-card-body">
            <div class="provider-default-row">
                <label class="provider-default-label" for="${radioId}" title="${t('settings.providerSetDefault')}">
                    <input type="radio" id="${radioId}" name="default-provider-radio" value="${escapeHtml(providerId)}" ${isDefaultProvider ? 'checked' : ''} ${isEnabled ? '' : 'disabled'}>
                    <span>${t('settings.providerSetDefault')}</span>
                </label>
            </div>
            <div class="provider-grid">
                <div class="form-group">
                    <label>Provider ID</label>
                    <input type="text" class="provider-id-input" value="${escapeHtml(providerId)}" placeholder="openai">
                </div>
                <div class="form-group">
                    <label>${t('settings.providerDisplayName')}</label>
                    <input type="text" class="provider-name-input" value="${escapeHtml(displayName)}" placeholder="OpenAI">
                </div>
            </div>
            <div class="form-group provider-key-group">
                <label>${t('settings.providerApiKey')}</label>
                <div class="provider-key-wrap">
                    <textarea rows="3" class="provider-api-key-input" spellcheck="false" placeholder="sk-..., sk-...">${escapeHtml(provider.api_key || '')}</textarea>
                    <span class="provider-key-check" aria-hidden="true">
                        <span class="material-symbols-rounded">check</span>
                    </span>
                </div>
            </div>
            <div class="form-group">
                <label>${t('settings.providerBaseUrl')}</label>
                <input type="text" class="provider-base-url-input" value="${escapeHtml(provider.base_url || '')}" placeholder="https://api.openai.com/v1">
                <p class="provider-base-url-warning" hidden></p>
            </div>
            <div class="form-group model-settings-group">
                <div class="model-panel-header">
                    <button type="button" class="model-panel-toggle" aria-expanded="false">
                        <span class="model-panel-title">${t('settings.modelList')}</span>
                        <span class="model-panel-summary"></span>
                        <span class="material-symbols-rounded model-panel-icon">expand_more</span>
                    </button>
                </div>
                <div class="model-list-container"></div>
                <div class="model-actions-row">
                    <button type="button" class="provider-manage-models-btn">
                        <span class="material-symbols-rounded">settings</span>
                        <span>${t('settings.manageModels')}</span>
                    </button>
                    <button type="button" class="add-model-btn provider-add-model-btn">
                        <span class="material-symbols-rounded">add</span>
                        <span>${t('settings.addModel')}</span>
                    </button>
                </div>
                <input type="hidden" class="provider-model-input" value="${escapeHtml(provider.model_id || '')}">
            </div>
            <div class="provider-test-row">
                <button type="button" class="provider-test-btn">
                    <span class="material-symbols-rounded">verified</span>
                    <span>${t('settings.testConnection')}</span>
                </button>
                <div class="provider-test-result" hidden role="status" aria-live="polite"></div>
            </div>
        </div>
    `;

    const idInput = card.querySelector('.provider-id-input');
    const radio = card.querySelector('input[name="default-provider-radio"]');
    idInput.addEventListener('input', () => {
        const previousProviderId = card.dataset.liveProviderId || card.dataset.savedProviderId || providerId;
        const nextProviderId = idInput.value.trim();
        if (nextProviderId) {
            card.dataset.liveProviderId = nextProviderId;
        }
        radio.value = nextProviderId;
        const displayNameValue = card.querySelector('.provider-name-input').value.trim() || nextProviderId;
        card.querySelector('.provider-card-name').textContent = displayNameValue;
        card.querySelector('.provider-card-subtitle').textContent = nextProviderId;
        updateProviderBadge(card);
        if (nextProviderId) {
            const providerIdMap = previousProviderId
                ? new Map([[previousProviderId, nextProviderId]])
                : null;
            refreshWorkflowStepModelOptions({ providerIdMap });
        }
        requestSettingsAutoSave();
    });
    card.querySelector('.provider-name-input').addEventListener('input', () => {
        const displayNameValue = card.querySelector('.provider-name-input').value.trim() || idInput.value.trim();
        card.querySelector('.provider-card-name').textContent = displayNameValue;
        updateProviderBadge(card);
        refreshWorkflowStepModelOptions();
        requestSettingsAutoSave();
    });

    const collapseBtn = card.querySelector('.provider-collapse-btn');
    const setCollapsed = (collapsed) => {
        card.classList.toggle('collapsed', collapsed);
        collapseBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        const icon = collapseBtn.querySelector('.provider-collapse-icon');
        if (icon) {
            icon.textContent = collapsed ? 'expand_more' : 'expand_less';
        }
    };
    collapseBtn.addEventListener('click', (event) => {
        setCollapsed(!card.classList.contains('collapsed'));
    });
    if (typeof options.collapsed === 'boolean') {
        setCollapsed(options.collapsed);
    } else if (providerId === defaultProviderId) {
        setCollapsed(false);
    }

    const enableInput = card.querySelector('.provider-enable-input');
    const setEnabled = (enabled) => {
        enableInput.checked = enabled;
        card.classList.toggle('is-disabled', !enabled);
        radio.disabled = !enabled;
        updateProviderBadge(card);
        updateProviderCountLabel(getEnabledProviderCount());
    };
    enableInput.addEventListener('change', () => {
        if (!enableInput.checked && radio.checked) {
            const nextRadio = Array.from(document.querySelectorAll('input[name="default-provider-radio"]'))
                .find(candidate => candidate !== radio && !candidate.disabled);
            if (nextRadio) {
                nextRadio.checked = true;
                syncDefaultProviderBadges();
            }
        }
        setEnabled(enableInput.checked);
        refreshWorkflowStepModelOptions();
        requestSettingsAutoSave({ immediate: true });
    });
    setEnabled(isEnabled);

    const apiKeyInput = card.querySelector('.provider-api-key-input');
    const keyWrap = card.querySelector('.provider-key-wrap');
    const applyKeyMask = () => {
        const hasValue = Boolean(apiKeyInput.value.trim());
        const focused = document.activeElement === apiKeyInput;
        apiKeyInput.classList.toggle('is-blurred', hasValue && !focused);
        keyWrap.classList.toggle('has-key', hasValue && !focused);
    };
    apiKeyInput.addEventListener('input', () => {
        updateProviderBadge(card);
        applyKeyMask();
        requestSettingsAutoSave();
    });
    apiKeyInput.addEventListener('focus', applyKeyMask);
    apiKeyInput.addEventListener('blur', applyKeyMask);

    const baseUrlInput = card.querySelector('.provider-base-url-input');
    baseUrlInput.addEventListener('input', () => {
        updateProviderBaseUrlWarning(card);
        updateProviderBadge(card);
        requestSettingsAutoSave();
    });

    radio.addEventListener('change', () => {
        syncDefaultProviderBadges();
        requestSettingsAutoSave({ immediate: true });
    });
    card.querySelector('.remove-provider-btn').addEventListener('click', async () => {
        const providerName = card.querySelector('.provider-card-name')?.textContent?.trim() || providerId;
        if (!(await showConfirm(t('settings.confirmDeleteProvider', { name: providerName }), t('settings.providerDelete')))) return;
        if (isPreset) {
            // 预置行：删除 = 禁用并重置为目录默认。
            const entry = getProviderCatalogEntry(providerId);
            card.querySelector('.provider-name-input').value = entry ? entry.label : displayName;
            card.querySelector('.provider-base-url-input').value = entry ? entry.baseUrl : '';
            card.querySelector('.provider-model-input').value = entry ? entry.models.join(', ') : '';
            if (card._providerModelListApi) {
                card._providerModelListApi.render();
            }
            if (enableInput.checked) {
                enableInput.checked = false;
                setEnabled(false);
            }
            updateProviderBaseUrlWarning(card);
            refreshWorkflowStepModelOptions();
            requestSettingsAutoSave({ immediate: true });
            return;
        }
        const currentDefaultProviderId = getSelectedDefaultProviderId();
        const providers = Array.from(document.querySelectorAll('.provider-card'))
            .filter(providerCard => providerCard !== card)
            .map(collectProviderCardForm)
            .filter(provider => provider.id || provider.base_url || provider.model_id || provider.api_key);
        const nextProviders = providers.length > 0 ? providers : [];
        const preferredDefaultId = radio.checked ? '' : currentDefaultProviderId;
        renderProviderList(
            nextProviders,
            resolveProviderDefaultId(nextProviders, preferredDefaultId),
            { preserveCollapsed: true },
        );
        requestSettingsAutoSave({ immediate: true });
    });
    card.querySelector('.provider-test-btn').addEventListener('click', runProviderConnectionTest);
    const manageModelsBtn = card.querySelector('.provider-manage-models-btn');
    manageModelsBtn.addEventListener('click', () => openModelManagerForCard(card));
    setupProviderModelList(card);
    updateProviderBaseUrlWarning(card);
    updateProviderBadge(card);
    return card;
}

function syncDefaultProviderBadges() {
    document.querySelectorAll('.provider-card').forEach((card) => {
        const radio = card.querySelector('input[name="default-provider-radio"]');
        card.classList.toggle('is-default', Boolean(radio?.checked));
    });
}

function setupProviderModelList(providerCard) {
    const container = providerCard.querySelector('.model-list-container');
    const addButton = providerCard.querySelector('.provider-add-model-btn');
    const hiddenInput = providerCard.querySelector('.provider-model-input');
    const modelGroup = providerCard.querySelector('.model-settings-group');
    const toggleButton = providerCard.querySelector('.model-panel-toggle');

    function render() {
        container.innerHTML = '';
        const items = getSupportedModelItems(hiddenInput.value);
        hiddenInput.value = items.join(', ');
        if (items.length === 0) {
            addModelRow('', '');
        } else {
            items.forEach(item => {
                const { modelId, displayName } = splitModelItem(item);
                addModelRow(
                    modelId,
                    displayName === modelId || displayName === (modelId.includes('/') ? modelId.split('/').pop() : modelId)
                        ? ''
                        : displayName,
                );
            });
        }
        updateModelPanelSummary(providerCard);
        updateProviderBadge(providerCard);
    }

    function serialize({ save = true } = {}) {
        hiddenInput.value = Array.from(container.querySelectorAll('.model-row'))
            .map(row => {
                const id = row.querySelector('.model-id-input').value.trim();
                const name = row.querySelector('.model-name-input').value.trim();
                if (!id) return '';
                return name ? `${id}::${name}` : id;
            })
            .filter(model => model && !isUnsupportedGemini25Model(model))
            .join(', ');
        updateModelPanelSummary(providerCard);
        updateProviderBadge(providerCard);
        refreshWorkflowStepModelOptions();
        if (save) {
            requestSettingsAutoSave();
        }
    }

    function addModelRow(id = '', name = '') {
        const row = document.createElement('div');
        row.className = 'model-row';
        row.innerHTML = `
            <input type="text" class="model-id-input" placeholder="${t('settings.modelIdPlaceholder')}" value="${escapeHtml(id)}">
            <input type="text" class="model-name-input" placeholder="${t('settings.modelNamePlaceholder')}" value="${escapeHtml(name)}">
            <button type="button" class="remove-model-btn" title="${t('settings.deleteModel')}">
                <span class="material-symbols-rounded">delete</span>
            </button>
        `;
        row.querySelector('.model-id-input').addEventListener('input', serialize);
        row.querySelector('.model-name-input').addEventListener('input', serialize);
        row.querySelector('.remove-model-btn').addEventListener('click', () => {
            row.remove();
            serialize();
            if (container.querySelectorAll('.model-row').length === 0) {
                addModelRow('', '');
            }
        });
        container.appendChild(row);
    }

    function setModelPanelCollapsed(collapsed) {
        modelGroup.classList.toggle('collapsed', collapsed);
        toggleButton.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        const icon = toggleButton.querySelector('.model-panel-icon');
        if (icon) {
            icon.textContent = collapsed ? 'expand_more' : 'expand_less';
        }
    }

    toggleButton.addEventListener('click', () => {
        setModelPanelCollapsed(!modelGroup.classList.contains('collapsed'));
    });

    addButton.addEventListener('click', () => {
        setModelPanelCollapsed(false);
        addModelRow('', '');
        serialize({ save: false });
    });
    render();
    setModelPanelCollapsed(true);

    // Expose for the model-manager modal so it can commit edits back to the card.
    providerCard._providerModelListApi = { render, serialize };
}

function openModelManagerForCard(providerCard) {
    const modal = document.getElementById('model-manager-modal');
    if (!modal) return;
    const hiddenInput = providerCard.querySelector('.provider-model-input');
    const listEl = document.getElementById('model-manager-list');
    const searchEl = document.getElementById('model-manager-search');
    const countEl = document.getElementById('model-manager-count');
    const batchEl = document.getElementById('model-manager-batch-input');
    const addBatchBtn = document.getElementById('model-manager-add-batch-btn');
    const messageEl = document.getElementById('model-manager-batch-message');
    const titleEl = document.getElementById('model-manager-title');
    if (!listEl || !searchEl || !countEl || !batchEl || !addBatchBtn || !messageEl) return;

    const providerName = providerCard.querySelector('.provider-card-name')?.textContent?.trim() || '';
    if (titleEl) titleEl.textContent = t('settings.modelManagerTitleFor', { name: providerName });

    searchEl.value = '';
    batchEl.value = '';
    messageEl.hidden = true;

    const readRows = () => getSupportedModelItems(hiddenInput.value).map((item) => {
        const { modelId, displayName } = splitModelItem(item);
        return { id: modelId, name: displayName === modelId ? '' : displayName };
    });

    const setBatchMessage = (text, isError = false) => {
        messageEl.textContent = text;
        messageEl.hidden = !text;
        messageEl.classList.toggle('is-error', isError);
    };

    const commitRows = (rows) => {
        hiddenInput.value = serializeModels(rows);
        if (providerCard._providerModelListApi) {
            providerCard._providerModelListApi.render();
        }
        updateModelPanelSummary(providerCard);
        renderManagerRows();
        requestSettingsAutoSave();
    };

    const renderManagerRows = () => {
        const query = searchEl.value.trim().toLowerCase();
        const rows = readRows();
        countEl.textContent = String(rows.length);
        listEl.innerHTML = '';
        const filtered = rows.filter((row) => !query
            || row.id.toLowerCase().includes(query)
            || (row.name || '').toLowerCase().includes(query));
        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'model-manager-empty';
            empty.textContent = t('settings.modelManagerEmpty');
            listEl.appendChild(empty);
            return;
        }
        filtered.forEach((row) => {
            const rowEl = document.createElement('div');
            rowEl.className = 'model-manager-row';
            rowEl.innerHTML = `
                <input type="text" class="model-manager-id-input" value="${escapeHtml(row.id)}" placeholder="${t('settings.modelIdPlaceholder')}">
                <input type="text" class="model-manager-name-input" value="${escapeHtml(row.name)}" placeholder="${t('settings.modelNamePlaceholder')}">
                <button type="button" class="remove-model-btn" title="${t('settings.deleteModel')}" aria-label="${t('settings.deleteModel')}">
                    <span class="material-symbols-rounded">delete</span>
                </button>
            `;
            const idInputEl = rowEl.querySelector('.model-manager-id-input');
            const nameInputEl = rowEl.querySelector('.model-manager-name-input');
            idInputEl.addEventListener('input', () => {
                const next = readRows();
                const match = next.find((r) => r.id === row.id);
                if (match) match.id = idInputEl.value;
                commitRows(next);
            });
            nameInputEl.addEventListener('input', () => {
                const next = readRows();
                const match = next.find((r) => r.id === row.id);
                if (match) match.name = nameInputEl.value;
                commitRows(next);
            });
            rowEl.querySelector('.remove-model-btn').addEventListener('click', () => {
                commitRows(readRows().filter((r) => r.id !== row.id));
            });
            listEl.appendChild(rowEl);
        });
    };

    addBatchBtn.onclick = () => {
        const incomingIds = parseModelListText(batchEl.value);
        if (incomingIds.length === 0) {
            setBatchMessage(t('settings.modelManagerPasteFirst'), true);
            return;
        }
        const currentRows = readRows();
        const merged = mergeModelOptions(currentRows, incomingIds.map((id) => ({ id, name: '' })));
        const addedCount = merged.length - currentRows.length;
        commitRows(merged);
        batchEl.value = '';
        setBatchMessage(addedCount > 0
            ? t('settings.modelManagerAddedCount', { count: addedCount })
            : t('settings.modelManagerNoNew'));
    };

    searchEl.oninput = renderManagerRows;

    const closeManager = () => {
        modal.classList.remove('active');
        if (providerCard._providerModelListApi) {
            providerCard._providerModelListApi.render();
        }
    };
    const closeBtn = modal.querySelector('.model-manager-close-btn');
    if (closeBtn) closeBtn.onclick = closeManager;
    modal.onclick = (event) => {
        if (event.target === modal) closeManager();
    };

    renderManagerRows();
    modal.classList.add('active');
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => searchEl.focus());
    } else {
        searchEl.focus();
    }
}

function updateProviderBadge(providerCard) {
    const badge = providerCard?.querySelector('.provider-status-badge');
    if (!badge) return;
    const enabled = providerCard.querySelector('.provider-enable-input')?.checked;
    const hasKey = Boolean(providerCard.querySelector('.provider-api-key-input')?.value.trim());
    if (!enabled) {
        badge.hidden = true;
        badge.dataset.state = '';
        badge.textContent = '';
        return;
    }
    badge.hidden = false;
    badge.dataset.state = hasKey ? 'ready' : 'missing';
    badge.textContent = hasKey ? t('settings.keyReady') : t('settings.keyMissing');
}

function updateProviderBaseUrlWarning(providerCard) {
    const warningEl = providerCard?.querySelector('.provider-base-url-warning');
    const input = providerCard?.querySelector('.provider-base-url-input');
    if (!warningEl || !input) return;
    const message = getBaseUrlWarning(input.value);
    warningEl.textContent = message;
    warningEl.hidden = !message;
    providerCard.classList.toggle('has-base-url-warning', Boolean(message));
}

function updateModelPanelSummary(providerCard) {
    const summaryEl = providerCard.querySelector('.model-panel-summary');
    if (!summaryEl) return;
    const hiddenInput = providerCard.querySelector('.provider-model-input');
    const items = getSupportedModelItems(hiddenInput?.value || '');
    if (items.length === 0) {
        summaryEl.textContent = t('settings.modelCountZero');
        return;
    }
    const first = getModelDisplayName(items[0]);
    summaryEl.textContent = t('settings.modelCountSummary', { first, count: items.length });
}

function collectProvidersForm() {
    return Array.from(document.querySelectorAll('.provider-card'))
        .map(collectProviderCardForm)
        .filter(provider => provider.id || provider.base_url || provider.model_id || provider.api_key);
}

function collectProviderCardForm(card) {
    const providerId = card.querySelector('.provider-id-input').value.trim();
    return {
        id: providerId,
        previous_id: card.dataset.savedProviderId || providerId,
        name: card.querySelector('.provider-name-input').value.trim(),
        api_key: card.querySelector('.provider-api-key-input').value.trim(),
        base_url: card.querySelector('.provider-base-url-input').value.trim(),
        model_id: card.querySelector('.provider-model-input').value.trim(),
        enabled: card.querySelector('.provider-enable-input')?.checked ?? true,
    };
}

function markSavedProviderIdentities() {
    document.querySelectorAll('.provider-card').forEach((card) => {
        const providerId = card.querySelector('.provider-id-input')?.value.trim() || '';
        if (providerId) {
            card.dataset.savedProviderId = providerId;
            card.dataset.liveProviderId = providerId;
        }
    });
}

function createEmptyProvider() {
    const existingIds = new Set(collectProvidersForm().map(provider => String(provider.id || '').trim()));
    let n = 1;
    while (existingIds.has(`provider-${n}`)) n += 1;
    return {
        id: `provider-${n}`,
        name: `Provider ${n}`,
        api_key: '',
        base_url: '',
        model_id: '',
    };
}

function escapeHtml(str) {
    const value = String(str ?? '');
    if (!value) return '';
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

export const __settingsModalTestHooks = {
    buildDisplayProviderRows,
    collectSettingsForm,
    collectProvidersForm,
    collectWorkflowStepModels,
    createEmptyProvider,
    fillSettingsForm,
    getBaseUrlWarning,
    isProviderEnabled,
    normalizeNumberSetting,
    openModelManagerForCard,
    renderEngineCheckResults,
    renderProviderList,
    renderWorkflowStepModels,
    safeGetLocalStorageItem,
    safeSetLocalStorageItem,
    validateSettingsForm,
};
