import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ARTIFACT = path.join(ROOT, "artifacts", "newton-browser-0.6.4.tgz");
const DEFAULT_EVIDENCE_PATH = path.join(ROOT, "test", "evidence", "luna-packed-concurrency.json");
const DEFAULT_EXPECTED_SHA256 = "8C8C78BB76BB34B3795077910D89F70AF93176A01D5C13C025300A1741751BE8";
const PROTOCOL_VERSION = "2026-07-28";
const CLIENT_INFO = { name: "packed-concurrency-probes", version: "1.0.0" };
const NORMAL_TIMEOUT_MS = 30_000;
const WAIT_TIMEOUT_MS = 130_000;
const MAX_TEXT = 1600;

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const fixtureHtml = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Newton concurrency fixture</title></head>
<body>
  <main>
    <h1>Newton concurrency fixture</h1>
    <p>This page has session-local DOM state only.</p>
    <label for="value">Value</label>
    <input id="value" name="value" aria-label="Value" type="text" value="">
    <p>Visible value: <output id="value-output" aria-live="polite">empty</output></p>
    <p id="fixture-marker">deterministic-local-fixture</p>
  </main>
  <script>
    const input = document.querySelector('#value');
    const output = document.querySelector('#value-output');
    function render() { output.textContent = input.value || 'empty'; }
    input.addEventListener('input', render);
    input.addEventListener('change', render);
    render();
  </script>
</body>
</html>`;

function clip(value, max = MAX_TEXT) {
  if (typeof value !== "string") return value;
  return value.length <= max ? value : `${value.slice(0, max)}...[truncated ${value.length - max} chars]`;
}

function safeSummary(value, depth = 0) {
  if (depth > 4) return "[depth limited]";
  if (typeof value === "string") return clip(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => safeSummary(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, safeSummary(item, depth + 1)]));
}

function jsonLineBytes(value) {
  return Buffer.byteLength(JSON.stringify(value) + "\n", "utf8");
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeForSerialization(value) {
  const workspacePrefix = path.resolve(ROOT).replaceAll("\\", "/");
  const tempPrefix = path.resolve(tmpdir()).replaceAll("\\", "/");
  const homePrefix = process.env.USERPROFILE ? path.resolve(process.env.USERPROFILE).replaceAll("\\", "/") : null;
  const normalizeText = (text) => {
    let normalized = text.replaceAll("\\", "/");
    normalized = normalized.replaceAll(workspacePrefix, "<workspace>");
    normalized = normalized.replaceAll(tempPrefix, "<qa-temp>");
    if (homePrefix) normalized = normalized.replaceAll(homePrefix, "<operator-home>");
    return normalized;
  };
  if (typeof value === "string") return normalizeText(value);
  if (Array.isArray(value)) return value.map(normalizeForSerialization);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeForSerialization(item)]));
  return value;
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex").toUpperCase();
}

function nodeText(node) {
  return [node?.name, node?.text, node?.value, node?.href].filter((item) => typeof item === "string").join(" ");
}

function observationOf(data) {
  return data?.observation ?? data?.data?.observation ?? data ?? {};
}

function nodesOf(data) {
  const nodes = observationOf(data).nodes;
  return Array.isArray(nodes) ? nodes : [];
}

function visibleText(data) {
  const observation = observationOf(data);
  if (typeof observation.text === "string") return observation.text;
  return nodesOf(data).map(nodeText).join(" ");
}

function findValueRef(data) {
  return nodesOf(data).find((node) => ["textbox", "searchbox"].includes(node?.role) && /value/i.test(nodeText(node)))?.ref ?? null;
}

function resultData(toolResult) {
  return toolResult?.ok ? toolResult.data : null;
}

function errorDetails(toolResult) {
  return toolResult?.ok ? null : toolResult?.error;
}

class PackedMcpClient {
  constructor(entry, evidence) {
    this.entry = entry;
    this.evidence = evidence;
    this.nextId = 1;
    this.buffer = "";
    this.pending = new Map();
    this.stderr = "";
    this.child = spawn(process.execPath, [entry], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8000);
    });
    this.child.on("exit", (code, signal) => {
      for (const pending of this.pending.values()) pending.reject(new Error(`MCP process exited code=${code} signal=${signal}`));
      this.pending.clear();
    });
  }

  #onStdout(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      pending.resolve({ message, responseBytes: Buffer.byteLength(line, "utf8") });
    }
  }

  async request(method, params, timeoutMs = NORMAL_TIMEOUT_MS) {
    const id = this.nextId++;
    const wire = {
      jsonrpc: "2.0",
      id,
      method,
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
        },
        ...params,
      },
    };
    const requestBytes = jsonLineBytes(wire);
    const started = performance.now();
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP timeout method=${method} id=${id}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(`${JSON.stringify(wire)}\n`);
    });
    const elapsedMs = Math.round(performance.now() - started);
    const message = response.message;
    if (message?.error) {
      const record = {
        sequence: this.evidence.calls.length + 1,
        method,
        tool: params?.name ?? null,
        arguments: safeSummary(params?.arguments ?? null),
        requestBytes,
        responseBytes: response.responseBytes,
        elapsedMs,
        transportOk: true,
        protocolOk: false,
        error: safeSummary(message.error),
      };
      this.evidence.calls.push(record);
      return { ok: false, error: message.error.message ?? "MCP error", record };
    }
    const result = message?.result ?? {};
    const textBlock = Array.isArray(result.content) ? result.content.find((item) => item?.type === "text") : null;
    let data = result;
    if (textBlock) {
      try {
        data = JSON.parse(textBlock.text);
      } catch {
        data = { text: textBlock.text };
      }
    }
    const record = {
      sequence: this.evidence.calls.length + 1,
      method,
      tool: params?.name ?? null,
      arguments: safeSummary(params?.arguments ?? null),
      requestBytes,
      responseBytes: response.responseBytes,
      elapsedMs,
      transportOk: true,
      protocolOk: true,
      resultType: result.resultType ?? null,
      response: safeSummary(data),
    };
    this.evidence.calls.push(record);
    return { ok: true, data, record };
  }

  async tool(name, argumentsValue, timeoutMs = NORMAL_TIMEOUT_MS) {
    try {
      return await this.request("tools/call", { name, arguments: argumentsValue }, timeoutMs);
    } catch (error) {
      const record = {
        sequence: this.evidence.calls.length + 1,
        method: "tools/call",
        tool: name,
        arguments: safeSummary(argumentsValue),
        requestBytes: null,
        responseBytes: 0,
        elapsedMs: null,
        transportOk: false,
        protocolOk: false,
        error: error.message,
      };
      this.evidence.calls.push(record);
      return { ok: false, error: error.message, record };
    }
  }

  async close() {
    if (!this.child.killed) this.child.kill();
    await new Promise((resolve) => this.child.once("close", resolve));
  }
}

function workflowRecord() {
  return {
    success: false,
    failure: null,
    sessions: {},
    dispatches: [],
    observations: [],
    effects: [],
    recovery: [],
    assertions: {},
  };
}

function fail(workflow, step, reason, details = {}) {
  if (!workflow.failure) workflow.failure = { step, reason, ...safeSummary(details) };
}

async function startSession(client, workflow, name, url) {
  const result = await client.tool("browser.session.start", { url });
  const data = resultData(result);
  workflow.sessions[name] = {
    sessionId: data?.sessionId ?? null,
    pageId: data?.page?.pageId ?? null,
    mode: data?.mode ?? null,
    nextCommandId: Number(data?.nextCommandId ?? 1),
    startResponse: safeSummary(data ?? result.error),
  };
  workflow.observations.push({ step: `session ${name} start`, response: safeSummary(data ?? result.error) });
  if (!result.ok || !data?.sessionId || !data?.page?.pageId) {
    fail(workflow, `browser.session.start ${name}`, "Owned session did not return sessionId and pageId", { error: errorDetails(result), response: data });
    return null;
  }
  return data;
}

async function observeControls(client, workflow, name, label) {
  const session = workflow.sessions[name];
  const result = await client.tool("browser.observe", {
    sessionId: session.sessionId,
    pageId: session.pageId,
    mode: "controls",
    maxBytes: 16384,
    timeoutMs: 45000,
  });
  workflow.observations.push({ step: label, session: name, kind: "controls", response: safeSummary(result.data ?? result.error) });
  return result;
}

async function readFixture(client, workflow, name, label) {
  const session = workflow.sessions[name];
  const result = await client.tool("browser.document.read", { sessionId: session.sessionId, maxBytes: 8192, timeoutMs: 45000 });
  const text = result.ok ? visibleText(result.data) : "";
  workflow.observations.push({ step: label, session: name, kind: "document", response: safeSummary(result.data ?? result.error) });
  workflow.effects.push({ step: label, session: name, visibleFixtureText: clip(text, 1800) });
  return { result, text };
}

async function act(client, workflow, name, label, action, timeoutMs = NORMAL_TIMEOUT_MS) {
  const session = workflow.sessions[name];
  const commandId = session.nextCommandId++;
  const result = await client.tool("browser.act", {
    sessionId: session.sessionId,
    command: {
      commandId,
      pageId: session.pageId,
      action,
      observe: "local",
      maxBytes: 16384,
      timeoutMs: Math.min(timeoutMs, 120000),
    },
  }, timeoutMs);
  const data = resultData(result);
  if (data?.nextCommandId) session.nextCommandId = Number(data.nextCommandId);
  if (data?.page?.pageId) session.pageId = data.page.pageId;
  workflow.dispatches.push({
    label,
    session: name,
    commandId,
    action: safeSummary(action),
    protocolOk: result.ok,
    receiptOrDispatch: safeSummary(data ?? result.error),
  });
  return { result, commandId, data };
}

async function stopSession(client, workflow, name) {
  const session = workflow.sessions[name];
  if (!session?.sessionId) return null;
  const result = await client.tool("browser.session.stop", { sessionId: session.sessionId });
  workflow.observations.push({ step: `session ${name} stop`, session: name, response: safeSummary(result.data ?? result.error) });
  return result;
}

async function runConcurrency(client, fixtureUrl) {
  const workflow = workflowRecord();
  try {
    await Promise.all([
      startSession(client, workflow, "A", fixtureUrl),
      startSession(client, workflow, "B", fixtureUrl),
    ]);
    if (!workflow.sessions.A?.sessionId || !workflow.sessions.B?.sessionId) return workflow;
    const [aControls, bControls] = await Promise.all([
      observeControls(client, workflow, "A", "initial controls A"),
      observeControls(client, workflow, "B", "initial controls B"),
    ]);
    const aRef = findValueRef(aControls.data);
    const bRef = findValueRef(bControls.data);
    workflow.assertions.initialRefs = { A: aRef, B: bRef };
    if (!aRef || !bRef) {
      fail(workflow, "initial controls", "Fixture value textbox refs were not returned", { A: aControls.data, B: bControls.data });
      return workflow;
    }
    const [aInitial, bInitial] = await Promise.all([
      act(client, workflow, "A", "initial edit A", { kind: "fill", target: { kind: "ref", ref: aRef }, value: "alpha-initial" }),
      act(client, workflow, "B", "initial edit B", { kind: "fill", target: { kind: "ref", ref: bRef }, value: "bravo-initial" }),
    ]);
    workflow.assertions.initialDispatches = { A: aInitial.result.ok, B: bInitial.result.ok };
    const [aInitialRead, bInitialRead] = await Promise.all([
      readFixture(client, workflow, "A", "read after initial edit A"),
      readFixture(client, workflow, "B", "read after initial edit B"),
    ]);
    workflow.assertions.isolatedInitialEdits = {
      AContainsOwn: /alpha-initial/.test(aInitialRead.text),
      AExcludesB: !/bravo-initial/.test(aInitialRead.text),
      BContainsOwn: /bravo-initial/.test(bInitialRead.text),
      BExcludesA: !/alpha-initial/.test(bInitialRead.text),
    };
    if (!workflow.assertions.initialDispatches.A || !workflow.assertions.initialDispatches.B || !Object.values(workflow.assertions.isolatedInitialEdits).every(Boolean)) {
      fail(workflow, "isolated initial edits", "Distinct session-local values were not independently visible", { A: aInitialRead.text, B: bInitialRead.text });
      return workflow;
    }

    const waitAction = {
      kind: "wait_for",
      waitFor: { selector: "#never-appears", state: "visible", timeoutMs: 120000 },
    };
    const waitCommandId = workflow.sessions.A.nextCommandId;
    const waitPromise = act(client, workflow, "A", "pending explicit wait A", waitAction, WAIT_TIMEOUT_MS);
    const pendingStatusPromise = client.tool("browser.command", {
      sessionId: workflow.sessions.A.sessionId,
      commandId: waitCommandId,
    });

    const bDuringWait = await act(client, workflow, "B", "edit B while A waits", { kind: "fill", target: { kind: "selector", selector: "#value" }, value: "bravo-while-A-waits" });
    const bDuringWaitRead = await readFixture(client, workflow, "B", "read B while A waits");
    workflow.assertions.bProgressWhileAWaits = bDuringWait.result.ok && /bravo-while-A-waits/.test(bDuringWaitRead.text);
    if (!workflow.assertions.bProgressWhileAWaits) {
      fail(workflow, "B while A waits", "B did not complete an edit/read while A had a pending wait", { dispatch: bDuringWait.data, read: bDuringWaitRead.text });
    }

    const cancelPromise = client.tool("browser.command", {
      sessionId: workflow.sessions.A.sessionId,
      commandId: waitCommandId,
      cancel: true,
    });
    const [pendingStatus, cancel] = await Promise.all([pendingStatusPromise, cancelPromise]);
    const pendingData = resultData(pendingStatus);
    workflow.recovery.push({ step: "pending wait status A", session: "A", commandId: waitCommandId, response: safeSummary(pendingData ?? pendingStatus.error) });
    const pendingFacts = JSON.stringify(pendingData ?? "");
    workflow.assertions.waitPendingObserved = /running|queued|pending|active/i.test(pendingFacts);
    if (!workflow.assertions.waitPendingObserved) {
      fail(workflow, "pending wait status A", "The explicit wait was not observed in a pending command state", { commandId: waitCommandId, response: pendingData });
    }
    workflow.recovery.push({ step: "cancel pending wait A", session: "A", commandId: waitCommandId, response: safeSummary(cancel.data ?? cancel.error) });
    const waitResult = await waitPromise;
    const waitData = waitResult.data;
    workflow.recovery.push({ step: "cancelled wait result A", session: "A", commandId: waitCommandId, response: safeSummary(waitData ?? waitResult.result?.error) });
    const waitFacts = JSON.stringify(waitData ?? "");
    workflow.assertions.cancelledWait = waitResult.result?.ok === true && /cancel|abort|stopped/i.test(waitFacts);
    workflow.assertions.noInputFacts = waitData?.dispatch === "not_started" || waitData?.steps?.every((step) => step?.dispatch === "not_started");
    if (!workflow.assertions.cancelledWait || !workflow.assertions.noInputFacts) {
      fail(workflow, "cancelled wait facts A", "Cancelled wait did not report cancellation with no input dispatch", { cancel: cancel.data, wait: waitData });
    }

    const aAfterCancel = await act(client, workflow, "A", "edit A after cancelled wait", { kind: "fill", target: { kind: "selector", selector: "#value" }, value: "alpha-after-cancel" });
    const aAfterCancelRead = await readFixture(client, workflow, "A", "read A after cancelled wait");
    workflow.assertions.aRecoversAfterCancel = aAfterCancel.result.ok && /alpha-after-cancel/.test(aAfterCancelRead.text);
    if (!workflow.assertions.aRecoversAfterCancel) {
      fail(workflow, "A edit after cancelled wait", "A did not accept a subsequent edit/read", { dispatch: aAfterCancel.data, read: aAfterCancelRead.text });
    }

    const stopA = await stopSession(client, workflow, "A");
    workflow.assertions.aStopped = stopA?.ok === true;
    const sessionsAfterAStop = await client.tool("browser.sessions.list", {});
    workflow.observations.push({ step: "sessions after stopping A", response: safeSummary(sessionsAfterAStop.data ?? sessionsAfterAStop.error) });
    const bAfterStop = await act(client, workflow, "B", "edit B after A stopped", { kind: "fill", target: { kind: "selector", selector: "#value" }, value: "bravo-after-A-stop" });
    const bAfterStopRead = await readFixture(client, workflow, "B", "read B after A stopped");
    workflow.assertions.bSurvivesAStop = bAfterStop.result.ok && /bravo-after-A-stop/.test(bAfterStopRead.text);
    workflow.effects.push({ step: "post-stop B effect", session: "B", visibleFixtureText: clip(bAfterStopRead.text, 1800) });
    if (!workflow.assertions.aStopped || !workflow.assertions.bSurvivesAStop) {
      fail(workflow, "B after A stop", "B did not remain usable after A stopped", { stopA: stopA?.data, sessions: sessionsAfterAStop.data, dispatch: bAfterStop.data, read: bAfterStopRead.text });
    }
    workflow.success = workflow.failure === null && Object.values(workflow.assertions).every((value) => value === true || (typeof value === "object" && Object.values(value).every(Boolean)));
    return workflow;
  } catch (error) {
    fail(workflow, "unexpected", error.message);
    return workflow;
  }
}

async function main() {
  const artifact = path.resolve(argValue("artifact", DEFAULT_ARTIFACT));
  const evidencePath = path.resolve(argValue("output", DEFAULT_EVIDENCE_PATH));
  const expectedSha256 = argValue("expected-sha256", DEFAULT_EXPECTED_SHA256).toUpperCase();
  const runStarted = performance.now();
  const startedAt = nowIso();
  const sourceStat = await stat(artifact);
  const sourceBefore = await sha256(artifact);
  if (sourceBefore !== expectedSha256) throw new Error(`Frozen artifact hash mismatch: expected ${expectedSha256}, got ${sourceBefore}`);
  const qaRoot = await mkdtemp(path.join(tmpdir(), "newton-packed-concurrency-"));
  const artifactRoot = path.join(qaRoot, "artifact");
  const fixtureRoot = path.join(qaRoot, "fixture");
  const sessionRootA = path.join(qaRoot, "session-a");
  const sessionRootB = path.join(qaRoot, "session-b");
  await Promise.all([mkdir(artifactRoot), mkdir(fixtureRoot), mkdir(sessionRootA), mkdir(sessionRootB)]);
  const copiedArtifact = path.join(artifactRoot, "newton-browser-0.6.4.tgz");
  await copyFile(artifact, copiedArtifact);
  const copiedBefore = await sha256(copiedArtifact);
  if (copiedBefore !== expectedSha256) throw new Error(`Copied artifact hash mismatch: expected ${expectedSha256}, got ${copiedBefore}`);
  const extraction = spawnSync("tar", ["-xzf", copiedArtifact, "-C", artifactRoot], { encoding: "utf8", windowsHide: true });
  if (extraction.status !== 0) throw new Error(`Artifact extraction failed: ${extraction.stderr || extraction.stdout}`);
  const entry = path.join(artifactRoot, "package", "dist", "index.js");
  const evidence = {
    schemaVersion: 1,
    qaType: "SCRIPTED packed concurrency QA",
    startedAt,
    finishedAt: null,
    totalElapsedMs: null,
    artifact: {
      sourcePath: artifact,
      copiedPath: copiedArtifact,
      version: "0.6.4",
      bytes: sourceStat.size,
      expectedSha256,
      sourceSha256Before: sourceBefore,
      copiedSha256Before: copiedBefore,
      sourceSha256After: null,
      copiedSha256After: null,
      immutable: false,
      disposableRoots: { qaRoot, artifactRoot, fixtureRoot, sessionA: sessionRootA, sessionB: sessionRootB },
      entry,
    },
    runtime: {
      node: process.version,
      browserMode: "owned isolated browser sessions requested by browser.session.start",
      browserVersion: "not exposed by the public MCP response",
    },
    fixture: {
      url: null,
      route: "/fixture.html",
      stateModel: "session-local DOM input and output; no cookies, storage, profile reads, or external writes",
    },
    catalog: null,
    calls: [],
    workflow: null,
    cleanup: { sessions: [], process: "pending", fixture: "pending" },
    notes: [
      "Scripted packed workflow QA, not a model-turn or ChatGPT parity benchmark.",
      "Receipt dispatch, pending/cancellation facts, visible fixture effects, and failures are recorded separately.",
      "The browser is operated only through the copied frozen tarball's stdio MCP entrypoint.",
    ],
    pathNormalization: "Repo paths serialize as <workspace>/relative/path; owned temporary paths serialize as <qa-temp>/relative/path.",
  };
  const server = createServer((request, response) => {
    if (request.url === "/fixture.html" || request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(fixtureHtml);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const fixtureUrl = `http://127.0.0.1:${address.port}/fixture.html`;
  evidence.fixture.url = fixtureUrl;
  const client = new PackedMcpClient(entry, evidence);
  try {
    const catalog = await client.request("tools/list", {});
    const tools = catalog.data?.tools ?? [];
    evidence.catalog = { responseBytes: catalog.record.responseBytes, tools: tools.map((tool) => tool.name) };
    const required = ["browser.session.start", "browser.act", "browser.observe", "browser.document.read", "browser.command", "browser.sessions.list", "browser.session.stop"];
    const missing = required.filter((tool) => !evidence.catalog.tools.includes(tool));
    evidence.catalog.missingRequiredTools = missing;
    if (!catalog.ok || missing.length > 0) throw new Error(`Packed catalog missing concurrency tools: ${missing.join(", ")}`);
    evidence.workflow = await runConcurrency(client, fixtureUrl);
    await stopSession(client, evidence.workflow, "B");
    evidence.cleanup.sessions = Object.entries(evidence.workflow.sessions).map(([name, session]) => ({ name, sessionId: session.sessionId, stopped: evidence.workflow.observations.some((item) => item.step === `session ${name} stop`) }));
  } finally {
    await client.close();
    evidence.cleanup.process = "closed";
    await new Promise((resolve) => server.close(resolve));
    evidence.cleanup.fixture = "closed";
    evidence.artifact.sourceSha256After = await sha256(artifact);
    evidence.artifact.copiedSha256After = await sha256(copiedArtifact);
    evidence.artifact.immutable = evidence.artifact.sourceSha256Before === evidence.artifact.sourceSha256After && evidence.artifact.copiedSha256Before === evidence.artifact.copiedSha256After;
    evidence.runtime.stderrTail = clip(client.stderr, 4000);
    evidence.finishedAt = nowIso();
    evidence.totalElapsedMs = Math.round(performance.now() - runStarted);
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await import("node:fs/promises").then(({ writeFile }) => writeFile(evidencePath, `${JSON.stringify(normalizeForSerialization(evidence), null, 2)}\n`, "utf8"));
    await rm(qaRoot, { recursive: true, force: true });
  }
  console.log(JSON.stringify(normalizeForSerialization({
    evidencePath,
    artifact: evidence.artifact,
    catalog: evidence.catalog,
    workflow: { success: evidence.workflow?.success, failure: evidence.workflow?.failure, assertions: evidence.workflow?.assertions },
    calls: evidence.calls.length,
    totalElapsedMs: evidence.totalElapsedMs,
  }), null, 2));
  if (!evidence.artifact.immutable || !evidence.workflow?.success) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
