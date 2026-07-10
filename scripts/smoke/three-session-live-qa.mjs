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
  const sessions = await Promise.all(["alpha", "bravo", "charlie"].map(async (worker) => {
    const sessionId = bridge.createSession({
      origin: fixture.origin,
      allowedOrigins: [fixture.origin],
      tabMode: "owned_group",
      goal: `three-session focus isolation ${worker}`,
      instanceLabel: `three-session-${worker}`,
    }).sessionId;
    const ready = await bridge.waitForSessionReady(sessionId, 90_000);
    return { worker, sessionId, tabId: ready.ownedTabId, groupId: ready.tabGroupId };
  }));
  assert(new Set(sessions.map((session) => session.tabId)).size === 3, "owned tab IDs were not isolated");
  assert(new Set(sessions.map((session) => session.groupId)).size === 3, "tab group IDs were not isolated");
  const status = bridge.getStatus();
  assert(status.claimedSessionsByBrowser[browserTarget] === 3, `wrong browser ownership: ${JSON.stringify(status)}`);
  writeState({ phase: "change_focus_now", browserTarget, sessions });
  await new Promise((resolve) => setTimeout(resolve, 10_000));

  const results = await Promise.all(sessions.map(async ({ worker, sessionId }) => {
    const filled = await bridge.dispatch(sessionId, { kind: "fill", label: "Search records", value: worker }, 30_000);
    assert(filled.ok === true, `${worker} fill failed: ${JSON.stringify(filled)}`);
    const clicked = await bridge.dispatch(sessionId, { kind: "click", name: "Run fixture search", waitFor: { text: `search-result:${worker}` }, timeoutMs: 3000 }, 30_000);
    assert(clicked.ok === true && clicked.result?.actionStatus === "verified", `${worker} search failed: ${JSON.stringify(clicked)}`);
    const observed = await bridge.dispatch(sessionId, { kind: "observe", maxNodes: 160 }, 30_000);
    assert(observed.ok === true, `${worker} observe failed: ${JSON.stringify(observed)}`);
    const values = (observed.result?.nodes ?? []).map((node) => String(node.value ?? ""));
    assert(values.includes(worker), `${worker} value missing from its own tab`);
    for (const peer of sessions.map((session) => session.worker).filter((value) => value !== worker)) {
      assert(!values.includes(peer), `${worker} observation leaked ${peer}`);
    }
    return { worker, sessionId, actionStatus: clicked.result?.actionStatus, isolated: true };
  }));

  const report = {
    ok: true,
    browserTarget,
    sessions: results,
    distinctTabs: 3,
    distinctGroups: 3,
    focusIndependent: true,
    crossSessionLeaks: 0,
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
