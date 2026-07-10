import fs from "node:fs";

import { createBrowserBridgeHost } from "../../apps/mcp-server/src/bridge.ts";
import { startFixtureServers } from "../../test/fixtures/server.mjs";

const browserTarget = process.env.BROWSER_BRIDGE_QA_OWNER === "chrome" ? "chrome" : "edge";
const fixturePort = Number(process.env.BROWSER_BRIDGE_QA_FIXTURE_PORT ?? 18231);
const hostPort = Number(process.env.BROWSER_BRIDGE_PORT ?? 17321);
const statePath = process.env.BROWSER_BRIDGE_QA_STATE_FILE;
if (!statePath) throw new Error("BROWSER_BRIDGE_QA_STATE_FILE is required");

const fixture = await startFixtureServers({ port: fixturePort, crossOriginPort: fixturePort + 1 });
const bridge = createBrowserBridgeHost({ authMode: "local_trust", browserTarget });
let sessionId = "";

try {
  await bridge.listen(hostPort, "127.0.0.1");
  await waitFor(() => bridge.getStatus().eligibleClientCount === 1, `${browserTarget} extension`);
  sessionId = bridge.createSession({
    origin: fixture.origin,
    allowedOrigins: [fixture.origin],
    tabMode: "owned_group",
    goal: "service-worker restart chaos",
    instanceLabel: "live-worker-restart",
  }).sessionId;
  const first = await bridge.waitForSessionReady(sessionId, 90_000);
  writeState({ phase: "reload_now", browserTarget, sessionId, tabId: first.ownedTabId, groupId: first.tabGroupId });

  const interrupted = await bridge.dispatch(sessionId, {
    kind: "wait_for",
    waitFor: { text: `never-present-${Date.now()}` },
    timeoutMs: 120_000,
  }, 120_000);
  assert(interrupted.ok === false && interrupted.errorCode === "extension_disconnected", `mid-command result was ${JSON.stringify(interrupted)}`);
  writeState({ phase: "recovering", browserTarget, sessionId, tabId: first.ownedTabId, interrupted: interrupted.errorCode });

  const recovered = await bridge.waitForSessionReady(sessionId, 90_000);
  assert(recovered.ownedTabId === first.ownedTabId, `worker restart created a duplicate tab: ${first.ownedTabId} -> ${recovered.ownedTabId}`);
  const observed = await bridge.dispatch(sessionId, { kind: "observe", maxNodes: 40 }, 30_000);
  assert(observed.ok === true && observed.result?.origin === fixture.origin, `recovered observation failed: ${JSON.stringify(observed)}`);
  const report = {
    ok: true,
    browserTarget,
    sessionId,
    tabId: recovered.ownedTabId,
    sameOwnedTab: true,
    interrupted: interrupted.errorCode,
    recoveredObservation: observed.result?.title,
  };
  writeState({ phase: "pass", ...report });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  writeState({ phase: "fail", browserTarget, sessionId, message: error.message });
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
