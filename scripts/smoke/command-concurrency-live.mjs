import fs from "node:fs";

import { createNewtonBrowserHost } from "../../apps/mcp-server/src/bridge.ts";
import { startFixtureServers } from "../../test/fixtures/server.mjs";

const browserTarget = process.env.NEWTON_BROWSER_QA_OWNER === "chrome" ? "chrome" : "edge";
const fixturePort = Number(process.env.NEWTON_BROWSER_QA_FIXTURE_PORT ?? 18231);
const hostPort = Number(process.env.NEWTON_BROWSER_PORT ?? 17321);
const statePath = process.env.NEWTON_BROWSER_QA_STATE_FILE;

const fixture = await startFixtureServers({ port: fixturePort, crossOriginPort: fixturePort + 1 });
const bridge = createNewtonBrowserHost({ authMode: "local_trust", browserTarget });

try {
  await bridge.listen(hostPort, "127.0.0.1");
  const sessions = await Promise.all(["fifo", "parallel"].map(async (worker) => {
    const sessionId = bridge.createSession({
      origin: fixture.origin,
      allowedOrigins: [fixture.origin],
      tabMode: "owned_group",
      goal: `command concurrency acceptance ${worker}`,
      instanceLabel: `command-concurrency-${worker}`,
    }).sessionId;
    const ready = await bridge.waitForSessionReady(sessionId, 90_000);
    return { worker, sessionId, tabId: ready.ownedTabId };
  }));
  const fifo = sessions.find((session) => session.worker === "fifo");
  const parallel = sessions.find((session) => session.worker === "parallel");
  assert(fifo && parallel, "acceptance sessions were not created");
  writeState({ phase: "running", browserTarget, sessions });

  let blockedSettled = false;
  let firstClickSettled = false;
  let secondClickSettled = false;
  const blocked = bridge.dispatch(fifo.sessionId, {
    kind: "wait_for",
    waitFor: { text: "aip01-never-present" },
    timeoutMs: 1_500,
  }, 30_000).finally(() => { blockedSettled = true; });
  const firstClick = bridge.dispatch(fifo.sessionId, {
    kind: "click",
    name: "Increment",
    waitFor: { text: "Count: 1" },
    timeoutMs: 3_000,
  }, 30_000).finally(() => { firstClickSettled = true; });
  const secondClick = bridge.dispatch(fifo.sessionId, {
    kind: "click",
    name: "Increment",
    waitFor: { text: "Count: 2" },
    timeoutMs: 3_000,
  }, 30_000).finally(() => { secondClickSettled = true; });
  const crossSession = bridge.dispatch(parallel.sessionId, {
    kind: "fill",
    label: "Search records",
    value: "parallel-progress",
  }, 30_000);

  const crossResult = await crossSession;
  assert(crossResult.ok === true, `parallel session failed: ${JSON.stringify(crossResult)}`);
  assert(blockedSettled === false, "session B did not progress while session A was blocked");
  assert(firstClickSettled === false && secondClickSettled === false, "same-session clicks overlapped the blocked first command");

  const firstResult = await blocked;
  const firstClickResult = await firstClick;
  const secondClickResult = await secondClick;
  assert(firstResult.ok === true && firstResult.result?.actionStatus === "timed_out", `missing wait was not classified as timed_out: ${JSON.stringify(firstResult)}`);
  assert(firstClickResult.ok === true && firstClickResult.result?.actionStatus === "verified", `first queued click failed: ${JSON.stringify(firstClickResult)}`);
  assert(secondClickResult.ok === true && secondClickResult.result?.actionStatus === "verified", `second queued click failed: ${JSON.stringify(secondClickResult)}`);
  assert(firstResult.sequence + 1 === firstClickResult.sequence && firstClickResult.sequence + 1 === secondClickResult.sequence, `same-session sequence was not contiguous: ${firstResult.sequence} -> ${firstClickResult.sequence} -> ${secondClickResult.sequence}`);
  assert(crossResult.sequence === 1, `parallel session did not have an independent sequence: ${crossResult.sequence}`);

  const [fifoObservation, parallelObservation] = await Promise.all([
    bridge.dispatch(fifo.sessionId, { kind: "observe", maxNodes: 160 }, 30_000),
    bridge.dispatch(parallel.sessionId, { kind: "observe", maxNodes: 160 }, 30_000),
  ]);
  assert(observedText(fifoObservation).includes("Count: 2"), "FIFO session did not retain both queued clicks");
  assert(observedValues(parallelObservation).includes("parallel-progress"), "parallel session did not retain its mutation");

  const report = {
    ok: true,
    browserTarget,
    sameSessionFifo: true,
    sameSessionOverlap: 0,
    crossSessionProgress: true,
    sequences: { fifo: [firstResult.sequence, firstClickResult.sequence, secondClickResult.sequence], parallel: crossResult.sequence },
    sessions,
  };
  writeState({ phase: "pass", ...report });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  writeState({ phase: "fail", browserTarget, message: error.message });
  throw error;
} finally {
  bridge.stopAll();
  await bridge.close();
  await fixture.close();
}

function observedValues(result) {
  assert(result.ok === true, `observation failed: ${JSON.stringify(result)}`);
  return (result.result?.nodes ?? []).map((node) => String(node.value ?? ""));
}

function observedText(result) {
  assert(result.ok === true, `observation failed: ${JSON.stringify(result)}`);
  return (result.result?.nodes ?? []).flatMap((node) => [String(node.name ?? ""), String(node.value ?? "")]);
}

function writeState(value) {
  if (statePath) fs.writeFileSync(statePath, `${JSON.stringify(value)}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
