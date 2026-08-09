// Find an existing incognito window or open one. Throws a typed error when the
// extension is not allowed in incognito (the user must enable it in chrome://extensions),
// so the host can tell the caller exactly what to do instead of failing opaquely.
async function ensureIncognitoWindow(chromeApi) {
  const windows = await (chromeApi.windows?.getAll?.({}) ?? Promise.resolve([])).catch(() => []);
  const existing = Array.isArray(windows) ? windows.find((window) => window?.incognito && window?.type !== "devtools") : null;
  if (existing && Number.isInteger(existing.id)) return existing.id;
  if (!chromeApi.windows?.create) throw new Error("incognito_not_supported");
  try {
    const created = await chromeApi.windows.create({ incognito: true });
    if (!created || !Number.isInteger(created.id)) throw new Error("incognito_not_allowed");
    return created.id;
  } catch {
    throw new Error("incognito_not_allowed");
  }
}

export function createChromeTabsPort(chromeApi = globalThis.chrome) {
  if (!chromeApi) throw new Error("chrome API is required");
  return {
    async createOwnedTab(origin, color, title, options = {}) {
      const url = typeof origin === "string" && /^https?:\/\//i.test(origin) ? origin : "about:blank";
      // Incognito sessions open the owned tab in an incognito window so the tab never
      // touches the user's authenticated profile cookies/storage. Requires the
      // extension to be allowed in incognito; otherwise a typed error surfaces.
      const windowId = options.incognito ? await ensureIncognitoWindow(chromeApi) : null;
      const tab = await chromeApi.tabs.create({ url, active: false, ...(windowId !== null ? { windowId } : {}) });
      if (Number.isInteger(tab?.id) && chromeApi.tabs.update) {
        await chromeApi.tabs.update(tab.id, { autoDiscardable: false });
      }
      let groupId = null;
      try {
        groupId = await chromeApi.tabs.group({ tabIds: [tab.id] });
        await chromeApi.tabGroups.update(groupId, { title: title || "Newton", color: color ?? "blue" }).catch(() => {});
      } catch {
        groupId = null;
      }
      return { tabId: tab.id, groupId };
    },

    async setAutoDiscardable(tabId, autoDiscardable) {
      await chromeApi.tabs.update(tabId, { autoDiscardable: Boolean(autoDiscardable) });
    },

    async removeTab(tabId) {
      await chromeApi.tabs.remove(tabId);
    },

    async getTab(tabId) {
      return chromeApi.tabs.get(tabId);
    },

    async focusTab(tabId) {
      const tab = await chromeApi.tabs.get(tabId);
      if (!tab?.active) {
        try {
          await chromeApi.tabs.update(tabId, { active: true });
        } catch (error) {
          const current = await chromeApi.tabs.get(tabId);
          if (!current?.active) throw error;
        }
      }
      if (Number.isInteger(tab?.windowId)) await chromeApi.windows?.update?.(tab.windowId, { focused: true }).catch(() => {});
    },

    async finalizeTab(tabId, disposition) {
      if (disposition !== "handoff") return;
      await chromeApi.tabs.ungroup?.(tabId).catch(() => {});
      await chromeApi.tabs.update?.(tabId, { active: true }).catch(() => {});
    },

    onDebuggerEvent(callback) {
      chromeApi.debugger.onEvent.addListener(callback);
      return () => chromeApi.debugger.onEvent.removeListener?.(callback);
    },

    onDebuggerDetach(callback) {
      chromeApi.debugger.onDetach.addListener(callback);
      return () => chromeApi.debugger.onDetach.removeListener?.(callback);
    },

    onTabRemoved(callback) {
      chromeApi.tabs.onRemoved.addListener(callback);
      return () => chromeApi.tabs.onRemoved.removeListener?.(callback);
    },

    onTabUpdated(callback) {
      chromeApi.tabs.onUpdated.addListener(callback);
      return () => chromeApi.tabs.onUpdated.removeListener?.(callback);
    },
  };
}
