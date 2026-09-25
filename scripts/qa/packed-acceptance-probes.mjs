import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {getEncoding} from 'js-tiktoken';

const outputTokenizer=getEncoding('o200k_base');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ARTIFACT = path.join(ROOT, "artifacts", "newton-browser-0.6.4.tgz");
const PROTOCOL_VERSION = "2026-07-28";
const CLIENT_INFO = { name: "packed-acceptance-probes", version: "1.0.0" };
const MAX_TEXT = 1200;
const MCP_TIMEOUT_MS = 60_000;

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function clip(value, max = MAX_TEXT) {
  if (typeof value !== "string") return value;
  return value.length <= max ? value : `${value.slice(0, max)}...[truncated ${value.length - max} chars]`;
}

function safeSummary(value, depth = 0) {
  if (depth > 4) return "[depth limited]";
  if (typeof value === "string") return clip(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => safeSummary(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [key, safeSummary(item, depth + 1)]));
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
  const bytes = await readFile(file);
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function jsonLineBytes(value) {
  return Buffer.byteLength(JSON.stringify(value) + "\n", "utf8");
}

function nodesOf(value) {
  const observation = value?.observation ?? value?.data?.observation ?? value;
  return Array.isArray(observation?.nodes) ? observation.nodes : [];
}

function findNode(value, predicate) {
  return nodesOf(value).find(predicate) ?? null;
}

function nodeText(node) {
  return [node?.name, node?.text, node?.value, node?.href].filter((item) => typeof item === "string").join(" ");
}

function urlsOf(value) {
  const urls = [];
  const visit = (item, key = "") => {
    if (typeof item === "string" && (key === "url" || key === "href" || item.startsWith("http://") || item.startsWith("https://"))) {
      urls.push(item);
      return;
    }
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child, key);
      return;
    }
    for (const [childKey, child] of Object.entries(item)) visit(child, childKey);
  };
  visit(value);
  return [...new Set(urls)];
}

function observationUrl(value) {
  const observation = value?.observation ?? value?.data?.observation ?? value;
  return typeof observation?.url === "string" ? observation.url : null;
}

function inlineDocumentLinkDestinations(text) {
  const urls = [];
  if (typeof text !== "string") return urls;
  for (const match of text.matchAll(/<((?:https?):\/\/[^<>\s]+)>/gi)) {
    try {
      const parsed = new URL(match[1]);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") urls.push(parsed.href);
    } catch {
      // Ignore malformed angle-bracket destinations.
    }
  }
  return urls;
}

function documentLinkDestinations(chunkTexts) {
  const urls = new Set();
  const add = (text) => { for (const url of inlineDocumentLinkDestinations(text)) urls.add(url); };
  for (let index = 0; index < chunkTexts.length; index += 1) {
    add(chunkTexts[index]);
    if (index + 1 < chunkTexts.length) add(`${chunkTexts[index]}${chunkTexts[index + 1]}`);
  }
  return [...urls];
}

function textOf(value) {
  const chunks = [];
  const visit = (item, key = "") => {
    if (typeof item === "string" && ["text", "name", "title", "value"].includes(key)) chunks.push(item);
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child, key);
      return;
    }
    for (const [childKey, child] of Object.entries(item)) visit(child, childKey);
  };
  visit(value);
  return chunks.join(" ");
}

const MUTATING_ACTION_KINDS = new Set([
  "click", "fill", "type", "select", "clear", "set_files", "press", "scroll",
  "navigate", "back", "forward", "reload", "dialog_accept", "dialog_dismiss", "sequence",
]);
const INTRINSIC_POSTCONDITION_ACTION_KINDS = new Set(["fill", "type", "clear", "select"]);

function opaqueToken(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try { return JSON.stringify(value); } catch { return ""; }
}

function actionFailureReason(result, fallback = "Action receipt did not complete") {
  const error = result?.error;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") return error.message ?? error.reason ?? error.code ?? fallback;
  const receipt = result?.data;
  if (receipt?.errorCode) return receipt.errorCode;
  if (receipt?.reason && receipt.reason !== "completed") return `action_${receipt.reason}`;
  return fallback;
}

function inspectActionReceipt(data, action) {
  const receipt = data && typeof data === "object" ? data : null;
  if (!receipt) return { ok: false, code: "missing_action_receipt", reason: "Missing browser action receipt", receipt: safeSummary(data) };
  if (receipt.state !== "finished") return { ok: false, code: "action_not_finished", reason: `Action state was ${String(receipt.state ?? "missing")}`, receipt: safeSummary(receipt) };
  if (receipt.reason !== "completed") return { ok: false, code: receipt.errorCode ?? "action_not_completed", reason: `Action reason was ${String(receipt.reason ?? "missing")}`, receipt: safeSummary(receipt) };
  if (receipt.errorCode) return { ok: false, code: receipt.errorCode, reason: `Action returned ${receipt.errorCode}`, receipt: safeSummary(receipt) };
  const steps = Array.isArray(receipt.steps) ? receipt.steps : [];
  const failedStep = steps.find((step) => step?.errorCode || ["rejected", "failed", "timed_out"].includes(step?.reason));
  if (failedStep) return { ok: false, code: failedStep.errorCode ?? "action_step_failed", reason: `Action step was ${String(failedStep.reason ?? "failed")}`, receipt: safeSummary(receipt) };
  const expectsMet = action?.kind === "wait_for"
    || action?.waitFor !== undefined
    || INTRINSIC_POSTCONDITION_ACTION_KINDS.has(action?.kind);
  if (MUTATING_ACTION_KINDS.has(action?.kind) && receipt.dispatch !== "acknowledged") {
    return { ok: false, code: "dispatch_not_acknowledged", reason: `Mutating action dispatch was ${String(receipt.dispatch ?? "missing")}`, receipt: safeSummary(receipt) };
  }
  const postconditionState = receipt.postcondition?.state;
  if (!["met", "not_requested"].includes(postconditionState)) {
    return { ok: false, code: "invalid_postcondition_state", reason: `Action postcondition was ${String(postconditionState ?? "missing")}`, receipt: safeSummary(receipt) };
  }
  if (expectsMet && postconditionState !== "met") {
    return { ok: false, code: "postcondition_not_met", reason: `Expected postcondition met, got ${String(postconditionState ?? "missing")}`, receipt: safeSummary(receipt) };
  }
  return { ok: true, receipt: safeSummary(receipt) };
}

function dataFromToolMessage(message) {
  if (message?.error) return { ok: false, error: safeSummary(message.error) };
  const result = message?.result ?? {};
  if (result.isError === true) return { ok: false, resultType: result.resultType, error: safeSummary(result.content ?? result) };
  const textBlock = Array.isArray(result.content) ? result.content.find((item) => item?.type === "text") : null;
  if (!textBlock) return { ok: true, resultType: result.resultType, data: result };
  try {
    return { ok: true, resultType: result.resultType, data: JSON.parse(textBlock.text) };
  } catch {
    return { ok: true, resultType: result.resultType, data: { text: textBlock.text } };
  }
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

  async request(method, params, callInfo = {}) {
    const id = this.nextId++;
    const wireParams = {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
      },
      ...params,
    };
    const wire = { jsonrpc: "2.0", id, method, params: wireParams };
    const requestBytes = jsonLineBytes(wire);
    const started = performance.now();
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP timeout method=${method} id=${id}`));
      }, MCP_TIMEOUT_MS);
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
    // Measure full returned text before evidence clipping. Wire JSON escaping and
    // harness summaries are not the text a model reads. Catalog is counted separately.
    const blocks=response.message.result?.content;
    const outputTexts=Array.isArray(blocks)?blocks.filter(block=>block.type==='text'&&typeof block.text==='string').map(block=>block.text):[];
    const outputTextTokens=outputTexts.reduce((total,text)=>total+outputTokenizer.encode(text).length,0);
    const catalogTokens=method==='tools/list'?outputTokenizer.encode(JSON.stringify(response.message.result?.tools??[])).length:0;
    const decoded = dataFromToolMessage(response.message);
    const record = {
      sequence: this.evidence.calls.length + 1,
      method,
      tool: params?.name ?? null,
      arguments: safeSummary(params?.arguments ?? null),
      requestBytes,
      responseBytes: response.responseBytes,
      outputTextTokens,
      catalogTokens,
      elapsedMs,
      transportOk: true,
      resultType: decoded.resultType ?? null,
      protocolOk: decoded.ok,
      response: safeSummary(decoded.data ?? decoded.error),
    };
    this.evidence.calls.push(record);
    return { ...decoded, record };
  }

  async tool(name, args) {
    try {
      return await this.request("tools/call", { name, arguments: args });
    } catch (error) {
      const record = {
        sequence: this.evidence.calls.length + 1,
        method: "tools/call",
        tool: name,
        arguments: safeSummary(args),
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

function workflowRecord(name, url) {
  return {
    name,
    startUrl: url,
    success: false,
    failure: null,
    sessionId: null,
    pageId: null,
    mode: null,
    browserVersion: "not exposed by the public MCP response",
    dispatches: [],
    observations: [],
    visibleEvidence: [],
    recovery: [],
  };
}

function fail(workflow, step, reason, details = {}) {
  if (!workflow.failure) workflow.failure = { step, reason, ...safeSummary(details) };
  return false;
}

function sessionData(result) {
  return result?.ok ? result.data : null;
}

async function startSession(client, workflow) {
  const result = await client.tool("browser.session.start", { url: workflow.startUrl });
  if (!result.ok) {
    fail(workflow, "browser.session.start", "MCP call failed", { error: result.error });
    return null;
  }
  const data = sessionData(result);
  workflow.sessionId = data?.sessionId ?? null;
  workflow.pageId = data?.page?.pageId ?? null;
  workflow.mode = data?.mode ?? null;
  workflow.observations.push({ step: "browser.session.start", response: safeSummary(data) });
  if (!workflow.sessionId || !workflow.pageId) {
    fail(workflow, "browser.session.start", "No sessionId/pageId returned", { response: data });
    return null;
  }
  return data;
}

async function observeControls(client, workflow, step) {
  const result = await client.tool("browser.observe", {
    sessionId: workflow.sessionId,
    pageId: workflow.pageId,
    mode: "controls",
    maxBytes: 16384,
    timeoutMs: 45000,
  });
  workflow.observations.push({ step, kind: "controls", response: safeSummary(result.data ?? result.error) });
  if (!result.ok) return result;
  const observation = result.data?.observation ?? result.data;
  if (!observation || !["available", "incomplete"].includes(observation.state)) {
    return {
      ...result,
      ok: false,
      error: {
        code: "observation_unavailable",
        reason: `Controls observation was ${String(observation?.state ?? "missing")}`,
        observation: safeSummary(observation),
      },
    };
  }
  return result;
}

async function listPages(client, workflow, step) {
  const result = await client.tool("browser.pages.list", { sessionId: workflow.sessionId });
  workflow.observations.push({ step, kind: "pages", response: safeSummary(result.data ?? result.error) });
  const pages = result.data?.pages;
  if (Array.isArray(pages)) {
    const selected = pages.find((page) => page.pageId === workflow.pageId) ?? pages[0];
    if (selected?.pageId) workflow.pageId = selected.pageId;
    return { result, pages };
  }
  return { result, pages: [] };
}

async function act(client, workflow, label, action) {
  const commandId = workflow.nextCommandId++;
  const result = await client.tool("browser.act", {
    sessionId: workflow.sessionId,
    command: {
      commandId,
      pageId: workflow.pageId,
      action,
      observe: "local",
      maxBytes: 16384,
      timeoutMs: 45000,
    },
  });
  const receiptCheck = result.ok
    ? inspectActionReceipt(result.data, action)
    : { ok: false, code: "transport_or_protocol_failure", reason: actionFailureReason(result, "MCP action call failed"), receipt: safeSummary(result.error) };
  workflow.dispatches.push({
    label,
    commandId,
    protocolOk: result.ok,
    receiptAccepted: receiptCheck.ok,
    receiptFailure: receiptCheck.ok ? null : { code: receiptCheck.code, reason: receiptCheck.reason },
    receiptOrDispatch: safeSummary(result.data ?? result.error),
  });
  if (!result.ok || !receiptCheck.ok) {
    const recovery = await client.tool("browser.command", {
      sessionId: workflow.sessionId,
      commandId,
    });
    const recoveryCheck = recovery.ok
      ? inspectActionReceipt(recovery.data, action)
      : { ok: false, code: "recovery_call_failed", reason: actionFailureReason(recovery, "Recovery call failed"), receipt: safeSummary(recovery.error) };
    workflow.recovery.push({
      label,
      commandId,
      receiptAccepted: recoveryCheck.ok,
      receiptFailure: recoveryCheck.ok ? null : { code: recoveryCheck.code, reason: recoveryCheck.reason },
      response: safeSummary(recovery.data ?? recovery.error),
    });
  }
  if (!result.ok) return result;
  if (!receiptCheck.ok) {
    return {
      ...result,
      ok: false,
      error: {
        code: receiptCheck.code,
        reason: receiptCheck.reason,
        receipt: receiptCheck.receipt,
      },
    };
  }
  return result;
}

function linksMatching(value, predicate) {
  return nodesOf(value)
    .filter((node) => node?.role === "link" && typeof node?.href === "string" && predicate(node))
    .map((node) => ({ name: node.name ?? "", href: node.href, ref: node.ref ?? null }));
}

async function runWikipedia(client) {
  const workflow = workflowRecord("wikipedia-search-open-read", "https://www.wikipedia.org/");
  try {
    const started = await startSession(client, workflow);
    if (!started) return workflow;
    workflow.nextCommandId = Number(started.nextCommandId ?? 1);
    const search = findNode(started, (node) => node?.role === "searchbox" && /search/i.test(nodeText(node)));
    if (!search?.ref) {
      fail(workflow, "initial observation", "Wikipedia searchbox ref was not returned", { nodes: nodesOf(started).slice(0, 60) });
      return workflow;
    }
    const fill = await act(client, workflow, "fill Wikipedia searchbox", {
      kind: "fill",
      target: { kind: "ref", ref: search.ref },
      value: "Ada Lovelace",
    });
    if (!fill.ok) {
      fail(workflow, "fill Wikipedia searchbox", actionFailureReason(fill), { response: fill.error ?? fill.data });
      return workflow;
    }
    const afterFill = await observeControls(client, workflow, "after fill Wikipedia searchbox");
    if (!afterFill.ok) {
      fail(workflow, "after fill Wikipedia searchbox", "Postcondition observation failed", { response: afterFill.error });
      return workflow;
    }
    const wait = await act(client, workflow, "wait for Wikipedia search suggestion", {
      kind: "wait_for",
      waitFor: { text: "Ada Lovelace", timeoutMs: 45000 },
    });
    if (!wait.ok) {
      fail(workflow, "wait for Wikipedia search suggestion", actionFailureReason(wait), { response: wait.error ?? wait.data });
      return workflow;
    }
    const afterSearch = await observeControls(client, workflow, "after Wikipedia search suggestion");
    if (!afterSearch.ok) {
      fail(workflow, "after Wikipedia search", "Postcondition observation failed", { response: afterSearch.error });
      return workflow;
    }
    const resultLinks = linksMatching(afterSearch.data, (node) => /en\.wikipedia\.org\/wiki\//.test(node.href) && !/Special:|Help:|File:/.test(node.href));
    workflow.visibleEvidence.push({ step: "Wikipedia search results", links: resultLinks.slice(0, 12) });
    const articleLink = resultLinks.find((link) => /^https:\/\/en\.wikipedia\.org\/wiki\/Ada_Lovelace(?:#.*)?$/i.test(link.href) && /Ada Lovelace/i.test(link.name));
    if (!articleLink?.ref) {
      fail(workflow, "Wikipedia search results", "No returned article link ref matched Ada Lovelace", { links: resultLinks });
      return workflow;
    }
    const click = await act(client, workflow, "open returned Wikipedia result", {
      kind: "click",
      target: { kind: "ref", ref: articleLink.ref },
      waitFor: { text: "Countess of Lovelace", timeoutMs: 45000 },
    });
    if (!click.ok) {
      fail(workflow, "open returned Wikipedia result", actionFailureReason(click), { response: click.error ?? click.data });
      return workflow;
    }
    const afterOpen = await observeControls(client, workflow, "after opening Wikipedia result");
    if (!afterOpen.ok) {
      fail(workflow, "after opening Wikipedia result", "Postcondition observation failed", { response: afterOpen.error });
      return workflow;
    }
    const observedUrl = observationUrl(afterOpen.data);
    const document = await client.tool("browser.document.read", { sessionId: workflow.sessionId, maxBytes: 16384, timeoutMs: 45000 });
    workflow.observations.push({ step: "Wikipedia article document.read", kind: "document", response: safeSummary(document.data ?? document.error) });
    const articleText = textOf(document.data);
    const visibleText = textOf(afterOpen.data);
    workflow.visibleEvidence.push({
      step: "Wikipedia article evidence",
      clickedSuggestionHref: articleLink.href,
      destinationEvidenceSource: "post-click browser.observe observation.url",
      observedUrl,
      visibleText: clip(visibleText, 1600),
      documentText: clip(articleText, 2400),
    });
    if (!observedUrl || !/^https:\/\/en\.wikipedia\.org\/wiki\/Ada_Lovelace(?:#.*)?$/i.test(observedUrl)) {
      fail(workflow, "Wikipedia article destination", "Post-click observation.url did not show the Ada Lovelace destination URL", { observedUrl, clickedSuggestionHref: articleLink.href });
      return workflow;
    }
    if (!/Ada Lovelace/i.test(articleText) || !/Countess of Lovelace/i.test(articleText)) {
      fail(workflow, "Wikipedia article read", "Post-click document did not independently identify the Ada Lovelace article body", { observedUrl, clickedSuggestionHref: articleLink.href, articleText: clip(articleText) });
      return workflow;
    }
    workflow.success = true;
    return workflow;
  } catch (error) {
    fail(workflow, "unexpected", error.message);
    return workflow;
  }
}

async function runGitHub(client) {
  const workflow = workflowRecord("github-issues-filter-read", "https://github.com/microsoft/vscode/issues");
  try {
    const started = await startSession(client, workflow);
    if (!started) return workflow;
    workflow.nextCommandId = Number(started.nextCommandId ?? 1);
    const filter = findNode(started, (node) => ["searchbox", "textbox", "combobox"].includes(node?.role) && /search|filter|issue/i.test(nodeText(node)));
    if (!filter?.ref) {
      fail(workflow, "initial observation", "GitHub issue filter/search ref was not returned", { nodes: nodesOf(started).slice(0, 100) });
      return workflow;
    }
    const query = "is:issue is:open label:bug";
    const fill = await act(client, workflow, "fill GitHub issue filter", {
      kind: "fill",
      target: { kind: "ref", ref: filter.ref },
      value: query,
    });
    if (!fill.ok) {
      fail(workflow, "fill GitHub issue filter", actionFailureReason(fill), { response: fill.error ?? fill.data });
      return workflow;
    }
    const afterFill = await observeControls(client, workflow, "after fill GitHub issue filter");
    if (!afterFill.ok) {
      fail(workflow, "after fill GitHub issue filter", "Postcondition observation failed", { response: afterFill.error });
      return workflow;
    }
    const refreshedFilter = findNode(afterFill.data, (node) => ["searchbox", "textbox", "combobox"].includes(node?.role) && /search|filter|issue/i.test(nodeText(node)));
    if (!refreshedFilter?.ref) {
      fail(workflow, "after fill GitHub issue filter", "Fresh GitHub issue filter ref was not returned", { nodes: nodesOf(afterFill.data).slice(0, 100) });
      return workflow;
    }
    const press = await act(client, workflow, "press Enter for GitHub issue filter", {
      kind: "press",
      target: { kind: "ref", ref: refreshedFilter.ref },
      keys: ["Enter"],
    });
    if (!press.ok) {
      fail(workflow, "press Enter for GitHub issue filter", actionFailureReason(press), { response: press.error ?? press.data });
      return workflow;
    }
    const waitForFilteredUrl = await act(client, workflow, "wait for GitHub filtered URL", {
      kind: "wait_for",
      waitFor: { url: "label%3Abug", timeoutMs: 45000 },
    });
    if (!waitForFilteredUrl.ok) {
      fail(workflow, "wait for GitHub filtered URL", actionFailureReason(waitForFilteredUrl), { response: waitForFilteredUrl.error ?? waitForFilteredUrl.data });
      return workflow;
    }
    const afterFilter = await observeControls(client, workflow, "after GitHub issue filter");
    if (!afterFilter.ok) {
      fail(workflow, "after GitHub issue filter", "Postcondition observation failed", { response: afterFilter.error });
      return workflow;
    }
    const observedUrl = observationUrl(afterFilter.data);
    let submittedQuery = null;
    try { submittedQuery = observedUrl ? new URL(observedUrl).searchParams.get("q") : null; } catch { submittedQuery = null; }
    const issueLinks = linksMatching(afterFilter.data, (node) => /github\.com\/microsoft\/vscode\/issues\/\d+/.test(node.href) && !/\/issues\/new/.test(node.href));
    const rows = issueLinks.slice(0, 20).map((link) => ({ ...link, visibleText: link.name }));
    const queryObserved = submittedQuery === query;
    workflow.visibleEvidence.push({
      step: "GitHub filtered issue rows",
      query,
      observedUrl,
      submittedQuery,
      queryObserved,
      rows,
      visibleText: clip(textOf(afterFilter.data), 2400),
    });
    if (!queryObserved) {
      fail(workflow, "GitHub filtered query", "Requested issue filter was not observed in the submitted URL query", { query, observedUrl, submittedQuery });
      return workflow;
    }
    if (rows.length === 0) {
      fail(workflow, "GitHub filtered issue rows", "No visible filtered issue rows/links were returned", { observedUrl });
      return workflow;
    }
    if (!observedUrl || !/^https:\/\/github\.com\/microsoft\/vscode\/issues(?:[/?#]|$)/i.test(observedUrl)) {
      fail(workflow, "GitHub filtered destination", "Filtered issue destination was not visibly observed in observation.url", { observedUrl });
      return workflow;
    }
    workflow.success = true;
    return workflow;
  } catch (error) {
    fail(workflow, "unexpected", error.message);
    return workflow;
  }
}

async function runDocumentation(client) {
  const workflow = workflowRecord("w3c-html-documentation-continuations", "https://www.w3.org/TR/html52/");
  try {
    const started = await startSession(client, workflow);
    if (!started) return workflow;
    const controls = await observeControls(client, workflow, "documentation page controls");
    if (!controls.ok) {
      fail(workflow, "documentation page controls", "Documentation controls observation failed", { response: controls.error ?? controls.data });
      return workflow;
    }
    const first = await client.tool("browser.document.read", { sessionId: workflow.sessionId, maxBytes: 4096, timeoutMs: 45000 });
    workflow.observations.push({ step: "documentation first chunk", kind: "document", response: safeSummary(first.data ?? first.error) });
    if (!first.ok) {
      fail(workflow, "browser.document.read", "Initial document read failed", { response: first.error });
      return workflow;
    }
    const chunks = [];
    const documentChunkTexts = [];
    let current = first.data;
    let currentObservation = current?.observation ?? current;
    let cursor = currentObservation?.cursor ?? current?.cursor ?? current?.nextCursor ?? null;
    let chunkIndex = 0;
    while (current && chunkIndex < 6) {
      currentObservation = current?.observation ?? current;
      const chunkText = currentObservation?.text ?? currentObservation?.content ?? currentObservation?.documentText ?? "";
      const normalized = typeof chunkText === "string" ? chunkText : JSON.stringify(chunkText);
      documentChunkTexts.push(normalized);
      chunks.push({
        index: chunkIndex,
        chars: normalized.length,
        head: clip(normalized.slice(0, 180), 180),
        tail: clip(normalized.slice(-180), 180),
        cursorReturned: Boolean(cursor),
        cursorToken: opaqueToken(cursor),
        textSignature: `${normalized.length}:${normalized.slice(0, 180)}:${normalized.slice(-180)}`,
        documentStamp: currentObservation?.snapshotId ?? currentObservation?.documentStamp ?? null,
        cursor,
      });
      if (!cursor) break;
      const next = await client.tool("browser.document.continue", {
        sessionId: workflow.sessionId,
        cursor,
        maxBytes: 4096,
        timeoutMs: 45000,
      });
      workflow.observations.push({ step: `documentation continuation ${chunkIndex + 1}`, kind: "document", response: safeSummary(next.data ?? next.error) });
      if (!next.ok) {
        fail(workflow, `browser.document.continue ${chunkIndex + 1}`, "Continuation call failed", { response: next.error, chunks });
        return workflow;
      }
      current = next.data;
      currentObservation = current?.observation ?? current;
      cursor = currentObservation?.cursor ?? current?.cursor ?? current?.nextCursor ?? null;
      chunkIndex += 1;
    }
    workflow.visibleEvidence.push({ step: "documentation continuity", chunks });
    const documentTitle = started?.observation?.title ?? started?.title ?? "";
    const firstDocumentText = documentChunkTexts[0] ?? "";
    const documentIdentity = /HTML Standard/i.test(documentTitle)
      && /\bHTML\b/i.test(firstDocumentText)
      && /Living Standard/i.test(firstDocumentText);
    const stableSnapshot = chunks.length >= 2
      && typeof chunks[0].documentStamp === "string"
      && chunks[0].documentStamp.length > 0
      && chunks.every((chunk) => chunk.documentStamp === chunks[0].documentStamp);
    const cursorProgression = chunks.length >= 2
      && chunks[0].cursorToken.length > 0
      && chunks.slice(1).every((chunk, index) => !chunk.cursorToken || chunk.cursorToken !== chunks[index].cursorToken);
    const nonDuplicateChunks = chunks.length >= 2
      && chunks.every((chunk) => chunk.chars > 0)
      && chunks.slice(1).every((chunk, index) => chunk.textSignature !== chunks[index].textSignature);
    const referenceUrls = documentLinkDestinations(documentChunkTexts);
    workflow.visibleEvidence.push({
      step: "documentation identity",
      title: documentTitle,
      expectedText: "HTML Living Standard",
      firstChunkHead: clip(firstDocumentText.slice(0, 240), 240),
      verified: documentIdentity,
    });
    workflow.visibleEvidence.push({ step: "documentation reference URLs", evidenceSource: "inline_document_link_destinations", referenceUrls });
    if (chunks.length < 2) {
      fail(workflow, "documentation continuation", "No returned continuation cursor produced an adjacent second chunk", { chunks });
      return workflow;
    }
    if (!documentIdentity) {
      fail(workflow, "documentation identity", "First document chunk/title did not independently identify the expected HTML Standard", { title: documentTitle, firstChunkHead: clip(firstDocumentText.slice(0, 240), 240) });
      return workflow;
    }
    if (!stableSnapshot) {
      fail(workflow, "documentation chunk continuity", "Continuation chunks did not retain one non-null document snapshot", { chunks });
      return workflow;
    }
    if (!cursorProgression) {
      fail(workflow, "documentation cursor progression", "Continuation cursor was missing or did not progress", { chunks });
      return workflow;
    }
    if (!nonDuplicateChunks) {
      fail(workflow, "documentation chunk continuity", "Continuation returned empty or duplicate document chunks", { chunks });
      return workflow;
    }
    if (referenceUrls.length === 0) {
      fail(workflow, "documentation reference URLs", "No reference URL was returned in document chunks", { chunks });
      return workflow;
    }
    workflow.success = true;
    return workflow;
  } catch (error) {
    fail(workflow, "unexpected", error.message);
    return workflow;
  }
}

async function stopSession(client, workflow) {
  if (!workflow.sessionId) return;
  const stopped = await client.tool("browser.session.stop", { sessionId: workflow.sessionId });
  workflow.observations.push({ step: "browser.session.stop", response: safeSummary(stopped.data ?? stopped.error) });
}

async function main() {
  for(const argument of process.argv.slice(2)){
    if(!/^--(?:artifact|output|expected-sha256|keep-temp)=/.test(argument))throw new Error(`Unknown probe argument: ${argument}`);
  }
  const artifact = path.resolve(argValue("artifact", DEFAULT_ARTIFACT));
  const evidencePath = path.resolve(argValue("output", path.join(ROOT, "test", "evidence", "luna-packed-probes.json")));
  const expectedSha256 = argValue("expected-sha256", "").toUpperCase();
  const startedAt = nowIso();
  const runStarted = performance.now();
  const before = await sha256(artifact);
  if (expectedSha256 && before !== expectedSha256) throw new Error(`Artifact hash mismatch: expected ${expectedSha256}, got ${before}`);
  const artifactStat = await stat(artifact);
  const qaRoot = await mkdtemp(path.join(tmpdir(), "newton-packed-probes-"));
  const extraction = spawnSync("tar", ["-xzf", artifact, "-C", qaRoot], { encoding: "utf8", windowsHide: true });
  if (extraction.status !== 0) throw new Error(`Artifact extraction failed: ${extraction.stderr || extraction.stdout}`);
  const entry = path.join(qaRoot, "package", "dist", "index.js");
  const evidence = {
    schemaVersion: 1,
    qaType: "SCRIPTED packed workflow QA",
    startedAt,
    finishedAt: null,
    artifact: {
      path: artifact,
      version: "0.6.4",
      bytes: artifactStat.size,
      expectedSha256: expectedSha256 || null,
      sha256Before: before,
      sha256After: null,
      immutable: false,
      extractedRoot: qaRoot,
      entry,
    },
    runtime: {
      node: process.version,
      browserMode: "owned isolated browser requested by browser.session.start",
      browserVersion: "not exposed by the public MCP response",
    },
    catalog: null,
    calls: [],
    workflows: [],
    cleanup: { sessions: [], process: "pending" },
    notes: [
      "These are scripted packed-artifact workflows, not model-turn or ChatGPT parity benchmarks.",
      "Receipt dispatch and visible postconditions are recorded separately.",
      "Failures are preserved; no network/API search bypass is used.",
    ],
    pathNormalization: "Repo paths serialize as <workspace>/relative/path; owned temporary paths serialize as <qa-temp>/relative/path.",
  };
  const client = new PackedMcpClient(entry, evidence);
  try {
    const catalog = await client.request("tools/list", {});
    const toolList = catalog.data?.tools ?? [];
    evidence.catalog = {
      protocolOk: catalog.ok,
      responseBytes: catalog.record.responseBytes,
      tools: toolList.map((tool) => ({ name: tool.name, description: clip(tool.description ?? "", 300) })),
    };
    const required = ["browser.session.start", "browser.act", "browser.observe", "browser.document.read", "browser.document.continue", "browser.pages.list", "browser.session.stop"];
    const missing = required.filter((name) => !toolList.some((tool) => tool.name === name));
    if (!catalog.ok || missing.length > 0) {
      evidence.catalog.missingRequiredTools = missing;
      throw new Error(`Packed catalog missing required tools: ${missing.join(", ")}`);
    }
    const runners = [runWikipedia, runGitHub, runDocumentation];
    for (const runner of runners) {
      const workflowStarted = performance.now();
      const workflow = await runner(client);
      evidence.workflows.push(workflow);
      await stopSession(client, workflow);
      workflow.elapsedMs = Math.round(performance.now() - workflowStarted);
      evidence.cleanup.sessions.push({ workflow: workflow.name, sessionId: workflow.sessionId, stopped: workflow.observations.at(-1)?.step === "browser.session.stop" });
    }
  } finally {
    await client.close();
    evidence.cleanup.process = "closed";
    evidence.runtime.stderrTail = clip(client.stderr, 4000);
    evidence.artifact.sha256After = await sha256(artifact);
    evidence.artifact.immutable = evidence.artifact.sha256Before === evidence.artifact.sha256After;
    evidence.finishedAt = nowIso();
    evidence.totalElapsedMs = Math.round(performance.now() - runStarted);
    evidence.outputCost={encoding:'o200k_base',scope:'Full text content blocks before clipping; tool catalog serialized separately. Excludes harness prompts, image tokens and model reasoning.',
      outputTextTokens:evidence.calls.reduce((sum,call)=>sum+(call.outputTextTokens??0),0),
      catalogTokens:evidence.calls.reduce((sum,call)=>sum+(call.catalogTokens??0),0)};
    await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(path.dirname(evidencePath), { recursive: true }).then(() => writeFile(evidencePath, `${JSON.stringify(normalizeForSerialization(evidence), null, 2)}\n`, "utf8")));
    if (argValue("keep-temp", "false") !== "true") await rm(qaRoot, { recursive: true, force: true });
  }
  const failed = evidence.workflows.filter((workflow) => !workflow.success);
  console.log(JSON.stringify(normalizeForSerialization({
    evidencePath,
    artifact: evidence.artifact,
    catalogTools: evidence.catalog?.tools?.map((tool) => tool.name) ?? [],
    workflows: evidence.workflows.map((workflow) => ({ name: workflow.name, success: workflow.success, failure: workflow.failure })),
    calls: evidence.calls.length,
  }), null, 2));
  if (!evidence.artifact.immutable || failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
