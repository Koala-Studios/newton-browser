import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import { BROWSER_ACT_JSON_SCHEMA, BROWSER_COMPOSITE_REF_PATTERN_SOURCE, parseBrowserAction, redactBrowserResult, type BrowserAction, type BrowserCommandResult, type BrowserFloorDecision, type BrowserSessionInfo, type PageProvenance } from "@newton-browser/core";

import { NEWTON_BROWSER_VERSION } from "./cli.ts";
import type { DirectBrowserHost } from "./browser-runtime/direct-browser-host.ts";
import { createDefaultDirectBrowserHost } from "./browser-runtime/default-direct-host.ts";
import {
  MODERN_MCP_PROTOCOL_VERSION,
  serveModernMcpStdio,
  type JsonRpcId,
  type ModernMcpRequest,
  type ModernMcpRequestContext,
  type ModernMcpResponse,
} from "./modern-mcp-stdio.ts";
import { normalizeAgentActionResult, projectObservation, type AgentObservationOptionsInput } from "./agent-output.ts";
import { annotationsForTool, MCP_SERVER_INSTRUCTIONS } from "./mcp-contract.ts";

type BrowserHost = DirectBrowserHost;
type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolCallResult = { resultType: "complete"; content: ToolContent[]; isError?: boolean };

const SCREENSHOT_BYTES_CAP = 16 * 1024 * 1024;
const TOOL_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_ID_CAP = 120;
const ORIGIN_CAP = 512;
const TOOL_NAMES = new Set([
  "browser.status", "browser.session.start", "browser.observe", "browser.act",
  "browser.screenshot", "browser.console", "browser.network", "browser.sessions.list",
  "browser.session.stop", "browser.stop_all",
]);
const SCREENSHOT_MASK_DISPOSITIONS = new Set(["mask_applied", "mask_not_configured", "mask_not_applicable"]);
const DIRECT_SESSION_ID_PATTERN = "^direct_session_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const DIRECT_SESSION_ID = new RegExp(DIRECT_SESSION_ID_PATTERN, "u");
let cachedToolCatalog: Array<Record<string, unknown>> | null = null;

export async function startNewtonBrowserMcpServer(input: { host?: BrowserHost } = {}): Promise<void> {
  const host = input.host ?? createDefaultDirectBrowserHost();
  try {
    await serveNewtonBrowserMcpConnection({ host, readable: process.stdin, writable: process.stdout });
  } finally {
    await shutdownBrowserHost(host);
  }
}

async function shutdownBrowserHost(host: BrowserHost): Promise<void> {
  try { await host.stopAll(); } catch { /* close is the authoritative retry/terminal cleanup path */ }
  await host.close();
}

async function serveNewtonBrowserMcpConnection(input: {
  host: BrowserHost;
  readable: Readable;
  writable: Writable;
}): Promise<void> {
  await serveModernMcpStdio({
    readable: input.readable,
    writable: input.writable,
    handleRequest: (request, context) => handleMcpMessage(input.host, request, context),
  });
}

export async function handleMcpMessage(
  host: BrowserHost,
  message: ModernMcpRequest,
  context: ModernMcpRequestContext = { signal: new AbortController().signal },
): Promise<ModernMcpResponse | null> {
  const id = message.id;
  const metadataError = validateRequestMetadata(message.params);
  if (metadataError) return errorResponse(id, metadataError.code, metadataError.message, metadataError.data);
  if (message.method === "server/discover") {
    if (!hasExactParameterKeys(message.params, ["_meta"])) {
      return errorResponse(id, -32602, "Invalid server/discover parameters.", { errorCode: "invalid_discover_parameters" });
    }
    return response(id, {
      supportedVersions: [MODERN_MCP_PROTOCOL_VERSION],
      capabilities: { tools: {} },
      instructions: MCP_SERVER_INSTRUCTIONS,
      ttlMs: TOOL_CATALOG_TTL_MS,
      cacheScope: "public",
    });
  }
  if (message.method === "tools/list") {
    if (!hasExactParameterKeys(message.params, ["_meta", "cursor"])) {
      return errorResponse(id, -32602, "Invalid tools/list parameters.", { errorCode: "invalid_tools_list_parameters" });
    }
    if (message.params?.cursor !== undefined) {
      return errorResponse(id, -32602, "Newton Browser publishes one complete tool page.", { errorCode: "invalid_cursor" });
    }
    return response(id, { tools: toolList(), ttlMs: TOOL_CATALOG_TTL_MS, cacheScope: "public" });
  }
  if (message.method === "tools/call") {
    const params = message.params;
    if (!isObject(params) || !hasExactParameterKeys(params, ["_meta", "name", "arguments"])
      || typeof params.name !== "string" || params.name.length === 0 || params.name.length > 240
      || (params.arguments !== undefined && !isObject(params.arguments))) {
      return errorResponse(id, -32602, "Invalid tools/call parameters.", { errorCode: "invalid_tool_call" });
    }
    const name = params.name;
    if (!TOOL_NAMES.has(name)) {
      return errorResponse(id, -32602, "Unknown tool name.", { errorCode: "unknown_tool" });
    }
    const args = isObject(params.arguments) ? params.arguments : {};
    try {
      validateToolArguments(name, args);
    } catch {
      return errorResponse(id, -32602, "Invalid tool arguments.", { errorCode: "invalid_arguments", tool: name });
    }
    try {
      context.signal.throwIfAborted();
      const result = await callTool(host, name, args, context.signal);
      context.signal.throwIfAborted();
      return response(id, result);
    } catch (error) {
      if (context.signal.aborted) return null;
      const code = errorCode(error);
      return response(id, toolError(code, publicErrorMessage(code)));
    }
  }
  return errorResponse(id, -32601, "Unsupported MCP method.");
}

async function callTool(host: BrowserHost, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolCallResult> {
  signal.throwIfAborted();
  if (name === "browser.status") {
    const status = host.getStatus();
    const runtimeState = status.runtimeReady
      ? "ready"
      : status.cleanupUncertainCount > 0
        ? "cleanup_uncertain"
        : status.sessionCount === 0 ? "idle" : "starting";
    const directStatus = {
      ready: status.configured && status.cleanupUncertainCount === 0,
      configured: status.configured,
      runtimeState,
      mode: "direct",
      version: NEWTON_BROWSER_VERSION,
      sessionCount: status.sessionCount,
      activeSessionCount: status.activeSessionCount,
      cleanupUncertainCount: status.cleanupUncertainCount,
    };
    return toolJson(args.detail === "full"
      ? { ...directStatus, limits: status.limits, sessionDiagnostics: status.sessionDiagnostics }
      : directStatus,
    !status.configured || status.cleanupUncertainCount > 0,
    !status.configured || status.cleanupUncertainCount > 0 ? "direct_runtime_unavailable" : undefined);
  }

  if (name === "browser.session.start") {
    const origin = requiredHttpOrigin(args.origin);
    const allowedOrigins = normalizeAllowedOrigins(args.allowedOrigins, origin);
    const identityId = args.identityId === undefined ? undefined : requiredIdentityId(args.identityId);
    const browserFamily = args.browser === undefined ? undefined : requiredBrowserFamily(args.browser);
    const created = host.createSession({
      origin,
      allowedOrigins,
      ...(identityId ? { identityId } : {}),
      ...(browserFamily ? { browserFamily } : {}),
    });
    try {
      const session = await withAbort(host.waitForSessionReady(created.sessionId), signal, () => host.stopSession(created.sessionId));
      if (isObject(args.observe)) {
        const event = await host.dispatch(created.sessionId, prepareActionForDispatch(actionForTool("browser.observe", args.observe)), { signal });
        if (!event.ok) {
          if (!await cleanupFailedSessionStart(host, created.sessionId)) {
            return toolError("direct_cleanup_uncertain", "The failed session start could not be cleaned up conclusively.");
          }
          return toolJson({ ok: false, errorCode: event.errorCode, ...publicCommandMetadata(event) }, true);
        }
        const observation = observationEnvelope(event, args.observe);
        if (!observation.ok) {
          if (!await cleanupFailedSessionStart(host, created.sessionId)) {
            return toolError("direct_cleanup_uncertain", "The failed session start could not be cleaned up conclusively.");
          }
          return toolJson(observation, true);
        }
        return toolJson({ sessionId: created.sessionId, origin: session.origin, observation });
      }
      return toolJson({ sessionId: created.sessionId, origin: session.origin });
    } catch (error) {
      if (signal.aborted) throw error;
      if (!await cleanupFailedSessionStart(host, created.sessionId)) {
        return toolError("direct_cleanup_uncertain", "The failed session start could not be cleaned up conclusively.");
      }
      const code = errorCode(error);
      return toolError(code, publicErrorMessage(code));
    }
  }

  if (name === "browser.sessions.list") return toolJson({ sessions: host.listSessions() });
  if (name === "browser.session.stop") {
    const sessionId = requiredString(args.sessionId, "sessionId");
    try {
      await host.stopSession(sessionId);
      return toolJson({ stopped: true });
    } catch {
      if (!host.listSessions().some((session) => session.sessionId === sessionId)) {
        return toolJson({ stopped: true, alreadyStopped: true });
      }
      return toolError("direct_cleanup_uncertain", "The session could not be cleaned up conclusively.");
    }
  }
  if (name === "browser.stop_all") {
    const stoppedCount = host.listSessions().length;
    try {
      await host.stopAll();
      return toolJson({ stopped: true, stoppedCount });
    } catch {
      if (host.listSessions().length === 0) return toolJson({ stopped: true, stoppedCount });
      return toolError("direct_cleanup_uncertain", "One or more sessions could not be cleaned up conclusively.");
    }
  }

  if (name === "browser.console" || name === "browser.network") {
    const sessionId = requiredString(args.sessionId, "sessionId");
    const session = host.listSessions().find((candidate) => candidate.sessionId === sessionId);
    if (!session) return toolError("unknown_session", "The session does not exist.");
    const action = name === "browser.console"
      ? {
          kind: "console",
          ...(args.level !== undefined ? { level: args.level } : {}),
          ...(args.pattern !== undefined ? { pattern: args.pattern } : {}),
          limit: clampNumber(args.limit, 100, 1, 500),
        }
      : {
          kind: "network",
          ...(args.urlPattern !== undefined ? { urlPattern: args.urlPattern } : {}),
          ...(args.requestId !== undefined ? { requestId: args.requestId } : {}),
          limit: clampNumber(args.limit, 100, 1, 500),
        };
    const event = await host.dispatch(sessionId, parseBrowserAction(action), { signal });
    if (!event.ok) return toolJson({ ok: false, errorCode: event.errorCode, ...publicCommandMetadata(event) }, true);
    const result = redactObservationResult(event.result);
    const resultOrigin = isObject(result) && typeof result.origin === "string" ? result.origin : session.origin;
    const capturedAt = isObject(result) && typeof result.capturedAt === "string" ? result.capturedAt : undefined;
    return toolJson({ ok: true, result, provenance: publicPageProvenance(resultOrigin, capturedAt), ...publicCommandMetadata(event) });
  }

  if (["browser.observe", "browser.screenshot", "browser.act"].includes(name)) {
    const sessionId = requiredString(args.sessionId, "sessionId");
    const session = host.listSessions().find((candidate) => candidate.sessionId === sessionId);
    if (!session) return toolError("unknown_session", "The session does not exist.");
    const action = prepareActionForDispatch(actionForTool(name, args));
    if (name === "browser.act" && isObject(action) && action.kind === "fill_form") {
      return await runFillForm(
        host,
        sessionId,
        session,
        action,
        typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined,
        typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
        signal,
      );
    }
    const dispatchOptions = name === "browser.act"
      ? {
          ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey as string } : {}),
          ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs as number } : {}),
          signal,
        }
      : { signal };
    const event = await host.dispatch(sessionId, action, dispatchOptions);
    if (!event.ok) {
      const decision = event.decision;
      if (name === "browser.act") return toolJson(agentActionEnvelope(event, decision, session), true);
      return toolJson({ ok: false, errorCode: event.errorCode, decision: publicDecision(decision), ...publicCommandMetadata(event) }, true);
    }
    const decision = event.decision;
    if (name === "browser.screenshot") return screenshotToolResult(event);
    if (name === "browser.act") {
      const actionResult = agentActionEnvelope(event, decision, session);
      return toolJson(actionResult, actionResult.ok !== true);
    }
    const observation = observationEnvelope(event, args);
    return toolJson(observation, !observation.ok);
  }
  return toolError("unknown_tool", "Newton Browser does not expose that tool.");
}

async function cleanupFailedSessionStart(host: BrowserHost, sessionId: string): Promise<boolean> {
  try {
    await host.stopSession(sessionId);
    return true;
  } catch {
    return !host.listSessions().some((session) => session.sessionId === sessionId);
  }
}

function observationEnvelope(event: Extract<BrowserCommandResult, { ok: true }>, args: AgentObservationOptionsInput) {
  const projected = projectObservation(event.result, args);
  if (!projected.ok) {
    return { ok: false, errorCode: projected.errorCode, reason: projected.reason, ...publicCommandMetadata(event) };
  }
  const { projection } = projected;
  const provenance = publicPageProvenance(projection.origin, projection.capturedAt);
  if (projection.format === "compact") {
    return {
      ok: true,
      output: projection.output ?? "",
      ...(projection.budget.truncated ? { budget: projection.budget } : {}),
      provenance,
      ...publicCommandMetadata(event),
    };
  }
  return { ok: true, result: projection, provenance, ...publicCommandMetadata(event) };
}

function publicPageProvenance(origin: string, capturedAt?: string): PageProvenance {
  return {
    trust: "untrusted_page_content" as const,
    origin,
    ...(capturedAt ? { capturedAt } : {}),
  };
}

function agentActionEnvelope(event: BrowserCommandResult, decision: BrowserFloorDecision, session: unknown) {
  const result = event.ok && isObject(event.result) ? redactObservationResult(event.result) : {};
  const resultRecord = isObject(result) ? result : {};
  const changedRecord = event.ok && isObject(event.changed) ? event.changed : isObject(resultRecord.changed) ? resultRecord.changed : {};
  const origin = isObject(session) && typeof session.origin === "string" ? session.origin : "unknown";
  const reason = event.ok
    ? event.reason ?? (typeof resultRecord.reason === "string" ? resultRecord.reason : undefined)
    : event.errorCode;
  const projection = normalizeAgentActionResult({
    status: event.status,
    outcome: event.outcome,
    ...(reason ? { reason } : {}),
    ...(!event.ok ? { errorCode: event.errorCode } : {}),
    decision: {
      class: decision.class,
      commitBoundary: decision.commitBoundary,
      ...(decision.reason ? { reason: decision.reason } : {}),
    },
    changed: Object.keys(changedRecord).length > 0,
    ...(Object.keys(changedRecord).length > 0
      ? { delta: Object.keys(changedRecord).slice(0, 10) }
      : {}),
    ...(event.ok && typeof resultRecord.kind === "string" && resultRecord.kind.startsWith("observation")
      ? { provenance: { origin } }
      : {}),
  });
  return { ...projection, sequence: event.sequence };
}

// One fill_form call fills an ordered set of fields. The batch is
// expanded host-side into sequential single fills, each getting the full per-field
// floor (host hints + driver resolved facts) and redaction. It stops at the first
// blocked or failed field and reports a per-field summary, so a sensitive field in
// the middle of a form halts the batch exactly like a standalone fill would.
async function runFillForm(
  host: BrowserHost,
  sessionId: string,
  session: BrowserSessionInfo,
  action: BrowserAction,
  idempotencyKey?: string,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<ToolCallResult> {
  const parsed = parseBrowserAction(action);
  const fields = Array.isArray(parsed.fields) ? parsed.fields : [];
  if (fields.length === 0) return toolError("fill_form_requires_fields", "fill_form needs a non-empty fields array, each with a target and value.");
  const results: Array<{ index: number; status: string; reason?: string }> = [];
  let strongest: BrowserFloorDecision | undefined;
  let lastEvent: Extract<BrowserCommandResult, { ok: true }> | undefined;
  for (let index = 0; index < fields.length; index += 1) {
    const fillAction = parseBrowserAction({ kind: "fill", ...fields[index] });
    const fieldIdempotencyKey = idempotencyKey
      ? createHash("sha256").update(`${idempotencyKey}:${index}`).digest("base64url")
      : undefined;
    const event = await host.dispatch(sessionId, fillAction, {
      ...(fieldIdempotencyKey ? { idempotencyKey: fieldIdempotencyKey } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(signal ? { signal } : {}),
    });
    const eventDecision = event.decision;
    strongest = strongest ? strongestDecision(strongest, eventDecision) : eventDecision;
    if (!event.ok) {
      results.push({ index, status: "failed", reason: event.errorCode });
      return toolJson({ ...agentActionEnvelope(event, strongest, session), stoppedAt: index, fields: results }, true);
    }
    lastEvent = event;
    const status = event.status;
    results.push({ index, status, ...(event.reason ? { reason: event.reason } : {}) });
    if (status !== "verified" && status !== "dispatched_unverified") {
      return toolJson({ ...agentActionEnvelope(event, strongest, session), ok: false, errorCode: "fill_form_field_incomplete", stoppedAt: index, fields: results }, true);
    }
  }
  if (!lastEvent || !strongest) return toolError("runner_contract_invalid", "The form batch produced no authoritative result.");
  const normalized = agentActionEnvelope(lastEvent, strongest, session);
  return toolJson({ ...normalized, filled: results.length, fields: results });
}

function actionForTool(name: string, args: Record<string, unknown>): unknown {
  if (name === "browser.observe") {
    if (args.mode === "text") {
      return { kind: "observe", mode: "text", maxChars: clampNumber(args.maxChars, 20_000, 200, 200_000) };
    }
    return {
      kind: "observe",
      mode: args.mode === "diff" ? "diff" : "full",
      maxNodes: clampNumber(args.maxNodes, 80, 1, 250),
      ...(typeof args.query === "string" ? { query: args.query } : {}),
      ...(Array.isArray(args.roles) ? { roles: args.roles } : {}),
      ...(args.includeInteractive === true ? { includeInteractive: true } : {}),
    };
  }
  if (name === "browser.screenshot") {
    return {
      kind: "screenshot",
      fullPage: Boolean(args.fullPage),
      ...(args.region !== undefined ? { clip: args.region } : {}),
      ...(args.sensitiveZones !== undefined ? { sensitiveZones: args.sensitiveZones } : {}),
      ...(args.format === "jpeg" ? { format: "jpeg", quality: clampNumber(args.quality, 70, 1, 100) } : {}),
    };
  }
  return isObject(args.action) ? args.action : {};
}

export function prepareActionForDispatch(raw: unknown): BrowserAction {
  const parsed = parseBrowserAction(raw);
  if (parsed.kind !== "set_files") return parsed;
  if (!Array.isArray(parsed.files)) throw new Error("files_required");
  if (parsed.files.length > 8) throw new Error("file_count_exceeded");
  let total = 0;
  const files = parsed.files.map((value) => {
    if (typeof value !== "string" || !value || !path.isAbsolute(value) || /[*?]/.test(value)) throw new Error("invalid_file_path");
    const stat = fs.lstatSync(value, { throwIfNoEntry: false });
    if (!stat) throw new Error("file_not_found");
    if (stat.isSymbolicLink()) throw new Error("symlink_not_allowed");
    if (!stat.isFile()) throw new Error("file_not_found");
    if (stat.size > 50 * 1024 * 1024) throw new Error("file_too_large");
    total += stat.size;
    if (total > 200 * 1024 * 1024) throw new Error("file_total_too_large");
    const extension = path.extname(value).toLowerCase();
    if (!new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm"]).has(extension)) throw new Error("file_type_not_allowed");
    if (!hasAllowedFileSignature(value, extension)) throw new Error("file_type_not_allowed");
    return value;
  });
  return { ...parsed, files };
}

function hasAllowedFileSignature(file: string, extension: string): boolean {
  const descriptor = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(16);
    const bytes = fs.readSync(descriptor, header, 0, header.length, 0);
    const view = header.subarray(0, bytes);
    if (extension === ".png") return view.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (extension === ".jpg" || extension === ".jpeg") return view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff;
    if (extension === ".gif") return ["GIF87a", "GIF89a"].includes(view.subarray(0, 6).toString("ascii"));
    if (extension === ".webp") return view.subarray(0, 4).toString("ascii") === "RIFF" && view.subarray(8, 12).toString("ascii") === "WEBP";
    if (extension === ".mp4") return view.subarray(4, 8).toString("ascii") === "ftyp";
    if (extension === ".webm") return view.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    return false;
  } finally {
    fs.closeSync(descriptor);
  }
}

function screenshotToolResult(event: Extract<BrowserCommandResult, { ok: true }>): ToolCallResult {
  const raw = event.result;
  const commandMetadata = publicCommandMetadata(event);
  if (!isObject(raw) || typeof raw.dataUrl !== "string") return toolError("screenshot_unavailable", "The browser runtime returned no screenshot bytes.", commandMetadata);
  if (!SCREENSHOT_MASK_DISPOSITIONS.has(String(raw.maskDisposition))) {
    return toolError("runner_contract_invalid", "The browser runtime returned invalid screenshot safety metadata.", commandMetadata);
  }
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(raw.dataUrl);
  const format = match?.[1];
  const encoded = match?.[2];
  if ((format !== "png" && format !== "jpeg") || !encoded) {
    return toolError("invalid_screenshot", "The browser runtime returned malformed screenshot bytes.", commandMetadata);
  }
  const buffer = Buffer.from(encoded, "base64");
  if (encoded.length % 4 !== 0 || buffer.toString("base64") !== encoded) {
    return toolError("invalid_screenshot", "The browser runtime returned malformed screenshot bytes.", commandMetadata);
  }
  if (!hasScreenshotSignature(buffer, format)) {
    return toolError("invalid_screenshot", "The browser runtime returned malformed screenshot bytes.", commandMetadata);
  }
  if (buffer.length > SCREENSHOT_BYTES_CAP) return toolError("result_too_large", "Screenshot exceeds the 16 MiB result bound; use JPEG, a region, or a smaller viewport.", commandMetadata);
  const redacted = redactBrowserResult(raw);
  if (!redacted || redacted.kind !== "screenshot" || typeof redacted.dataUrl !== "string") {
    return toolError("invalid_screenshot", "The browser runtime returned invalid screenshot data.", commandMetadata);
  }
  const imageMime = `image/${format}`;
  const metadata = { ...redacted } as Record<string, unknown>;
  delete metadata.dataUrl;
  delete metadata.title;
  const screenshotOrigin = typeof metadata.origin === "string" ? metadata.origin : "unknown";
  const capturedAt = typeof metadata.capturedAt === "string" ? metadata.capturedAt : undefined;
  const common = {
    ok: true,
    ...metadata,
    provenance: publicPageProvenance(screenshotOrigin, capturedAt),
    ...commandMetadata,
  };
  return { resultType: "complete", content: [{ type: "text", text: JSON.stringify(common) }, { type: "image", data: encoded, mimeType: imageMime }] };
}

function hasScreenshotSignature(buffer: Buffer, format: string): boolean {
  if (format === "png") return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return format === "jpeg" && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

export function toolList(): Array<Record<string, unknown>> {
  if (cachedToolCatalog) return cachedToolCatalog;
  const observationOutput = {
    format: { type: "string", enum: ["compact", "json"] },
    includeGeometry: { type: "boolean" },
    includeInteractive: { type: "boolean" },
    query: { type: "string", maxLength: 120 },
    roles: { type: "array", minItems: 1, maxItems: 12, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 80 } },
    limit: { type: "integer", minimum: 1, maximum: 200 },
    mode: { type: "string", enum: ["full", "diff", "text"] },
    maxNodes: { type: "integer", minimum: 1, maximum: 250 },
    maxChars: { type: "integer", minimum: 200, maximum: 200_000 },
  };
  cachedToolCatalog = [
    tool("browser.status", "Report readiness; detail defaults to compact.", { detail: { type: "string", enum: ["compact", "full"] } }),
    tool("browser.session.start", "Start an isolated origin-scoped browser session; optionally select a browser and opaque identity.", {
      origin: { type: "string", minLength: 8, maxLength: ORIGIN_CAP },
      allowedOrigins: {
        type: "array",
        maxItems: 31,
        uniqueItems: true,
        description: "Additional exact HTTP(S) origins; do not repeat the primary origin.",
        items: { type: "string", minLength: 8, maxLength: ORIGIN_CAP },
      },
      identityId: { type: "string", pattern: "^nbi_[a-f0-9]{32}$" },
      browser: { type: "string", enum: ["chrome", "edge"] },
      observe: {
        anyOf: [
          { type: "boolean", const: false },
          { type: "object", properties: observationOutput, additionalProperties: false },
        ],
      },
    }, ["origin"]),
    tool("browser.observe", "Observe a session page; compact geometry-free output is default.", { sessionId: sessionIdSchema(), ...observationOutput }, ["sessionId"]),
    tool("browser.act", "Run one typed browser action and return its floor decision.", {
      sessionId: sessionIdSchema(),
      action: BROWSER_ACT_JSON_SCHEMA,
      idempotencyKey: { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" },
      timeoutMs: { type: "integer", minimum: 1, maximum: 300000 },
    }, ["sessionId", "action"]),
    tool("browser.screenshot", "Capture and deliver a screenshot.", {
      sessionId: sessionIdSchema(),
      fullPage: { type: "boolean" },
      region: { type: "object", additionalProperties: false, required: ["x", "y", "width", "height"], properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number", exclusiveMinimum: 0 }, height: { type: "number", exclusiveMinimum: 0 } } },
      format: { type: "string", enum: ["png", "jpeg"] },
      quality: { type: "integer", minimum: 1, maximum: 100 },
      sensitiveZones: {
        type: "array", minItems: 1, maxItems: 32,
        items: {
          type: "object", additionalProperties: false, minProperties: 1, maxProperties: 1,
          oneOf: [{ required: ["ref"] }, { required: ["selector"] }, { required: ["name"] }, { required: ["label"] }],
          properties: {
            ref: { type: "string", pattern: BROWSER_COMPOSITE_REF_PATTERN_SOURCE },
            selector: { type: "string", minLength: 1, maxLength: 240 },
            name: { type: "string", minLength: 1, maxLength: 240 },
            label: { type: "string", minLength: 1, maxLength: 240 },
          },
        },
      },
    }, ["sessionId"]),
    tool("browser.console", "Read or filter buffered console text.", {
      sessionId: sessionIdSchema(), level: { type: "string", enum: ["log", "info", "warn", "error", "debug"] }, pattern: { type: "string", minLength: 1, maxLength: 240 }, limit: { type: "integer", minimum: 1, maximum: 500 },
    }, ["sessionId"]),
    tool("browser.network", "List request metadata or fetch one granted-origin text body; never returns headers or opaque bodies.", {
      sessionId: sessionIdSchema(), urlPattern: { type: "string", minLength: 1, maxLength: 500 }, requestId: { type: "string", minLength: 1, maxLength: 240 }, limit: { type: "integer", minimum: 1, maximum: 500 },
    }, ["sessionId"]),
    tool("browser.sessions.list", "List this host's local sessions.", {}),
    tool("browser.session.stop", "Stop one local session.", { sessionId: sessionIdSchema() }, ["sessionId"]),
    tool("browser.stop_all", "Stop all local sessions.", {}),
  ].map((entry) => deepFreeze(entry));
  if (cachedToolCatalog.length !== TOOL_NAMES.size
    || cachedToolCatalog.some((entry) => typeof entry.name !== "string" || !TOOL_NAMES.has(entry.name))) {
    throw new Error("tool_catalog_invalid");
  }
  Object.freeze(cachedToolCatalog);
  return cachedToolCatalog;
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { name, description, annotations: annotationsForTool(name), inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false } };
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function sessionIdSchema(): Record<string, unknown> {
  return { type: "string", minLength: 1, maxLength: SESSION_ID_CAP, pattern: DIRECT_SESSION_ID_PATTERN };
}

const OBSERVATION_ARGUMENTS = Object.freeze([
  "format", "includeGeometry", "includeInteractive", "query", "roles", "limit",
  "mode", "maxNodes", "maxChars",
] as const);

function validateToolArguments(name: string, args: Record<string, unknown>): void {
  const exact = (allowed: readonly string[]): void => {
    if (Object.keys(args).some((key) => !allowed.includes(key))) throw new Error("invalid_arguments");
  };
  if (name === "browser.status") {
    exact(["detail"]);
    optionalEnum(args.detail, ["compact", "full"]);
    return;
  }
  if (name === "browser.session.start") {
    exact(["origin", "allowedOrigins", "identityId", "browser", "observe"]);
    requiredHttpOrigin(args.origin);
    normalizeAllowedOrigins(args.allowedOrigins, requiredHttpOrigin(args.origin));
    if (args.identityId !== undefined) requiredIdentityId(args.identityId);
    if (args.browser !== undefined) requiredBrowserFamily(args.browser);
    if (args.observe !== undefined && args.observe !== false) {
      if (!isObject(args.observe)) throw new Error("invalid_arguments");
      validateObservationArguments(args.observe);
    }
    return;
  }
  if (name === "browser.observe") {
    exact(["sessionId", ...OBSERVATION_ARGUMENTS]);
    requiredString(args.sessionId, "sessionId");
    validateObservationArguments(args);
    return;
  }
  if (name === "browser.act") {
    exact(["sessionId", "action", "idempotencyKey", "timeoutMs"]);
    requiredString(args.sessionId, "sessionId");
    const action = parseBrowserAction(args.action);
    if (["observe", "screenshot", "console", "network"].includes(action.kind)) throw new Error("invalid_arguments");
    if (args.idempotencyKey !== undefined
      && (typeof args.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(args.idempotencyKey))) {
      throw new Error("invalid_arguments");
    }
    optionalInteger(args.timeoutMs, 1, 300_000);
    return;
  }
  if (name === "browser.screenshot") {
    exact(["sessionId", "fullPage", "region", "format", "quality", "sensitiveZones"]);
    requiredString(args.sessionId, "sessionId");
    optionalBoolean(args.fullPage);
    optionalEnum(args.format, ["png", "jpeg"]);
    optionalInteger(args.quality, 1, 100);
    if (args.quality !== undefined && args.format !== "jpeg") throw new Error("invalid_arguments");
    parseBrowserAction(actionForTool(name, args));
    return;
  }
  if (name === "browser.console") {
    exact(["sessionId", "level", "pattern", "limit"]);
    requiredString(args.sessionId, "sessionId");
    optionalEnum(args.level, ["log", "info", "warn", "error", "debug"]);
    optionalString(args.pattern, 240);
    optionalInteger(args.limit, 1, 500);
    return;
  }
  if (name === "browser.network") {
    exact(["sessionId", "urlPattern", "requestId", "limit"]);
    requiredString(args.sessionId, "sessionId");
    optionalString(args.urlPattern, 500);
    optionalString(args.requestId, 240);
    optionalInteger(args.limit, 1, 500);
    return;
  }
  if (name === "browser.session.stop") {
    exact(["sessionId"]);
    requiredString(args.sessionId, "sessionId");
    return;
  }
  if (name === "browser.sessions.list" || name === "browser.stop_all") {
    exact([]);
    return;
  }
  throw new Error("unknown_tool");
}

function validateObservationArguments(args: Record<string, unknown>): void {
  if (Object.keys(args).some((key) => key !== "sessionId" && !OBSERVATION_ARGUMENTS.includes(key as typeof OBSERVATION_ARGUMENTS[number]))) {
    throw new Error("invalid_arguments");
  }
  optionalEnum(args.format, ["compact", "json"]);
  optionalBoolean(args.includeGeometry);
  optionalBoolean(args.includeInteractive);
  optionalString(args.query, 120, true);
  if (args.roles !== undefined && (!Array.isArray(args.roles) || args.roles.length === 0 || args.roles.length > 12
    || args.roles.some((role) => typeof role !== "string" || !role.trim() || role.length > 80 || /[\u0000-\u001f\u007f]/u.test(role))
    || new Set(args.roles).size !== args.roles.length)) {
    throw new Error("invalid_arguments");
  }
  optionalInteger(args.limit, 1, 200);
  optionalEnum(args.mode, ["full", "diff", "text"]);
  optionalInteger(args.maxNodes, 1, 250);
  optionalInteger(args.maxChars, 200, 200_000);
}

function optionalEnum(value: unknown, allowed: readonly string[]): void {
  if (value !== undefined && (typeof value !== "string" || !allowed.includes(value))) throw new Error("invalid_arguments");
}

function optionalBoolean(value: unknown): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error("invalid_arguments");
}

function optionalInteger(value: unknown, minimum: number, maximum: number): void {
  if (value !== undefined && (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum)) {
    throw new Error("invalid_arguments");
  }
}

function optionalString(value: unknown, maximum: number, allowEmpty = false): void {
  if (value !== undefined && (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.length === 0))) {
    throw new Error("invalid_arguments");
  }
}

function requiredIdentityId(value: unknown): string {
  if (typeof value !== "string" || !/^nbi_[a-f0-9]{32}$/u.test(value)) throw new Error("invalid_identity_id");
  return value;
}

function requiredBrowserFamily(value: unknown): "chrome" | "edge" {
  if (value !== "chrome" && value !== "edge") throw new Error("invalid_browser_family");
  return value;
}

function publicCommandMetadata(event: BrowserCommandResult) {
  return {
    sequence: event.sequence,
    outcome: event.outcome,
    retrySafe: event.retrySafe,
    status: event.status,
  };
}

function toolJson(value: unknown, isError = false, errorCodeValue?: string): ToolCallResult {
  const normalized = errorCodeValue && isObject(value) ? { ...value, errorCode: errorCodeValue } : value;
  return { resultType: "complete", content: [{ type: "text", text: JSON.stringify(normalized) }], ...(isError ? { isError: true } : {}) };
}

function toolError(code: string, message: string, detail: Record<string, unknown> = {}): ToolCallResult {
  return toolJson({ ok: false, errorCode: code, message, ...detail }, true);
}

// Secret/PII redaction of observation results before they reach the MCP client
// (the model). The driver produces raw accessible names, values, and page text on
// the private driver transport; the host is the exfiltration boundary, so redaction runs here
// (as the driver's own comment documents). Only real observation kinds are touched —
// control acknowledgements and other non-observation results pass through unchanged.
function redactObservationResult(result: unknown): unknown {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const kind = (result as Record<string, unknown>).kind;
    if (kind === "observation" || kind === "observation_delta" || kind === "observation_text" || kind === "console_log" || kind === "network_log") {
      return redactBrowserResult(result);
    }
  }
  return result;
}

function publicDecision(decision: BrowserFloorDecision) {
  const rawReason = decision.reason;
  const reason = typeof rawReason === "string" ? rawReason.slice(0, 120) : undefined;
  return {
    class: decision.class,
    commitBoundary: decision.commitBoundary,
    ...(reason ? { reason } : {}),
  };
}

function strongestDecision(first: BrowserFloorDecision, second?: BrowserFloorDecision): BrowserFloorDecision {
  if (!second) return first;
  const classes = ["read_only", "agentic", "blocked"];
  const boundaries = ["none", "draft", "commit", "external_effect"];
  const secondClassIsStronger = classes.indexOf(second.class) > classes.indexOf(first.class);
  const strongestClass = secondClassIsStronger ? second.class : first.class;
  const firstBoundary = first.commitBoundary;
  const secondBoundary = second.commitBoundary;
  const secondBoundaryIsStronger = boundaries.indexOf(secondBoundary) > boundaries.indexOf(firstBoundary);
  const strongestBoundary = secondBoundaryIsStronger ? secondBoundary : firstBoundary;
  const reasonSource = secondClassIsStronger || (second.class === first.class && secondBoundaryIsStronger) ? second : first;
  const reason = reasonSource.reason ?? (reasonSource === first ? second.reason : first.reason);
  return {
    class: strongestClass,
    commitBoundary: strongestBoundary,
    ...(reason ? { reason } : {}),
  };
}

function response(id: JsonRpcId, result: unknown): ModernMcpResponse {
  const complete = isObject(result)
    ? {
        ...result,
        resultType: "complete",
        _meta: {
          ...(isObject(result._meta) ? result._meta : {}),
          "io.modelcontextprotocol/serverInfo": { name: "newton-browser", version: NEWTON_BROWSER_VERSION },
        },
      }
    : {
        value: result,
        resultType: "complete",
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "newton-browser", version: NEWTON_BROWSER_VERSION } },
      };
  return { jsonrpc: "2.0", id, result: complete };
}

function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): ModernMcpResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function validateRequestMetadata(params: Record<string, unknown> | undefined):
  | { code: number; message: string; data: Record<string, unknown> }
  | null {
  const metadata = isObject(params?._meta) ? params._meta : {};
  const requested = metadata["io.modelcontextprotocol/protocolVersion"];
  if (typeof requested !== "string" || requested.length === 0 || requested.length > 80) {
    return {
      code: -32602,
      message: "Missing MCP protocol version metadata.",
      data: { errorCode: "protocol_version_required" },
    };
  }
  if (requested !== MODERN_MCP_PROTOCOL_VERSION) {
    return {
      code: -32022,
      message: "Unsupported MCP protocol version.",
      data: {
        supported: [MODERN_MCP_PROTOCOL_VERSION],
        requested,
      },
    };
  }
  if (!isObject(metadata["io.modelcontextprotocol/clientCapabilities"])) {
    return {
      code: -32602,
      message: "Missing MCP client capabilities metadata.",
      data: { errorCode: "client_capabilities_required" },
    };
  }
  const clientInfo = metadata["io.modelcontextprotocol/clientInfo"];
  if (clientInfo !== undefined && (!isObject(clientInfo)
    || typeof clientInfo.name !== "string" || clientInfo.name.length === 0 || clientInfo.name.length > 240
    || typeof clientInfo.version !== "string" || clientInfo.version.length === 0 || clientInfo.version.length > 120)) {
    return {
      code: -32602,
      message: "Invalid MCP client info metadata.",
      data: { errorCode: "invalid_client_info" },
    };
  }
  return null;
}

function hasExactParameterKeys(params: Record<string, unknown> | undefined, allowed: readonly string[]): boolean {
  return Boolean(params && Object.keys(params).every((key) => allowed.includes(key)));
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal, cleanup: () => Promise<void>): Promise<T> {
  if (signal.aborted) {
    await cleanup();
    throw new DOMException("The MCP request was cancelled.", "AbortError");
  }
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      void (async () => {
        try { await cleanup(); } catch { /* retained session remains visible for explicit cleanup */ }
        reject(new DOMException("The MCP request was cancelled.", "AbortError"));
      })();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function normalizeAllowedOrigins(value: unknown, origin: string): string[] {
  if (value === undefined) return [origin];
  if (!Array.isArray(value)) throw new Error("invalid_origin");
  if (value.length + 1 > 32) throw new Error("invalid_origin");
  const secondary = value.map(requiredHttpOrigin);
  if (secondary.includes(origin) || new Set(secondary).size !== secondary.length) throw new Error("invalid_origin");
  return [origin, ...secondary];
}

function requiredHttpOrigin(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("origin_required");
  if (value.length > ORIGIN_CAP || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("invalid_origin");
  const trimmed = value.trim();
  const url = new URL(trimmed);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid_origin");
  const canonicalInput = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  if (canonicalInput !== url.origin) throw new Error("invalid_origin");
  return url.origin;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value !== value.trim() || value.length > SESSION_ID_CAP
    || !DIRECT_SESSION_ID.test(value)) {
    throw new Error(`${name}_required`);
  }
  return value;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback;
}

function errorCode(error: unknown): string {
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "";
  if (/^[a-z][a-z0-9_]{0,79}$/u.test(code)) return code;
  const message = error instanceof Error ? error.message : "";
  return /^[a-z][a-z0-9_]{0,79}$/u.test(message) ? message : "tool_error";
}

function publicErrorMessage(code: string): string {
  if (code === "unknown_session") return "The session does not exist.";
  if (code === "invalid_origin" || code === "origin_required") return "The request requires one exact HTTP(S) origin.";
  if (code === "invalid_identity_id") return "The identity ID is invalid.";
  if (code === "invalid_browser_family") return "The browser must be Chrome or Edge.";
  if (code === "direct_cleanup_uncertain") return "Browser cleanup could not be confirmed.";
  return "Newton Browser rejected the request.";
}
