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
    versionSkew: Boolean(hostVersion && incompatible(extensionVersion, hostVersion)),
  };
}

function incompatible(extensionVersion, hostVersion) {
  const extension = /^\d+\.(\d+)\./.exec(extensionVersion ?? "");
  const host = /^\d+\.(\d+)\./.exec(hostVersion ?? "");
  return extension && host && (extension[1] !== host[1] || extensionVersion.split(".")[0] !== hostVersion.split(".")[0]);
}
