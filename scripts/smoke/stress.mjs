import { randomUUID } from "node:crypto";

import { WebSocket } from "../../apps/mcp-server/node_modules/ws/wrapper.mjs";

import { createBrowserBridgeHost } from "../../apps/mcp-server/src/bridge.ts";

const durationMs = Number(process.env.BROWSER_BRIDGE_STRESS_MS ?? 300_000);
const rssLimitBytes = Number(process.env.BROWSER_BRIDGE_STRESS_RSS_LIMIT_MB ?? 96) * 1024 * 1024;
const bridge = createBrowserBridgeHost({ authMode: "local_trust", browserTarget: "auto" });
let socket;

try {
  const listening = await bridge.listen(0, "127.0.0.1");
  socket = await connectFakeExtension(listening.port);
  await saturationProbe();

  const sessions = await Promise.all(["worker-a", "worker-b"].map((worker, index) => readySession(worker, index)));
  if (global.gc) global.gc();
  const rssStart = process.memoryUsage().rss;
  let rssMax = rssStart;
  let operations = 0;
  let crossResults = 0;
  const deadline = Date.now() + durationMs;

  await Promise.all(sessions.map(({ sessionId, worker }) => runWorker(sessionId, worker)));
  if (global.gc) global.gc();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const rssEnd = process.memoryUsage().rss;
  rssMax = Math.max(rssMax, rssEnd);
  const rssGrowth = Math.max(rssMax - rssStart, rssEnd - rssStart);

  assert(crossResults === 0, `cross-session results detected: ${crossResults}`);
  assert(operations > 0, "stress workers completed no operations");
  assert(rssGrowth <= rssLimitBytes, `RSS growth ${rssGrowth} exceeded ${rssLimitBytes}`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    durationMs,
    workers: sessions.map((item) => item.worker),
    operations,
    crossResults,
    deadlocks: 0,
    rss: { start: rssStart, max: rssMax, end: rssEnd, growth: rssGrowth, limit: rssLimitBytes },
  })}\n`);

  async function runWorker(sessionId, worker) {
    let sequence = 0;
    while (Date.now() < deadline) {
      sequence += 1;
      const result = await bridge.dispatch(sessionId, { kind: "observe", query: worker, sequence }, 5000);
      assert(result.ok === true, `${worker} dispatch failed: ${JSON.stringify(result)}`);
      const payload = result.result ?? {};
      if (payload.sessionId !== sessionId || payload.worker !== worker || payload.sequence !== sequence) crossResults += 1;
      operations += 1;
      if (sequence % 100 === 0) {
        rssMax = Math.max(rssMax, process.memoryUsage().rss);
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }

  async function saturationProbe() {
    const { sessionId } = bridge.createSession({
      origin: "https://example.com",
      allowedOrigins: ["https://example.com"],
      tabMode: "owned_group",
      instanceLabel: "saturation-probe",
    });
    await waitFor(() => bridge.getStatus().claimedSessionsByBrowser.chrome === 1, "saturation session claim");
    const pending = Array.from({ length: bridge.limits.maxQueuedPerSession + 1 }, () => bridge.dispatch(sessionId, { kind: "observe" }, 5000));
    const saturated = await pending.at(-1);
    assert(saturated?.errorCode === "queue_full", "per-session queue saturation was not typed");
    bridge.stopSession(sessionId);
    await Promise.all(pending);
  }

  async function readySession(worker, index) {
    const { sessionId } = bridge.createSession({
      origin: "https://example.com",
      allowedOrigins: ["https://example.com"],
      tabMode: "owned_group",
      instanceLabel: worker,
    });
    const session = await bridge.waitForSessionReady(sessionId, 5000);
    assert(session.attached && Number.isInteger(session.ownedTabId), `${worker} did not attach`);
    return { sessionId, worker, index };
  }
} finally {
  bridge.stopAll();
  socket?.close();
  await bridge.close();
}

async function connectFakeExtension(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: "chrome-extension://stress-fixture" } });
  const claimed = new Set();
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === "client_ready" || message.type === "sessions_changed") {
      request(ws, "listSessions", {});
      return;
    }
    if (message.type === "bridge_response" && Array.isArray(message.result)) {
      for (const session of message.result) {
        if (claimed.has(session.sessionId)) continue;
        claimed.add(session.sessionId);
        if (session.instanceLabel === "saturation-probe") continue;
        request(ws, "attachTab", { sessionId: session.sessionId, tab: { ownedTabId: 700 + claimed.size, tabGroupId: 800, attached: true, liveOrigin: session.origin } });
        request(ws, "subscribeSession", { sessionId: session.sessionId });
      }
      return;
    }
    if (message.type !== "bridge_command") return;
    const { command } = message;
    request(ws, "postResult", {
      event: {
        commandId: command.commandId,
        ok: true,
        result: {
          sessionId: command.sessionId,
          worker: command.action.query,
          sequence: command.action.sequence,
        },
      },
    });
  });
  ws.send(JSON.stringify({ type: "client_hello", clientId: `stress_extension_${randomUUID().replaceAll("-", "")}`, browserFamily: "chrome" }));
  await waitFor(() => bridge.getStatus().eligibleClientCount === 1, "stress extension readiness");
  return ws;
}

function request(ws, method, params) {
  ws.send(JSON.stringify({ type: "bridge_request", requestId: `stress_${randomUUID()}`, method, params }));
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
