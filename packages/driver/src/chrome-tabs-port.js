export function createChromeTabsPort(chromeApi = globalThis.chrome) {
  if (!chromeApi) throw new Error("chrome API is required");
  return {
    async createOwnedTab(origin, color, title) {
      const url = typeof origin === "string" && /^https?:\/\//i.test(origin) ? origin : "about:blank";
      const tab = await chromeApi.tabs.create({ url, active: false });
      let groupId = null;
      try {
        groupId = await chromeApi.tabs.group({ tabIds: [tab.id] });
        await chromeApi.tabGroups.update(groupId, { title: title || "Bridge", color: color ?? "blue" }).catch(() => {});
      } catch {
        groupId = null;
      }
      return { tabId: tab.id, groupId };
    },

    async removeTab(tabId) {
      await chromeApi.tabs.remove(tabId);
    },

    async getTab(tabId) {
      return chromeApi.tabs.get(tabId);
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
  };
}
