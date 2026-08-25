import { initializeAuth, normalizeSettings } from './modules/auth.js?v=1';
import { initI18n, applyI18n } from './modules/i18n.js?v=1';
import { state, setCurrentSessionId, setLiveArtifactsMode } from './modules/state.js?v=5';
import { initUI, elements, resetChatDomToHero } from './modules/ui.js?v=43';
import { detachCurrentStream, setupChatHandler, syncQuickSettingsFromState } from './modules/chat.js?v=56';
import { openHistorySearch, renderHistory, setupHistoryGroups, setupHistorySearch, updateActiveHistoryItem } from './modules/history-view.js?v=28';
import { initEvidencePanel } from './modules/evidence-panel.js?v=5';
import { setupSidebar, toggleSidebarFromShortcut } from './modules/sidebar.js?v=25';
// 重块按需加载（对齐 AMC vite/chunks.ts HEAVY_PRELOAD_PATTERNS）：settings-modal、live-artifacts 延迟到首次使用
let _settingsModalCache = null;
async function getSettingsModal() {
    if (_settingsModalCache) return _settingsModalCache;
    _settingsModalCache = await import('./modules/settings-modal.js?v=60');
    return _settingsModalCache;
}
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
    // 懒加载设置弹窗（对齐 AMC  settings-options 懒块）：首屏不解析 73KB settings-modal
    let refreshSettingsForm = null;
    const { setupSettingsModal: setupModalFn } = await getSettingsModal();
    ({ refreshSettingsForm } = setupModalFn({
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
    }));
    // 预热 LiveArtifacts 块（空闲时），但不阻塞首屏
    // 注意：当前 ui.js 静态 import 了 live-artifacts.js（main.js 又静态依赖 ui.js），
    // 走到这里时该模块早已随首屏加载，下面的动态 import 只是缓存命中——
    // 在解除这条静态依赖链之前，此预热实际是空操作，待未来重构后才会真正生效。
    if ('requestIdleCallback' in window) {
        requestIdleCallback(() => import('./modules/live-artifacts.js?v=53').catch(()=>{}), { timeout: 3000 });
    } else {
        setTimeout(() => import('./modules/live-artifacts.js?v=53').catch(()=>{}), 2000);
    }
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
    resetChatDomToHero();
    updateActiveHistoryItem(null);
}

function setupSystemThemeListener() {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if ((state.settings.theme || 'light') === 'auto') {
            import('./modules/utils.js?v=14').then(m => m.applyTheme('auto'));
        }
    });
    // AMC对齐：跨标签设置同步
    try {
        if (typeof BroadcastChannel !== 'undefined') {
            const bc = new BroadcastChannel('justsearch_settings');
            bc.onmessage = (event) => {
                if (event.data?.type === 'SETTINGS_UPDATED' && event.data.theme) {
                    import('./modules/utils.js?v=14').then(m => m.applyTheme(event.data.theme)).catch(()=>{});
                }
            };
            // 系统主题为 auto 时，同步 OS 暗色变化
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
                const cur = localStorage.getItem('justsearch_theme') || 'auto';
                if (cur === 'auto') {
                    try { bc.postMessage({ type: 'SETTINGS_UPDATED', theme: 'auto' }); } catch {}
                }
            });
        }
    } catch {}
}

function setupPwaInstallPrompt() {
    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
    });
    // AMC对齐：注册 Service Worker（轻量缓存静态资源）
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/static/sw.js').catch(()=>{});
        });
    }
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
