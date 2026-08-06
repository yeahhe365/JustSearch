import { initializeAuth, normalizeSettings } from './modules/auth.js?v=1';
import { initI18n, applyI18n } from './modules/i18n.js?v=1';
import { state, setCurrentSessionId, setLiveArtifactsMode } from './modules/state.js?v=5';
import { initUI, elements } from './modules/ui.js?v=40';
import { detachCurrentStream, setupChatHandler, syncQuickSettingsFromState } from './modules/chat.js?v=52';
import { initEvidencePanel } from './modules/evidence-panel.js?v=5';
import { openHistorySearch, renderHistory, setupHistoryGroups, setupHistorySearch, updateActiveHistoryItem } from './modules/history-view.js?v=25';
import { setupSettingsModal } from './modules/settings-modal.js?v=56';
import { setupShortcutsHelp } from './modules/shortcuts-help.js?v=2';
import { setupSidebar, toggleSidebarFromShortcut } from './modules/sidebar.js?v=21';
import {
    findOptionForModelPreference,
    initCustomModelSelect,
    loadSelectedModelPreference,
    syncCustomModelSelect,
} from './modules/model-selector.js?v=16';
import { getSupportedModelItems, splitModelItem } from './modules/provider-models.js?v=1';
import { isProviderEnabled } from './modules/provider-catalog.js?v=2';
import { updateIntensityUI } from './modules/search-intensity.js?v=3';
import * as API from './modules/api.js?v=14';
import { applyBridgePreferencesFromSettings, startBridgeStatusPolling } from './modules/bridge.js?v=9';

document.addEventListener('DOMContentLoaded', async () => {
    // Language resolves synchronously from localStorage — apply before anything
    // renders so the UI never flashes in the wrong language.
    initI18n();
    applyI18n();
    initUI();
    initEvidencePanel();
    initializeAuth();
    initCustomModelSelect();
    startBridgeStatusPolling();

    // 三个 API 并行拉取(原来是 settings 先 await 完才拉 history/groups,白白串行一次 RTT)。
    const [settingsRes, chatHistory, chatGroups] = await Promise.all([
        API.fetchSettings(),
        API.fetchHistory(),
        API.fetchChatGroups(),
    ]);
    const settings = normalizeSettings(settingsRes);
    setLiveArtifactsMode(settings.live_artifacts_mode);
    applyBridgePreferencesFromSettings();
    updateModelSelector(settings);
    const { loadChat, deleteChat, rerenderCurrentView } = setupChatHandler(elements, renderHistory);
    const historyCallbacks = { onSelect: loadChat, onDelete: deleteChat };

    renderHistory(chatHistory, state.currentSessionId, historyCallbacks, chatGroups);
    restoreSessionFromUrl(chatHistory, loadChat);

    window.addEventListener('popstate', (event) => {
        if (event.state && event.state.sessionId) {
            loadChat(event.state.sessionId);
        } else {
            showHomeState();
        }
    });

    setupSidebar(loadChat);
    setupShortcutsHelp();
    const { refreshSettingsForm } = setupSettingsModal({
        updateModelSelector,
        historyCallbacks,
        onSettingsSaved: () => {
            syncQuickSettingsFromState();
            applyBridgePreferencesFromSettings();
        },
        onLanguageChanged: () => {
            applyI18n();
            renderHistory(chatHistory, state.currentSessionId, historyCallbacks, chatGroups);
            rerenderCurrentView();
            if (typeof refreshSettingsForm === 'function') refreshSettingsForm();
            updateIntensityUI({
                maxResults: state.settings.max_results,
                maxIterations: state.settings.max_iterations,
                disabled: Boolean(state.isProcessing),
            });
        },
    });
    setupHistoryGroups(historyCallbacks);
    setupHistorySearch(historyCallbacks);
    setupSystemThemeListener();
    setupPwaInstallPrompt();
    setupKeyboardShortcuts();
    setupContextMenuSuppression();
});

function updateModelSelector(settings) {
    const select = document.getElementById('model-select');
    if (!select) return;

    const selectedOption = select.options[select.selectedIndex];
    const currentKey = selectedOption
        ? `${selectedOption.dataset.providerId || ''}:${selectedOption.value}`
        : '';
    select.innerHTML = '';

    const providers = Array.isArray(settings?.providers) ? settings.providers : [];
    if (providers.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Default';
        option.dataset.providerId = '';
        select.appendChild(option);
        syncCustomModelSelect();
        return;
    }

    providers.forEach(provider => {
        const providerId = String(provider.id || '').trim();
        if (!providerId || !isProviderEnabled(provider)) return;

        const models = getSupportedModelItems(provider.model_id);
        models.forEach(model => {
            const option = document.createElement('option');
            const { modelId: val, displayName } = splitModelItem(model);
            if (!val) return;
            option.value = val;
            option.textContent = `${displayName} · ${provider.name || providerId}`;
            option.title = `${providerId} / ${val}`;
            option.dataset.providerId = providerId;
            option.dataset.providerName = provider.name || providerId;
            option.dataset.modelDisplayName = displayName;
            select.appendChild(option);
        });
    });

    const preferredProviderId = settings?.default_provider_id || providers[0]?.id || '';
    // 优先：当前已选（设置保存重建列表时）→ 上次用户选择（localStorage）→ 默认 Provider 下第一个 → 列表第一项
    let selected = Array.from(select.options).find(
        option => `${option.dataset.providerId || ''}:${option.value}` === currentKey
    );
    if (!selected) {
        selected = findOptionForModelPreference(select.options, loadSelectedModelPreference());
    }
    if (!selected) {
        selected = Array.from(select.options).find(
            option => option.dataset.providerId === preferredProviderId
        );
    }
    if (selected) {
        selected.selected = true;
    } else if (select.options.length > 0) {
        select.options[0].selected = true;
    }
    syncCustomModelSelect();
}


function restoreSessionFromUrl(chatHistory, loadChat) {
    const pathMatch = window.location.pathname.match(/^\/c\/([^/?#]+)\/?$/);
    if (!pathMatch) return;

    let urlSessionId = '';
    try {
        urlSessionId = decodeURIComponent(pathMatch[1]);
    } catch (e) {
        window.history.replaceState(null, '', '/');
        return;
    }
    const exists = chatHistory.some(h => h.id === urlSessionId);
    if (exists) {
        loadChat(urlSessionId);
    } else {
        window.history.replaceState(null, '', '/');
    }
}

function showHomeState() {
    detachCurrentStream(elements);
    setCurrentSessionId(null);
    elements.chatContainer.innerHTML = '';
    elements.heroSection.style.display = 'block';
    elements.chatContainer.appendChild(elements.heroSection);
    updateActiveHistoryItem(null);
}

function setupSystemThemeListener() {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if ((state.settings.theme || 'light') === 'auto') {
            import('./modules/utils.js?v=13').then(m => m.applyTheme('auto'));
        }
    });
}

function setupPwaInstallPrompt() {
    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
    });
}

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            const activeModals = document.querySelectorAll('.modal.active');
            const activeModal = activeModals[activeModals.length - 1];
            if (activeModal) {
                activeModal.classList.remove('active');
            }
        }

        if ((event.ctrlKey || event.metaKey) && event.key === 'n') {
            event.preventDefault();
            elements.newChatBtn.click();
        }

        if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
            event.preventDefault();
            openHistorySearch();
        }

        if ((event.ctrlKey || event.metaKey) && event.key === '/') {
            event.preventDefault();
            toggleSidebarFromShortcut();
        }
    });
}

function setupContextMenuSuppression() {
    document.addEventListener('contextmenu', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;

        if (target.closest('input, textarea, select, [contenteditable="true"]')) {
            return;
        }

        if (target.closest('.hero-header, .hero-brand-logo, .hero-container, #main, #sidebar, #mobile-overlay, .modal')) {
            event.preventDefault();
        }
    }, { capture: true });
}
