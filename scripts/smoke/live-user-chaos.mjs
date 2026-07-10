import fs from "node:fs";

import { createNewtonBrowserHost } from "../../apps/mcp-server/src/bridge.ts";
import { startFixtureServers } from "../../test/fixtures/server.mjs";

const browserTarget = process.env.NEWTON_BROWSER_QA_OWNER === "chrome" ? "chrome" : "edge";
const fixturePort = Number(process.env.NEWTON_BROWSER_QA_FIXTURE_PORT ?? 18231);
const hostPort = Number(process.env.NEWTON_BROWSER_PORT ?? 17321);
const statePath = process.env.NEWTON_BROWSER_QA_STATE_FILE;
if (!statePath) throw new Error("NEWTON_BROWSER_QA_STATE_FILE is required");

const fixture = await startFixtureServers({ port: fixturePort, crossOriginPort: fixturePort + 1 });
const bridge = createNewtonBrowserHost({ authMode: "local_trust", browserTarget });

try {
  await bridge.listen(hostPort, "127.0.0.1");
  await waitFor(() => bridge.getStatus().eligibleClientCount === 1, `${browserTarget} extension`);

  const detached = await readySession("user debugger detach");
  writeState({ phase: "cancel_debugger_now", browserTarget, sessionId: detached.sessionId, tabId: detached.ownedTabId });
  await waitFor(() => !bridge.listSessions().some((session) => session.sessionId === detached.sessionId), "user-canceled debugger session cleanup");
  writeState({ phase: "debugger_detach_pass", browserTarget, detachedSessionId: detached.sessionId, tabId: detached.ownedTabId });

  const closed = await readySession("user closes driven tab");
  writeState({ phase: "close_tab_now", browserTarget, sessionId: closed.sessionId, tabId: closed.ownedTabId });
  await waitFor(() => !bridge.listSessions().some((session) => session.sessionId === closed.sessionId), "user-closed tab session cleanup");

  const report = {
    ok: true,
    browserTarget,
    debuggerDetach: { sessionStopped: true, tabId: detached.ownedTabId },
    userTabClose: { sessionStopped: true, tabId: closed.ownedTabId },
    remainingSessions: bridge.listSessions().length,
  };
  writeState({ phase: "pass", ...report });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  writeState({ phase: "fail", browserTarget, message: error.message });
  throw error;
} finally {
  bridge.stopAll();
  await new Promise((resolve) => setTimeout(resolve, 250));
  await bridge.close();
  await fixture.close();
}

async function readySession(goal) {
  const sessionId = bridge.createSession({
    origin: fixture.origin,
    allowedOrigins: [fixture.origin],
    tabMode: "owned_group",
    goal,
    instanceLabel: "live-user-chaos",
  }).sessionId;
  return bridge.waitForSessionReady(sessionId, 90_000);
}

function writeState(value) {
  fs.writeFileSync(statePath, `${JSON.stringify(value)}\n`);
}

async function waitFor(predicate, label, timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}
