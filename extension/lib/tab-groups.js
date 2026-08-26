// 标签页分组存储:管理 AI 创建的标签组(颜色、标题、持久化),与 Chrome tabGroups API 同步。
// 仿 browser-control-bridge 的 src/background/tabGroups.ts。

const GROUP_COLORS = ["grey", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
// blue is intentionally excluded: it's the browser's default/active color.

const STORAGE_KEY = "TAB_GROUPS";
const DEFAULT_SESSION_GROUP_TITLE = "JustSearch";

export class TabGroupStore {
  static instance = null;

  static getInstance() {
    this.instance ??= new TabGroupStore();
    return this.instance;
  }

  constructor() {
    this.groupMetadata = new Map();
    this.sessionGroupTitles = new Map();
    this.groupIdsReconcilingPresentation = new Set();
    this.initializePromise = null;
    this.listenersRegistered = false;
  }

  async ensureInit() {
    // 只做异步状态加载与呈现协调;事件监听的注册已拆出(MV3 要求监听必须在
    // SW 首次求值的同步栈里注册,放进这里的 await 链会丢掉唤醒 SW 的事件)。
    this.initializePromise ??= this.loadFromStorage().then(async () => {
      await this.reconcileAllGroupPresentations();
    });
    await this.initializePromise;
  }

  async ensureAgentTabGroup(sessionId, tabId, existingAgentTabIds) {
    await this.ensureInit();
    const existing = await this.findManagedGroupContainingTabs(existingAgentTabIds);
    if (existing) {
      const changed = this.syncSessionTitle(existing, sessionId);
      await this.addTabToGroup(existing, tabId);
      await this.reconcileGroupPresentation(existing.chromeGroupId);
      if (changed) await this.saveToStorage();
      return existing;
    }

    // SW 重启后内存里的 agent 标签集合为空,上面的探测会落空,但持久化的
    // 托管分组可能还活着。先探活复用,避免重建第二个同名 "JustSearch" 分组。
    const aliveGroupId = await this.findAlivePersistedGroupId();
    if (aliveGroupId != null) {
      const persisted = this.groupMetadata.get(aliveGroupId);
      const changed = this.syncSessionTitle(persisted, sessionId);
      await this.addTabToGroup(persisted, tabId);
      await this.reconcileGroupPresentation(aliveGroupId);
      if (changed) await this.saveToStorage();
      return persisted;
    }

    const group = await this.createGroup(tabId, this.sessionGroupTitles.get(sessionId));
    await this.reconcileGroupPresentation(group.chromeGroupId);
    await this.saveToStorage();
    return group;
  }

  async releaseTabsFromManagedGroups(tabIds) {
    await this.ensureInit();
    const tabIdSet = new Set(tabIds);
    if (tabIdSet.size === 0) return;

    const groupedTabs = await Promise.all(
      [...tabIdSet].map(async (tabId) => {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (typeof tab.groupId !== "number" || !this.groupMetadata.has(tab.groupId)) {
            return null;
          }
          return { tabId, groupId: tab.groupId };
        } catch {
          return null;
        }
      }),
    );

    const tabsToUngroup = [];
    const touchedGroups = new Set();
    for (const item of groupedTabs) {
      if (!item) continue;
      tabsToUngroup.push(item.tabId);
      touchedGroups.add(item.groupId);
    }

    if (tabsToUngroup.length > 0 && chrome.tabs.ungroup) {
      await Promise.allSettled(tabsToUngroup.map((tabId) => chrome.tabs.ungroup(tabId)));
    }

    let changed = false;
    for (const groupId of touchedGroups) {
      changed = (await this.removeManagedGroupIfEmpty(groupId)) || changed;
    }
    if (changed) await this.saveToStorage();
  }

  async refreshManagedGroupsFromChrome() {
    await this.ensureInit();
    let changed = false;
    for (const groupId of Array.from(this.groupMetadata.keys())) {
      changed = (await this.removeManagedGroupIfEmpty(groupId)) || changed;
    }
    if (changed) await this.saveToStorage();
  }

  // 从持久化的托管分组(TAB_GROUPS 存储,经 ensureInit 载入 groupMetadata)
  // 里逐个用 chrome.tabGroups.get 探活,返回第一个仍存在的组 id;
  // 探测失败(组已被关)视为死亡并跳过。找不到返回 null。
  async findAlivePersistedGroupId() {
    await this.ensureInit();
    for (const groupId of this.groupMetadata.keys()) {
      if (await this.readGroup(groupId)) return groupId;
    }
    return null;
  }

  // --- private methods ---

  async loadFromStorage() {
    const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    if (!stored) return;

    if (Array.isArray(stored)) {
      for (const group of stored) this.addStoredGroup(group);
      return;
    }

    for (const group of stored.groups ?? []) this.addStoredGroup(group);
    for (const [sessionId, title] of Object.entries(stored.sessionGroupTitles ?? {})) {
      const normalized = normalizeTitle(title);
      if (normalized) this.sessionGroupTitles.set(sessionId, normalized);
    }
  }

  async saveToStorage() {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        groups: Array.from(this.groupMetadata.values()),
        sessionGroupTitles: Object.fromEntries(this.sessionGroupTitles.entries()),
      },
    });
  }

  addStoredGroup(value) {
    if (!value || typeof value !== "object") return;
    const group = value;
    if (typeof group.chromeGroupId !== "number") return;
    this.groupMetadata.set(group.chromeGroupId, {
      chromeGroupId: group.chromeGroupId,
      presentationColor: isTabGroupColor(group.presentationColor) ? group.presentationColor : undefined,
      title: normalizeTitle(group.title),
    });
  }

  async createGroup(tabId, title) {
    const chromeGroupId = await chrome.tabs.group({ tabIds: [tabId] });
    const group = {
      chromeGroupId,
      presentationColor: randomGroupColor(),
      title: normalizeTitle(title),
    };
    this.groupMetadata.set(chromeGroupId, group);
    return group;
  }

  async addTabToGroup(group, tabId) {
    if ((await chrome.tabs.get(tabId)).groupId !== group.chromeGroupId) {
      await chrome.tabs.group({ groupId: group.chromeGroupId, tabIds: tabId });
    }
  }

  // 由 background.js 在顶层同步调用(SW 求值栈内),不在 ensureInit 的异步链里。
  // 每个 API 入口单独特性探测,缺 API(tabGroups 权限/版本不足)时静默降级。
  registerEventListeners() {
    if (this.listenersRegistered) return;
    this.listenersRegistered = true;
    if (chrome.tabGroups?.onCreated) {
      chrome.tabGroups.onCreated.addListener((group) => {
        void this.handleObservedGroup(group);
      });
    }
    if (chrome.tabGroups?.onUpdated) {
      chrome.tabGroups.onUpdated.addListener((group) => {
        void this.handleObservedGroup(group);
      });
    }
    if (chrome.tabGroups?.onRemoved) {
      chrome.tabGroups.onRemoved.addListener((group) => {
        this.handleRemovedGroup(group.id);
      });
    }
  }

  async handleObservedGroup(group) {
    if (this.groupMetadata.has(group.id)) {
      await this.reconcileGroupPresentation(group.id, group);
    }
  }

  handleRemovedGroup(groupId) {
    if (this.groupMetadata.delete(groupId)) {
      void this.saveToStorage();
    }
  }

  async reconcileAllGroupPresentations() {
    await Promise.all(
      Array.from(this.groupMetadata.keys(), (groupId) =>
        this.reconcileGroupPresentation(groupId),
      ),
    );
  }

  async reconcileGroupPresentation(groupId, currentGroup) {
    const managed = this.groupMetadata.get(groupId);
    if (!managed || !chrome.tabGroups?.update) return;
    const color = this.ensurePresentationColor(managed);
    const current = currentGroup ?? (await this.readGroup(groupId));
    const update = {};
    const title = managed.title ?? DEFAULT_SESSION_GROUP_TITLE;

    if (!current || current.color !== color) update.color = color;
    if (!current || current.collapsed !== false) update.collapsed = false;
    if (!current || current.title !== title) update.title = title;

    if (Object.keys(update).length === 0 || this.groupIdsReconcilingPresentation.has(groupId)) {
      return;
    }

    this.groupIdsReconcilingPresentation.add(groupId);
    try {
      await chrome.tabGroups.update(groupId, update);
    } catch {
      // Group may have been closed between query and update.
    } finally {
      this.groupIdsReconcilingPresentation.delete(groupId);
    }
  }

  ensurePresentationColor(group) {
    if (isTabGroupColor(group.presentationColor)) return group.presentationColor;
    const color = randomGroupColor();
    group.presentationColor = color;
    void this.saveToStorage();
    return color;
  }

  async readGroup(groupId) {
    if (!chrome.tabGroups?.get) return null;
    try {
      return await chrome.tabGroups.get(groupId);
    } catch {
      return null;
    }
  }

  syncSessionTitle(group, sessionId) {
    const title = this.sessionGroupTitles.get(sessionId);
    if (group.title === title) return false;
    group.title = title;
    return true;
  }

  async removeManagedGroupIfEmpty(groupId) {
    if ((await this.groupTabIds(groupId)).length > 0) return false;
    return this.groupMetadata.delete(groupId);
  }

  async groupTabIds(groupId) {
    return (await chrome.tabs.query({ groupId }))
      .map((tab) => tab.id)
      .filter((tabId) => typeof tabId === "number");
  }

  async findManagedGroupContainingTabs(tabIds) {
    for (const tabId of tabIds) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (typeof tab.groupId !== "number") continue;
        const group = this.groupMetadata.get(tab.groupId);
        if (group && (await this.readGroup(tab.groupId))) return group;
      } catch {
        // Ignore stale tabs.
      }
    }
    return null;
  }
}

export function normalizeTitle(title) {
  if (typeof title !== "string") return undefined;
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isTabGroupColor(value) {
  return typeof value === "string" && GROUP_COLORS.includes(value);
}

export function randomGroupColor() {
  return GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)] ?? "grey";
}