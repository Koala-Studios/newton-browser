// Find an existing incognito window or open one. Throws a typed error when the
// extension is not allowed in incognito (the user must enable it in chrome://extensions),
// so the host can tell the caller exactly what to do instead of failing opaquely.
type UnknownRecord = Record<string, unknown>;
type ChromeTab = { id?: number; windowId?: number; active?: boolean; url?: string; pendingUrl?: string; discarded?: boolean };
type ChromeWindow = { id?: number; incognito?: boolean; type?: string };
type DebuggerSource = { tabId?: number };
type DebuggerEventCallback = (source: DebuggerSource, method: string, params: UnknownRecord) => void;
type DebuggerDetachCallback = (source: DebuggerSource, reason: string) => void;
type TabRemovedCallback = (tabId: number, removeInfo?: UnknownRecord) => void;
type TabUpdatedCallback = (tabId: number, changeInfo: UnknownRecord, tab: ChromeTab) => void;
type ChromeApi = {
  tabs: {
    create(input: UnknownRecord): Promise<ChromeTab>;
    group(input: { tabIds: number[] }): Promise<number>;
    update(tabId: number, input: UnknownRecord): Promise<ChromeTab | void>;
    remove(tabId: number): Promise<void>;
    get(tabId: number): Promise<ChromeTab>;
    ungroup?(tabId: number): Promise<void>;
    onRemoved: { addListener(callback: TabRemovedCallback): void; removeListener?(callback: TabRemovedCallback): void };
    onUpdated: { addListener(callback: TabUpdatedCallback): void; removeListener?(callback: TabUpdatedCallback): void };
  };
  tabGroups: { update(groupId: number, input: UnknownRecord): Promise<unknown> };
  windows?: {
    getAll?(input: UnknownRecord): Promise<ChromeWindow[]>;
    create?(input: UnknownRecord): Promise<ChromeWindow>;
    update?(windowId: number, input: UnknownRecord): Promise<unknown>;
  };
  debugger: {
    onEvent: { addListener(callback: DebuggerEventCallback): void; removeListener?(callback: DebuggerEventCallback): void };
    onDetach: { addListener(callback: DebuggerDetachCallback): void; removeListener?(callback: DebuggerDetachCallback): void };
  };
};

async function ensureIncognitoWindow(chromeApi: ChromeApi): Promise<number> {
  const windows = await (chromeApi.windows?.getAll?.({}) ?? Promise.resolve([])).catch(() => []);
  const existing = Array.isArray(windows) ? windows.find((window) => window?.incognito && window?.type !== "devtools") : null;
  if (existing && typeof existing.id === "number" && Number.isInteger(existing.id)) return existing.id;
  if (!chromeApi.windows?.create) throw new Error("incognito_not_supported");
  try {
    const created = await chromeApi.windows.create({ incognito: true });
    if (!created || typeof created.id !== "number" || !Number.isInteger(created.id)) throw new Error("incognito_not_allowed");
    return created.id;
  } catch {
    throw new Error("incognito_not_allowed");
  }
}

export function createChromeTabsPort(
  chromeApi: ChromeApi | undefined = (globalThis as typeof globalThis & { chrome?: ChromeApi }).chrome,
) {
  if (!chromeApi) throw new Error("chrome API is required");
  return {
    async createOwnedTab(origin: unknown, color: unknown, title: unknown, options: { incognito?: boolean } = {}) {
      const url = typeof origin === "string" && /^https?:\/\//i.test(origin) ? origin : "about:blank";
      // Incognito sessions open the owned tab in an incognito window so the tab never
      // touches the user's authenticated profile cookies/storage. Requires the
      // extension to be allowed in incognito; otherwise a typed error surfaces.
      const windowId = options.incognito ? await ensureIncognitoWindow(chromeApi) : null;
      const tab = await chromeApi.tabs.create({ url, active: false, ...(windowId !== null ? { windowId } : {}) });
      if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 0) {
        throw new Error("invalid_created_tab_id");
      }
      const tabId = tab.id;
      await chromeApi.tabs.update(tabId, { autoDiscardable: false });
      let groupId = null;
      try {
        groupId = await chromeApi.tabs.group({ tabIds: [tabId] });
        await chromeApi.tabGroups.update(groupId, { title: title || "Newton", color: color ?? "blue" }).catch(() => {});
      } catch {
        groupId = null;
      }
      return { tabId, groupId };
    },

    async setAutoDiscardable(tabId: number, autoDiscardable: boolean) {
      await chromeApi.tabs.update(tabId, { autoDiscardable: Boolean(autoDiscardable) });
    },

    async removeTab(tabId: number) {
      await chromeApi.tabs.remove(tabId);
    },

    async getTab(tabId: number) {
      return chromeApi.tabs.get(tabId);
    },

    async focusTab(tabId: number) {
      const tab = await chromeApi.tabs.get(tabId);
      if (!tab?.active) {
        try {
          await chromeApi.tabs.update(tabId, { active: true });
        } catch (error) {
          const current = await chromeApi.tabs.get(tabId);
          if (!current?.active) throw error;
        }
      }
      if (typeof tab.windowId === "number" && Number.isInteger(tab.windowId)) {
        await chromeApi.windows?.update?.(tab.windowId, { focused: true }).catch(() => {});
      }
    },

    async finalizeTab(tabId: number, disposition: string) {
      if (disposition !== "handoff") return;
      await chromeApi.tabs.ungroup?.(tabId).catch(() => {});
      await chromeApi.tabs.update(tabId, { active: true }).catch(() => {});
    },

    onDebuggerEvent(callback: DebuggerEventCallback) {
      chromeApi.debugger.onEvent.addListener(callback);
      return () => chromeApi.debugger.onEvent.removeListener?.(callback);
    },

    onDebuggerDetach(callback: DebuggerDetachCallback) {
      chromeApi.debugger.onDetach.addListener(callback);
      return () => chromeApi.debugger.onDetach.removeListener?.(callback);
    },

    onTabRemoved(callback: TabRemovedCallback) {
      chromeApi.tabs.onRemoved.addListener(callback);
      return () => chromeApi.tabs.onRemoved.removeListener?.(callback);
    },

    onTabUpdated(callback: TabUpdatedCallback) {
      chromeApi.tabs.onUpdated.addListener(callback);
      return () => chromeApi.tabs.onUpdated.removeListener?.(callback);
    },
  };
}
