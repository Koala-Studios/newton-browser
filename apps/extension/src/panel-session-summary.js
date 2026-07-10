const PANEL_SESSION_LIMIT = 32;

export function summarizePanelSessions(sessions) {
  return (Array.isArray(sessions) ? sessions : [])
    .slice(0, PANEL_SESSION_LIMIT)
    .flatMap((session) => {
      if (typeof session?.origin !== "string" || !/^https?:\/\//.test(session.origin)) return [];
      return [{
        origin: session.origin,
        mode: session.tabMode === "current" ? "current" : "owned",
        label: typeof session.instanceLabel === "string" ? session.instanceLabel.slice(0, 120) : "",
      }];
    });
}

export function createPanelViewModel({ sessions, extensionVersion, hostVersion } = {}) {
  const rows = summarizePanelSessions(sessions);
  return {
    rows,
    showSessions: rows.length > 0,
    showStopAll: rows.length > 0,
    version: hostVersion ? `Extension ${extensionVersion} · Host ${hostVersion}` : `Extension ${extensionVersion}`,
  };
}
