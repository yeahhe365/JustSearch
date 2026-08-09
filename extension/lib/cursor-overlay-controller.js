// 光标叠加层控制器:管理多 session 光标状态,活跃标签页观察,idle-hide,发布状态。
// 仿 browser-control-bridge 的 src/background/cursorOverlayController.ts。

import { ensureContentScript, sendTabMessageWithTimeout } from "./runtime-messaging.js";

// 当最后一个请求完成但 session 还在 running,等待这个时长后隐藏光标。
// 短暂的宽限期吸收连续 tool call 之间的间隙(模型思考),避免光标闪烁。
const CURSOR_IDLE_HIDE_DELAY_MS = 2000;

const EMPTY_CURSOR_OVERLAY_STATE = {
  cursor: null,
  isVisible: false,
  sessionId: null,
  turnId: null,
};

export class CursorOverlayController {
  constructor(onBrowserControlActivityChanged = () => {}) {
    this.sessions = new Map();
    this.tabSessions = new Map();
    this.activeTabIds = new Set();
    this.listenersRegistered = false;
    this.lastBrowserControlActive = false;
    this.onBrowserControlActivityChanged = onBrowserControlActivityChanged;
    this.registerObservationListeners();
    void this.refreshActiveTabs();
  }

  setBrowserControlActivityChangeHandler(handler) {
    this.onBrowserControlActivityChanged = handler;
    this.updateBrowserControlActivity();
  }

  isBrowserControlActive() {
    for (const session of this.sessions.values()) {
      if (session.isRunning || session.activeRequests > 0) return true;
    }
    return false;
  }

  async startSession(sessionId, turnId, options = {}) {
    const session = this.ensureSession(sessionId);
    if (turnId != null && session.currentTurnId !== turnId) {
      session.cursorByTabId.clear();
    }
    session.currentTurnId = turnId ?? session.currentTurnId;
    session.isRunning = true;
    this.clearIdleHideTimer(session);
    if (options.publishTabs !== false) await this.publishTabs(session.tabIds);
    this.updateBrowserControlActivity();
  }

  async incrementActiveRequests(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.clearIdleHideTimer(session);
    session.activeRequests++;
    this.updateBrowserControlActivity();
  }

  async decrementActiveRequests(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.activeRequests > 0) {
      session.activeRequests--;
    }
    if (session.activeRequests === 0 && session.isRunning) {
      this.scheduleIdleHide(sessionId, session);
    }
    this.updateBrowserControlActivity();
  }

  scheduleIdleHide(sessionId, session) {
    this.clearIdleHideTimer(session);
    session.idleHideTimer = setTimeout(() => {
      const current = this.sessions.get(sessionId);
      if (current && current.activeRequests === 0 && current.isRunning) {
        void this.stopSession(sessionId);
      }
    }, CURSOR_IDLE_HIDE_DELAY_MS);
  }

  clearIdleHideTimer(session) {
    if (session.idleHideTimer != null) {
      clearTimeout(session.idleHideTimer);
      session.idleHideTimer = null;
    }
  }

  async stopSessions(sessionIds) {
    for (const sessionId of sessionIds) await this.stopSession(sessionId);
  }

  async stopActiveSessions() {
    const active = Array.from(this.sessions.entries())
      .filter(([, session]) => session.isRunning)
      .map(([sessionId]) => sessionId);
    await this.stopSessions(active);
    return active;
  }

  async stopSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session?.isRunning) return;
    this.clearIdleHideTimer(session);
    session.isRunning = false;
    session.abortController?.abort();
    await this.publishTabs(session.tabIds);
    this.updateBrowserControlActivity();
  }

  async trackTab(sessionId, tabId, options = {}) {
    this.linkTabToSession(sessionId, tabId);
    if (options.publish !== false) await this.publishTabState(tabId);
  }

  async untrackTab(sessionId, tabId) {
    const session = this.sessions.get(sessionId);
    session?.tabIds.delete(tabId);
    session?.cursorByTabId.delete(tabId);
    if (session) this.clearIdleHideTimer(session);

    await this.publishTabState(tabId);

    if (session?.tabIds.size === 0) this.sessions.delete(sessionId);

    const tabSessionIds = this.tabSessions.get(tabId);
    if (tabSessionIds) {
      tabSessionIds.delete(sessionId);
      if (tabSessionIds.size === 0) this.tabSessions.delete(tabId);
    }

    this.updateBrowserControlActivity();
  }

  async setCursorState(sessionId, tabId, turnId, cursor, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session?.isRunning) return false;
    session.currentTurnId = turnId;
    session.cursorByTabId.set(tabId, cursor);
    if (options.publish === false) return false;
    return this.publishTabCursorState(tabId);
  }

  readCursorOverlayState(tabId) {
    const sessionId = this.getHighestPrioritySessionIdForTab(tabId);
    if (sessionId == null) return EMPTY_CURSOR_OVERLAY_STATE;
    const session = this.sessions.get(sessionId);
    if (!session?.isRunning) return EMPTY_CURSOR_OVERLAY_STATE;

    const cursor = session.cursorByTabId.get(tabId) ?? null;
    const visibleTab = this.isObserved(tabId);
    return {
      cursor: !visibleTab && cursor != null ? { ...cursor, visible: false } : cursor,
      isVisible: visibleTab,
      sessionId,
      turnId: session.currentTurnId,
    };
  }

  isObserved(tabId) {
    return this.activeTabIds.has(tabId);
  }

  ensureSession(sessionId) {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        tabIds: new Set(),
        isRunning: false,
        currentTurnId: null,
        cursorByTabId: new Map(),
        activeRequests: 0,
        abortController: null,
        idleHideTimer: null,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  linkTabToSession(sessionId, tabId) {
    const session = this.ensureSession(sessionId);
    session.tabIds.add(tabId);
    const tabSessionIds = this.tabSessions.get(tabId) ?? new Set();
    tabSessionIds.add(sessionId);
    this.tabSessions.set(tabId, tabSessionIds);
    return session;
  }

  async publishTabs(tabIds) {
    await Promise.all(Array.from(tabIds, (tabId) => this.publishTabState(tabId)));
  }

  async publishTabState(tabId) {
    return this.publishTabCursorState(tabId);
  }

  async publishTabCursorState(tabId, options = {}) {
    const state = this.readCursorOverlayState(tabId);
    const critical = options.critical ?? state === EMPTY_CURSOR_OVERLAY_STATE;
    if (!critical && !(await this.prepareContentScript(tabId))) {
      return false;
    }
    try {
      const response = await sendTabMessageWithTimeout(tabId, {
        type: "AGENT_CURSOR_STATE",
        state,
      });
      return response?.ok === true;
    } catch {
      return false;
    }
  }

  prepareContentScript(tabId) {
    return this.tabSessions.has(tabId) ? ensureContentScript(tabId) : Promise.resolve(false);
  }

  getHighestPrioritySessionIdForTab(tabId) {
    const sessionIds = this.tabSessions.get(tabId);
    if (!sessionIds || sessionIds.size === 0) return null;
    for (const sessionId of sessionIds) {
      if (this.sessions.get(sessionId)?.isRunning) return sessionId;
    }
    return null;
  }

  updateBrowserControlActivity() {
    const active = this.isBrowserControlActive();
    if (active === this.lastBrowserControlActive) return;
    this.lastBrowserControlActive = active;
    this.onBrowserControlActivityChanged(active);
  }

  untrackTabGlobally(tabId) {
    const sessionIds = this.tabSessions.get(tabId);
    if (sessionIds) {
      for (const sessionId of sessionIds) {
        const session = this.sessions.get(sessionId);
        session?.tabIds.delete(tabId);
        session?.cursorByTabId.delete(tabId);
        if (session) this.clearIdleHideTimer(session);
        if (session?.tabIds.size === 0) {
          this.sessions.delete(sessionId);
        }
      }
      this.tabSessions.delete(tabId);
    }
    this.updateBrowserControlActivity();
  }

  registerObservationListeners() {
    if (this.listenersRegistered) return;
    this.listenersRegistered = true;
    chrome.tabs.onActivated?.addListener(() => {
      void this.refreshActiveTabs();
    });
    chrome.tabs.onCreated?.addListener((tab) => {
      if (tab.active) void this.refreshActiveTabs();
    });
    chrome.tabs.onRemoved?.addListener((tabId) => {
      void this.refreshActiveTabs();
      this.untrackTabGlobally(tabId);
    });
    chrome.tabs.onReplaced?.addListener(() => {
      void this.refreshActiveTabs();
    });
    chrome.windows.onFocusChanged?.addListener(() => {
      void this.refreshActiveTabs();
    });
  }

  async refreshActiveTabs() {
    const previous = new Set(this.activeTabIds);
    this.activeTabIds.clear();
    try {
      const activeTabs = await chrome.tabs.query({ active: true });
      for (const tab of activeTabs) {
        if (typeof tab.id === "number") this.activeTabIds.add(tab.id);
      }
    } catch {}

    const changed = new Set();
    for (const tabId of previous) {
      if (!this.activeTabIds.has(tabId)) changed.add(tabId);
    }
    for (const tabId of this.activeTabIds) {
      if (!previous.has(tabId)) changed.add(tabId);
    }
    await Promise.all(Array.from(changed, (tabId) => this.publishTabState(tabId)));
  }
}