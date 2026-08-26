import { state, setCurrentSessionId } from './state.js?v=5';
import { elements, resetChatDomToHero } from './ui.js?v=43';
import { updateActiveHistoryItem, getCachedHistory, openHistorySearch } from './history-view.js?v=28';
import { detachCurrentStream } from './chat.js?v=56';
import { t } from './i18n.js?v=1';
import { encodePathSegment, safeGetLocalStorageItem, safeSetLocalStorageItem } from './utils.js?v=14';

let popoverEl = null;
let popoverTimeout = null;
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'sidebarCollapsed';
const DESKTOP_BP = 768;
const SIDEBAR_COLLAPSED_KEYS = {
    desktop: 'sidebarCollapsed_desktop',
    mobile: 'sidebarCollapsed_mobile',
    legacy: 'sidebarCollapsed',
};
function isDesktopViewport() {
    return typeof window !== 'undefined' ? window.innerWidth > DESKTOP_BP : true;
}
function getSidebarCollapsedForViewport() {
    const desktop = isDesktopViewport();
    const key = desktop ? SIDEBAR_COLLAPSED_KEYS.desktop : SIDEBAR_COLLAPSED_KEYS.mobile;
    let val = safeGetLocalStorageItem(key);
    if (val === '' && desktop) {
        // Migrate legacy single key to desktop
        const legacy = safeGetLocalStorageItem(SIDEBAR_COLLAPSED_KEYS.legacy);
        if (legacy !== '') {
            val = legacy;
            safeSetLocalStorageItem(key, legacy);
            try { localStorage.removeItem(SIDEBAR_COLLAPSED_KEYS.legacy); } catch {}
        }
    }
    return val === 'true';
}
function setSidebarCollapsedForViewport(collapsed) {
    const key = isDesktopViewport() ? SIDEBAR_COLLAPSED_KEYS.desktop : SIDEBAR_COLLAPSED_KEYS.mobile;
    safeSetLocalStorageItem(key, collapsed ? 'true' : 'false');
}

function removeRecentChatsPopover() {
    if (popoverEl) {
        popoverEl.remove();
        popoverEl = null;
    }
}

function setupHistoryPopover(miniHistoryBtn, loadChat) {
    const showPopover = () => {
        if (popoverTimeout) clearTimeout(popoverTimeout);
        if (popoverEl) return;
        
        const allHistory = getCachedHistory() || [];
        const activeSessionId = state.currentSessionId;
        const recentChats = allHistory
            .filter(chat => chat.id !== activeSessionId)
            .slice(0, 8);
            
        popoverEl = document.createElement('div');
        popoverEl.className = 'recent-chats-popover';
        
        const header = document.createElement('div');
        header.className = 'popover-header';
        header.textContent = t('sidebar.miniRecent');
        popoverEl.appendChild(header);

        const list = document.createElement('div');
        list.className = 'popover-list';

        if (recentChats.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'popover-empty';
            empty.textContent = t('sidebar.noRecentChats');
            list.appendChild(empty);
        } else {
            recentChats.forEach(chat => {
                const item = document.createElement('a');
                item.className = 'popover-item';
                item.href = `/c/${encodePathSegment(chat.id)}`;
                item.textContent = chat.title || t('history.newChat');
                item.title = chat.title || t('history.newChat');
                item.addEventListener('click', (e) => {
                    e.preventDefault();
                    if (typeof loadChat === 'function') {
                        loadChat(chat.id);
                    }
                    removePopover();
                });
                list.appendChild(item);
            });
        }
        popoverEl.appendChild(list);
        
        document.body.appendChild(popoverEl);
        
        const rect = miniHistoryBtn.getBoundingClientRect();
        popoverEl.style.top = `${rect.top}px`;
        popoverEl.style.left = `${rect.right + 8}px`;
        
        // Add events to popover itself so hovering keeps it open
        popoverEl.addEventListener('mouseenter', () => {
            if (popoverTimeout) clearTimeout(popoverTimeout);
        });
        popoverEl.addEventListener('mouseleave', () => {
            startHideTimeout();
        });
    };
    
    const removePopover = () => {
        removeRecentChatsPopover();
    };
    
    const startHideTimeout = () => {
        if (popoverTimeout) clearTimeout(popoverTimeout);
        popoverTimeout = setTimeout(() => {
            removePopover();
        }, 300);
    };
    
    miniHistoryBtn.addEventListener('mouseenter', () => {
        if (popoverTimeout) clearTimeout(popoverTimeout);
        popoverTimeout = setTimeout(showPopover, 150);
    });
    
    miniHistoryBtn.addEventListener('mouseleave', () => {
        startHideTimeout();
    });
    
    miniHistoryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (popoverEl) {
            removePopover();
        } else {
            showPopover();
        }
    });
    
    document.addEventListener('click', (e) => {
        if (popoverEl && !popoverEl.contains(e.target) && e.target !== miniHistoryBtn) {
            removePopover();
        }
    });
}

export function setupSidebar(loadChat) {
    if (isDesktopViewport()) {
        if (getSidebarCollapsedForViewport()) {
            elements.sidebar.classList.add('collapsed');
        }
    }

    const toggleSidebar = () => {
        removeRecentChatsPopover();
        if (!isDesktopViewport()) {
            elements.sidebar.classList.add('mobile-open');
            elements.mobileOverlay.classList.add('active');
        } else {
            elements.sidebar.classList.toggle('collapsed');
            setSidebarCollapsedForViewport(elements.sidebar.classList.contains('collapsed'));
        }
    };

    elements.expandSidebarBtn?.addEventListener('click', toggleSidebar);
    elements.collapseSidebarBtn?.addEventListener('click', toggleSidebar);

    const sidebarBrandToggle = document.getElementById('sidebar-brand-toggle');
    sidebarBrandToggle?.addEventListener('click', toggleSidebar);
    sidebarBrandToggle?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleSidebar();
        }
    });
    
    const miniToggleBtn = document.getElementById('mini-toggle-btn');
    miniToggleBtn?.addEventListener('click', toggleSidebar);

    // Expand when clicking empty space on collapsed pane (except on buttons)
    const collapsedPane = document.querySelector('.sidebar-collapsed-pane');
    if (collapsedPane) {
        collapsedPane.addEventListener('click', (e) => {
            if (elements.sidebar.classList.contains('collapsed')) {
                toggleSidebar();
            }
        });
        
        // Prevent button clicks in collapsed pane from propagating to the pane click handler
        collapsedPane.querySelectorAll('button, a, input').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        });
    }

    // Collapse when clicking empty space on history list (expanded pane)
    if (elements.historyList) {
        elements.historyList.addEventListener('click', (e) => {
            if (!elements.sidebar.classList.contains('collapsed') && e.target === e.currentTarget) {
                toggleSidebar();
            }
        });
    }

    elements.closeSidebarBtn.addEventListener('click', closeMobileSidebar);
    elements.mobileOverlay.addEventListener('click', closeMobileSidebar);

    // Mirror AMC uiStore.syncHistorySidebarForViewport(): isHistorySidebarOpen = isDesktop()? desktopOpen : mobileOpen
    const syncSidebarForViewport = () => {
        const isDesktop = isDesktopViewport();
        if (isDesktop) {
            closeMobileSidebar();
            const collapsed = getSidebarCollapsedForViewport();
            elements.sidebar.classList.toggle('collapsed', collapsed);
        } else {
            // On mobile, collapsed pane is not used — remove desktop collapsed to avoid leaking state
            // Mobile persistence is via mobile key (isolated), but overlay handles visibility
            elements.sidebar.classList.remove('collapsed');
        }
    };

    const resizeHandler = () => {
        syncSidebarForViewport();
    };
    window.addEventListener('resize', resizeHandler);

    const themeBtn = document.getElementById('quick-theme-btn');
    if (themeBtn) {
        const updateThemeIcon = () => {
            const theme = document.documentElement.getAttribute('data-theme');
            const isDarkLike = theme === 'dark' || theme === 'graphite';
            themeBtn.title = isDarkLike ? t('sidebar.switchToLight') : t('sidebar.switchToDark');
            if (isDarkLike) {
                // Sun Icon (switching to light mode) — for dark/graphite
                themeBtn.innerHTML = `<svg class="icon-svg" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="m6.34 17.66-1.41 1.41"></path><path d="m19.07 4.93-1.41 1.41"></path></svg>`;
            } else {
                // Moon Icon (switching to dark mode) — for light
                themeBtn.innerHTML = `<svg class="icon-svg" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path></svg>`;
            }
        };

        // Initial setup
        setTimeout(updateThemeIcon, 100);

        // Update when HTML attribute data-theme changes
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.attributeName === 'data-theme') {
                    updateThemeIcon();
                }
            });
        });
        observer.observe(document.documentElement, { attributes: true });

        themeBtn.addEventListener('click', async () => {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            // P0: cycle light → dark → graphite → light (AMC pearl/onyx/graphite)，auto 不经快捷键设置
            const order = ['light', 'dark', 'graphite'];
            const idx = order.indexOf(currentTheme);
            const newTheme = order[(idx + 1) % order.length] || 'light';

            const { applyTheme } = await import('./utils.js?v=14');
            applyTheme(newTheme);
            updateThemeIcon();

            const { saveSettingsAPI } = await import('./api.js?v=14');
            const { state } = await import('./state.js?v=5');
            if (state.settings) {
                const newSettings = { ...state.settings, theme: newTheme };
                await saveSettingsAPI(newSettings);
                const { setSegmentedValue } = await import('./settings-segmented.js?v=1');
                setSegmentedValue('theme', newTheme, { silent: true });
            }
        });
    }

    elements.newChatBtn.addEventListener('click', resetToNewChat);
    
    const miniNewChatBtn = document.getElementById('mini-new-chat-btn');
    miniNewChatBtn?.addEventListener('click', resetToNewChat);

    const miniSearchBtn = document.getElementById('mini-search-btn');
    miniSearchBtn?.addEventListener('click', () => {
        if (elements.sidebar.classList.contains('collapsed')) {
            elements.sidebar.classList.remove('collapsed');
            setSidebarCollapsedForViewport(false);
        }
        setTimeout(() => {
            openHistorySearch();
        }, 300);
    });

    const miniHistoryBtn = document.getElementById('mini-history-btn');
    if (miniHistoryBtn) {
        setupHistoryPopover(miniHistoryBtn, loadChat);
    }
}

export function closeMobileSidebar() {
    removeRecentChatsPopover();
    elements.sidebar.classList.remove('mobile-open');
    elements.mobileOverlay.classList.remove('active');
}

export function toggleSidebarFromShortcut() {
    removeRecentChatsPopover();
    if (!isDesktopViewport()) {
        elements.sidebar.classList.toggle('mobile-open');
        elements.mobileOverlay.classList.toggle('active');
    } else {
        elements.sidebar.classList.toggle('collapsed');
        setSidebarCollapsedForViewport(elements.sidebar.classList.contains('collapsed'));
    }
}

function resetToNewChat() {
    removeRecentChatsPopover();
    // Keep any in-flight stream running in the background (switch-away, not abort).
    detachCurrentStream(elements);
    setCurrentSessionId(null);
    resetChatDomToHero();
    updateActiveHistoryItem(null);
    elements.userInput.value = '';
    elements.userInput.style.height = '26px';
    elements.userInput.style.overflowY = 'hidden';
    elements.userInput.focus();

    if (window.location.pathname !== '/') {
        window.history.pushState(null, '', '/');
    }
}

export const __sidebarTestHooks = {
    safeGetLocalStorageItem,
    safeSetLocalStorageItem,
};
