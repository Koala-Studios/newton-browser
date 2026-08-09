import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import { BROWSER_CONTROL_TRANSPORTS, classifyVersionSkew, parseBrowserAction, redactBrowserResult, type BrowserControlTransportMode, type BrowserFloorDecision } from "@newton-browser/core";

import { NEWTON_BROWSER_VERSION, SUPPORTED_MCP_PROTOCOLS } from "./cli.ts";
import type { NewtonBrowserHost } from "./bridge.ts";
import { createNewtonBrowserHost } from "./bridge.ts";
import { McpFrameParser, McpFrameParseError, type McpMessageMode } from "./mcp-frame-parser.ts";
import { evaluateHostFloor } from "./floor-gate.ts";

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId; method?: string; params?: Record<string, unknown> };
type JsonRpcResponse = { jsonrpc: "2.0"; id: JsonRpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } };
type MessageMode = McpMessageMode;
type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolCallResult = { content: ToolContent[]; isError?: boolean };

const LOCAL_TRANSPORTS = new Set<BrowserControlTransportMode>(BROWSER_CONTROL_TRANSPORTS);
const CURRENT_PROTOCOL = SUPPORTED_MCP_PROTOCOLS.at(-1)!;
const INLINE_SCREENSHOT_CAP = 1_000_000;
const SCREENSHOT_BYTES_CAP = 16 * 1024 * 1024;

export async function startNewtonBrowserMcpServer(input: { bridge?: NewtonBrowserHost; port?: number; host?: string } = {}): Promise<void> {
  const readinessTimeoutMs = Number(process.env.NEWTON_BROWSER_READINESS_TIMEOUT_MS);
  const bridge = input.bridge ?? createNewtonBrowserHost({
    ...(Number.isFinite(readinessTimeoutMs) ? { limits: { readinessTimeoutMs: Math.max(50, readinessTimeoutMs) } } : {}),
    observerRegistryDirectory: process.env.NEWTON_BROWSER_OBSERVER_REGISTRY_DIR,
    observerToken: process.env.NEWTON_BROWSER_OBSERVER_TOKEN,
  });
  let startupErrorCode: string | undefined;
  try {
    await bridge.listen(input.port, input.host ?? "127.0.0.1");
  } catch (error) {
    const code = errorCode(error);
    if (code !== "host_collision") throw error;
    startupErrorCode = code;
  }
  await serveNewtonBrowserMcpConnection({ bridge, readable: process.stdin, writable: process.stdout, startupErrorCode });
  bridge.stopAll();
  await bridge.close();
}

export async function serveNewtonBrowserMcpConnection(input: {
  bridge: NewtonBrowserHost;
  readable: Readable;
  writable: Writable;
  startupErrorCode?: string;
}): Promise<void> {
  let observedMode: MessageMode | null = null;
  let complete = false;
  let errorResponded = false;
  let serveResolve: () => void = () => {};
  let serveReject: (error: unknown) => void = () => {};
  const serveDone = new Promise<void>((resolve, reject) => {
    serveResolve = resolve;
    serveReject = reject;
  });

  const writeErrorResponse = (error: McpFrameParseError, mode: MessageMode): void => {
    if (errorResponded) return;
    errorResponded = true;
    writeMessage(input.writable, typedParserErrorResponse(error, mode), mode);
  };

  const parser = new McpFrameParser(
    async (message, mode) => {
      const response = await handleMcpMessage(input.bridge, message, { startupErrorCode: input.startupErrorCode });
      if (response) writeMessage(input.writable, response, mode);
    },
    async (error, mode) => writeErrorResponse(error, mode),
  );

  const cleanup = () => {
    input.readable.off("data", onData);
    input.readable.off("end", onEnd);
    input.readable.off("close", onEnd);
    input.readable.off("error", onReadableError);
  };

  const finalize = async (): Promise<void> => {
    if (complete) return;
    complete = true;
    try {
      parser.end();
      await parser.flush();
      serveResolve();
    } catch (error) {
      serveReject(error);
    } finally {
      cleanup();
    }
  };

  const onEnd = () => {
    void finalize();
  };

  const onReadableError = () => {
    void finalize();
  };

  const onData = (chunk: Buffer) => {
    if (observedMode === null) observedMode = detectIncomingMode(chunk);
    parser.push(chunk);
  };

  input.readable.on("data", onData);
  input.readable.on("end", onEnd);
  input.readable.on("close", onEnd);
  input.readable.on("error", onReadableError);
  input.readable.resume();

  await serveDone;
  return;

  function typedParserErrorResponse(error: McpFrameParseError, mode: MessageMode): JsonRpcResponse {
    return errorResponse(null, -32700, `Malformed MCP frame (${mode} mode).`, { errorCode: error.code });
  }

  function detectIncomingMode(chunk: Buffer): MessageMode | null {
    for (const value of chunk) {
      if (value === 0x20 || value === 0x09 || value === 0x0a || value === 0x0d || value === 0x0b || value === 0x0c) {
        continue;
      }
      return value === 0x7b ? "json-line" : "framed";
    }
    return null;
  }
}

export async function handleMcpMessage(bridge: NewtonBrowserHost, message: JsonRpcRequest, input: { startupErrorCode?: string } = {}): Promise<JsonRpcResponse | null> {
  if (message.id === undefined && message.method?.startsWith("notifications/")) return null;
  const id = message.id ?? null;
  if (message.method === "initialize") {
    const params = isObject(message.params) ? message.params : {};
    const selected = negotiateProtocol(params);
    if (!selected) {
      return errorResponse(id, -32001, "No supported MCP protocol version.", {
        errorCode: "protocol_mismatch",
        supportedProtocolVersions: SUPPORTED_MCP_PROTOCOLS,
      });
    }
    return response(id, {
      protocolVersion: selected,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "newton-browser", version: NEWTON_BROWSER_VERSION },
    });
  }
  if (message.method === "ping") return response(id, {});
  if (message.method === "tools/list") return response(id, { tools: toolList() });
  if (message.method === "tools/call") {
    try {
      const params = asObject(message.params ?? {}, "params");
      const name = requiredString(params.name, "name");
      const args = isObject(params.arguments) ? params.arguments : {};
      return response(id, await callTool(bridge, name, args, input));
    } catch (error) {
      return response(id, toolError(errorCode(error), error instanceof Error ? error.message : String(error)));
    }
  }
  return errorResponse(id, -32601, `Unsupported MCP method: ${message.method ?? "unknown"}.`);
}

async function callTool(bridge: NewtonBrowserHost, name: string, args: Record<string, unknown>, input: { startupErrorCode?: string } = {}): Promise<ToolCallResult> {
  const transport = resolveTransport(args.transport);
  if (!LOCAL_TRANSPORTS.has(transport)) return toolError("unsupported_transport", "Only local Newton Browser transports are supported.");
  if (input.startupErrorCode) {
    return toolError(input.startupErrorCode, "No loopback port is available in the configured Newton Browser range.", {
      nextAction: "stop_stale_newton_browser_hosts_or_free_a_configured_port",
    });
  }

  if (name === "browser.status") {
    const status = bridge.getStatus();
    const versionSkew = classifyVersionSkew(NEWTON_BROWSER_VERSION, status.extensionVersion);
    const nextAction = versionSkew === "incompatible"
      ? status.extensionVersion && status.extensionVersion > NEWTON_BROWSER_VERSION ? "update the npm package" : "update the extension"
      : undefined;
    return toolJson({
      ready: status.extensionConnected,
      version: NEWTON_BROWSER_VERSION,
      protocolVersions: SUPPORTED_MCP_PROTOCOLS,
      ...status,
      paired: status.authMode === "paired" && status.extensionConnected,
      zeroTouch: status.authMode === "local_trust",
      hostCountSeenByExtension: status.eligibleClientCount,
      hostVersion: NEWTON_BROWSER_VERSION,
      extensionVersion: status.extensionVersion,
      versionSkew: versionSkew === "unknown" ? "none" : versionSkew,
      ...(nextAction ? { nextAction } : {}),
    }, !status.extensionConnected, status.extensionConnected ? undefined : "extension_disconnected");
  }

  if (name === "browser.session.start") {
    const origin = requiredHttpOrigin(args.origin);
    const allowedOrigins = normalizeAllowedOrigins(args.allowedOrigins, origin);
    const created = bridge.createSession({
      origin,
      allowedOrigins,
      goal: typeof args.goal === "string" ? args.goal.slice(0, 240) : "",
      tabMode: args.tabMode === "current" ? "current" : "owned_group",
      instanceLabel: process.env.NEWTON_BROWSER_INSTANCE_LABEL?.trim().slice(0, 120)
        || (typeof args.instanceLabel === "string" ? args.instanceLabel.slice(0, 120) : "mcp"),
      ...(args.incognito === true && args.tabMode !== "current" ? { incognito: true } : {}),
    });
    try {
      const session = await bridge.waitForSessionReady(created.sessionId);
      if (!session.liveOrigin || !allowedOrigins.includes(session.liveOrigin)) {
        bridge.stopSession(created.sessionId);
        return toolError("origin_not_granted", "The attached tab is outside the session origin grant.");
      }
      return toolJson({ sessionId: created.sessionId, transport, session });
    } catch (error) {
      return toolError(errorCode(error), error instanceof Error ? error.message : String(error));
    }
  }

  if (name === "browser.tabs.list") return toolJson({ transport, sessions: bridge.listSessions() });
  if (name === "browser.session.stop") {
    bridge.stopSession(requiredString(args.sessionId, "sessionId"));
    return toolJson({ stopped: true, transport });
  }
  if (name === "browser.tabs.finalize") {
    const sessionId = requiredString(args.sessionId, "sessionId");
    const disposition = typeof args.disposition === "string" && ["close", "deliverable", "handoff"].includes(args.disposition)
      ? args.disposition
      : null;
    if (!disposition) return toolError("invalid_finalize_disposition", "Disposition must be close, deliverable, or handoff.");
    const event = await bridge.dispatch(sessionId, { kind: "__finalize", disposition } as any);
    if (!event.ok) return toolError(event.errorCode, event.errorCode);
    return toolJson({ ok: true, ...(isObject(event.result) ? event.result : {}), transport });
  }
  if (name === "browser.stop_all") {
    bridge.stopAll();
    return toolJson({ stopped: true, transport });
  }

  if (name === "browser.console" || name === "browser.network") {
    const sessionId = requiredString(args.sessionId, "sessionId");
    const session = bridge.listSessions().find((candidate) => candidate.sessionId === sessionId);
    if (!session) return toolError("unknown_session", "The session does not exist.");
    const action = name === "browser.console"
      ? { kind: "console", level: args.level, pattern: args.pattern, limit: clampNumber(args.limit, 100, 1, 500), clear: args.clear === true }
      : { kind: "network", urlPattern: args.urlPattern, requestId: args.requestId, limit: clampNumber(args.limit, 100, 1, 500) };
    const event = await bridge.dispatch(sessionId, action as never);
    if (!event.ok) return toolJson({ ok: false, errorCode: event.errorCode, transport }, true);
    return toolJson({ ok: true, result: redactObservationResult(event.result), transport });
  }

  if (["browser.observe", "browser.screenshot", "browser.act"].includes(name)) {
    const sessionId = requiredString(args.sessionId, "sessionId");
    const session = bridge.listSessions().find((candidate) => candidate.sessionId === sessionId);
    if (!session) return toolError("unknown_session", "The session does not exist.");
    const action = prepareActionForRelay(actionForTool(name, args));
    if (name === "browser.act" && isObject(action) && action.kind === "handle_dialog") {
      return toolJson({
        ok: false,
        errorCode: "use_dialog_accept_or_dismiss",
        message: "Use action kind \"dialog_accept\" (optionally with promptText) or \"dialog_dismiss\" to respond to a JavaScript dialog.",
        decision: { class: "blocked", commitBoundary: "none", reasons: ["use_dialog_accept_or_dismiss"] },
        transport,
      }, true);
    }
    if (name === "browser.act" && isObject(action) && action.kind === "fill_form") {
      return await runFillForm(bridge, sessionId, session, action, transport);
    }
    const verdict = evaluateHostFloor({ session, action });
    if (!verdict.relay) return toolJson({ ok: false, errorCode: verdict.errorCode, decision: publicDecision(verdict.decision), transport }, true);
    const event = await bridge.dispatch(sessionId, verdict.action);
    if (!event.ok) return toolJson({ ok: false, errorCode: event.errorCode, decision: publicDecision(event.decision ?? verdict.decision), transport }, true);
    const decision = strongestDecision(verdict.decision, event.decision);
    if (name === "browser.screenshot") return screenshotToolResult(event.result, decision, args);
    if (name === "browser.act") {
      const result = isObject(event.result) ? redactObservationResult(event.result) : { value: event.result };
      return toolJson({
        ok: true,
        actionStatus: typeof result.actionStatus === "string" ? result.actionStatus : typeof result.status === "string" ? result.status : "verified",
        decision: publicDecision(decision),
        result,
        transport,
      });
    }
    return toolJson({ ok: true, result: redactObservationResult(event.result), transport });
  }
  return toolError("unknown_tool", `Unknown tool: ${name}`);
}

// fill_form (WS9.8): one MCP call fills an ordered set of fields. The batch is
// expanded host-side into sequential single fills, each getting the full per-field
// floor (host hints + driver resolved facts) and redaction. It stops at the first
// blocked or failed field and reports a per-field summary, so a sensitive field in
// the middle of a form halts the batch exactly like a standalone fill would.
async function runFillForm(
  bridge: NewtonBrowserHost,
  sessionId: string,
  session: unknown,
  action: Record<string, unknown>,
  transport: BrowserControlTransportMode,
): Promise<ToolCallResult> {
  const parsed = parseBrowserAction(action);
  const fields = Array.isArray(parsed.fields) ? parsed.fields : [];
  if (fields.length === 0) return toolError("fill_form_requires_fields", "fill_form needs a non-empty fields array, each with a target and value.");
  const results: Array<{ index: number; status: string; reason?: string }> = [];
  let strongest: BrowserFloorDecision | undefined;
  let lastObservation: unknown;
  for (let index = 0; index < fields.length; index += 1) {
    const fillAction = { kind: "fill", ...fields[index] };
    const verdict = evaluateHostFloor({ session: session as never, action: fillAction });
    strongest = strongest ? strongestDecision(strongest, verdict.decision) : verdict.decision;
    if (!verdict.relay) {
      results.push({ index, status: "blocked", reason: verdict.decision.reasons.at(-1) ?? "blocked_by_floor" });
      return toolJson({ ok: false, errorCode: "blocked_by_floor", stoppedAt: index, fields: results, decision: publicDecision(strongest), transport }, true);
    }
    const event = await bridge.dispatch(sessionId, verdict.action);
    if (!event.ok) {
      results.push({ index, status: "failed", reason: event.errorCode });
      return toolJson({ ok: false, errorCode: event.errorCode, stoppedAt: index, fields: results, decision: publicDecision(strongest), transport }, true);
    }
    strongest = event.decision ? strongestDecision(strongest, event.decision) : strongest;
    const result = isObject(event.result) ? event.result : {};
    lastObservation = redactObservationResult(event.result);
    const status = typeof result.actionStatus === "string" ? result.actionStatus : typeof result.status === "string" ? result.status : "verified";
    results.push({ index, status, ...(typeof result.reason === "string" ? { reason: result.reason } : {}) });
    if (status !== "verified" && status !== "dispatched_unverified") {
      return toolJson({ ok: false, errorCode: "fill_form_field_incomplete", stoppedAt: index, fields: results, decision: publicDecision(strongest), transport }, true);
    }
  }
  return toolJson({ ok: true, actionStatus: "verified", filled: results.length, fields: results, decision: publicDecision(strongest), observation: lastObservation, transport });
}

function actionForTool(name: string, args: Record<string, unknown>): unknown {
  if (name === "browser.observe") {
    if (args.mode === "text") {
      return { kind: "observe", mode: "text", maxChars: clampNumber(args.maxChars, 20_000, 200, 200_000) };
    }
    return { kind: "observe", mode: args.mode === "diff" ? "diff" : "full", maxNodes: clampNumber(args.maxNodes, 80, 1, 250) };
  }
  if (name === "browser.screenshot") {
    const region = isObject(args.region) ? args.region : null;
    const clip = region && ["x", "y", "width", "height"].every((key) => Number.isFinite(Number(region[key])))
      ? { x: Number(region.x), y: Number(region.y), width: Number(region.width), height: Number(region.height) }
      : undefined;
    return {
      kind: "screenshot",
      fullPage: Boolean(args.fullPage),
      inline: true,
      device: args.device === "mobile" ? "mobile" : args.device === "desktop" ? "desktop" : undefined,
      waitMs: clampNumber(args.waitMs, 0, 0, 10_000),
      ...(clip ? { clip } : {}),
      ...(args.format === "jpeg" ? { format: "jpeg", quality: clampNumber(args.quality, 70, 1, 100) } : {}),
    };
  }
  return isObject(args.action) ? args.action : {};
}

export function prepareActionForRelay(raw: unknown): unknown {
  if (!isObject(raw) || raw.kind !== "set_files") return raw;
  if (!Array.isArray(raw.files)) throw new Error("files_required");
  if (raw.files.length > 8) throw new Error("file_count_exceeded");
  let total = 0;
  const files = raw.files.map((value) => {
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
  return { ...raw, files };
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

function screenshotToolResult(raw: unknown, decision: BrowserFloorDecision, args: Record<string, unknown>): ToolCallResult {
  if (!isObject(raw) || typeof raw.dataUrl !== "string") return toolError("screenshot_unavailable", "The extension returned no screenshot bytes.");
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(raw.dataUrl);
  if (!match?.[2]) return toolError("invalid_screenshot", "The extension returned malformed screenshot bytes.");
  const imageMime = `image/${match[1]}`;
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > SCREENSHOT_BYTES_CAP) return toolError("result_too_large", "Screenshot exceeds the 16 MiB result bound.", { recommendedDelivery: "file" });
  const metadata = { ...raw } as Record<string, unknown>;
  delete metadata.dataUrl;
  delete metadata.inline;
  const delivery = args.delivery === "file" || args.delivery === "inline" ? args.delivery : "image";
  const common = { ok: true, delivery, decision: publicDecision(decision), ...metadata };
  if (delivery === "image") {
    return { content: [{ type: "text", text: JSON.stringify(common) }, { type: "image", data: match[2], mimeType: imageMime }] };
  }
  if (delivery === "inline") {
    if (raw.dataUrl.length > INLINE_SCREENSHOT_CAP) return toolError("result_too_large", "Inline screenshot exceeds the 1,000,000 character bound.", { recommendedDelivery: "image" });
    return toolJson({ ...common, dataUrl: raw.dataUrl });
  }
  try {
    return toolJson(writeScreenshotFile(buffer, common, args, match[1] === "jpeg" ? "jpg" : "png"));
  } catch (error) {
    return toolError(errorCode(error), error instanceof Error ? error.message : String(error));
  }
}

function writeScreenshotFile(buffer: Buffer, metadata: Record<string, unknown>, args: Record<string, unknown>, ext = "png") {
  const rawDirectory = requiredString(args.outputDirectory, "outputDirectory");
  if (!path.isAbsolute(rawDirectory)) throw new Error("output_directory_must_be_absolute");
  const directory = path.resolve(rawDirectory);
  fs.mkdirSync(directory, { recursive: true });
  const requested = typeof args.filename === "string" ? path.basename(args.filename.trim()) : "";
  const base = requested && new RegExp(`^[A-Za-z0-9._-]+\\.${ext}$`, "i").test(requested)
    ? requested
    : `newton-browser-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
  let output = path.join(directory, base);
  if (path.dirname(output) !== directory) throw new Error("invalid_output_filename");
  if (fs.existsSync(output)) output = path.join(directory, `${path.parse(base).name}-${Date.now()}.${ext}`);
  fs.writeFileSync(output, buffer, { flag: "wx", mode: 0o600 });
  return {
    ...metadata,
    path: output,
    filename: path.basename(output),
    bytes: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

function toolList(): Array<Record<string, unknown>> {
  const transport = { type: "string", enum: BROWSER_CONTROL_TRANSPORTS };
  return [
    tool("browser.status", "Report local host, extension, protocol, authentication mode, and limit readiness.", { transport }),
    tool("browser.session.start", "Start and attach an origin-scoped browser session.", {
      transport,
      origin: { type: "string" },
      allowedOrigins: { type: "array", items: { type: "string" } },
      goal: { type: "string" },
      tabMode: { type: "string", enum: ["owned_group", "current"] },
      instanceLabel: { type: "string" },
      incognito: { type: "boolean" },
    }, ["origin"]),
    tool("browser.observe", "Observe the current session tab. mode:\"text\" returns bounded, redacted readable page text instead of the accessibility tree.", { transport, sessionId: { type: "string" }, mode: { type: "string", enum: ["full", "diff", "text"] }, maxNodes: { type: "number" }, maxChars: { type: "number" } }, ["sessionId"]),
    tool("browser.act", "Run one typed browser action and return its floor decision.", { transport, sessionId: { type: "string" }, action: { type: "object" } }, ["sessionId", "action"]),
    tool("browser.screenshot", "Capture and deliver a screenshot.", {
      transport,
      sessionId: { type: "string" },
      delivery: { type: "string", enum: ["image", "file", "inline"] },
      outputDirectory: { type: "string" },
      filename: { type: "string" },
      fullPage: { type: "boolean" },
      device: { type: "string", enum: ["mobile", "desktop"] },
      waitMs: { type: "number" },
      region: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } } },
      format: { type: "string", enum: ["png", "jpeg"] },
      quality: { type: "number" },
    }, ["sessionId"]),
    tool("browser.console", "Read the session tab's buffered console output (read-only). Filter by level/pattern; clear:true empties the buffer. Headers and raw objects are never included.", {
      transport, sessionId: { type: "string" }, level: { type: "string", enum: ["log", "info", "warn", "error", "debug"] }, pattern: { type: "string" }, limit: { type: "number" }, clear: { type: "boolean" },
    }, ["sessionId"]),
    tool("browser.network", "List the session tab's buffered network request metadata (read-only, no headers). Pass requestId to fetch one response body, returned only when its URL origin is within the session grant.", {
      transport, sessionId: { type: "string" }, urlPattern: { type: "string" }, requestId: { type: "string" }, limit: { type: "number" },
    }, ["sessionId"]),
    tool("browser.tabs.list", "List this host's local sessions.", { transport }),
    tool("browser.tabs.finalize", "Close, retain, or hand off one session tab.", {
      transport,
      sessionId: { type: "string" },
      disposition: { type: "string", enum: ["close", "deliverable", "handoff"] },
    }, ["sessionId", "disposition"]),
    tool("browser.session.stop", "Stop one local session.", { transport, sessionId: { type: "string" } }, ["sessionId"]),
    tool("browser.stop_all", "Stop all local sessions.", { transport }),
  ];
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}

function toolJson(value: unknown, isError = false, errorCodeValue?: string): ToolCallResult {
  const normalized = errorCodeValue && isObject(value) ? { ...value, errorCode: errorCodeValue } : value;
  return { content: [{ type: "text", text: JSON.stringify(normalized) }], ...(isError ? { isError: true } : {}) };
}

function toolError(code: string, message: string, detail: Record<string, unknown> = {}): ToolCallResult {
  return toolJson({ ok: false, errorCode: code, message, ...detail }, true);
}

// Secret/PII redaction of observation results before they reach the MCP client
// (the model). The driver produces raw accessible names, values, and page text on
// the loopback relay; the host is the exfiltration boundary, so redaction runs here
// (as the driver's own comment documents). Only real observation kinds are touched —
// finalize acks and other control results pass through unchanged.
function redactObservationResult(result: unknown): any {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const kind = (result as Record<string, unknown>).kind;
    if (kind === "observation" || kind === "observation_delta" || kind === "observation_text" || kind === "console_log" || kind === "network_log") {
      return redactBrowserResult(result) ?? result;
    }
  }
  return result;
}

function publicDecision(decision: BrowserFloorDecision | undefined) {
  return {
    class: decision?.class ?? "blocked",
    commitBoundary: decision?.commitBoundary ?? "none",
    reasons: Array.isArray(decision?.reasons) ? decision.reasons : [],
  };
}

function strongestDecision(first: BrowserFloorDecision, second?: BrowserFloorDecision): BrowserFloorDecision {
  if (!second) return first;
  const classes = ["read_only", "agentic", "approval_required", "blocked"];
  const boundaries = ["none", "draft", "commit", "external_effect"];
  const strongestClass = classes.indexOf(second.class) > classes.indexOf(first.class) ? second.class : first.class;
  const firstBoundary = first.commitBoundary ?? "none";
  const secondBoundary = second.commitBoundary ?? "none";
  const strongestBoundary = boundaries.indexOf(secondBoundary) > boundaries.indexOf(firstBoundary) ? secondBoundary : firstBoundary;
  return { ...first, ...second, class: strongestClass, commitBoundary: strongestBoundary, reasons: [...new Set([...first.reasons, ...second.reasons])] };
}

function negotiateProtocol(params: Record<string, unknown>): string | null {
  const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : null;
  if (requested && SUPPORTED_MCP_PROTOCOLS.includes(requested as never)) return requested;
  const offered = Array.isArray(params.protocolVersions) ? params.protocolVersions.filter((value): value is string => typeof value === "string") : [];
  for (const candidate of [...SUPPORTED_MCP_PROTOCOLS].reverse()) if (offered.includes(candidate)) return candidate;
  return requested || offered.length > 0 ? null : CURRENT_PROTOCOL;
}

function response(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function resolveTransport(value: unknown): BrowserControlTransportMode {
  if (value === undefined) return "auto";
  return typeof value === "string" && BROWSER_CONTROL_TRANSPORTS.includes(value as BrowserControlTransportMode)
    ? value as BrowserControlTransportMode
    : "invalid" as BrowserControlTransportMode;
}

function writeMessage(writable: Writable, message: JsonRpcResponse, mode: MessageMode): void {
  const body = JSON.stringify(message);
  writable.write(mode === "json-line" ? `${body}\n` : `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function normalizeAllowedOrigins(value: unknown, origin: string): string[] {
  if (value === undefined) return [origin];
  if (!Array.isArray(value) || value.length === 0) throw new Error("invalid_origin");
  return [...new Set(value.map(requiredHttpOrigin))];
}

function requiredHttpOrigin(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("origin_required");
  const trimmed = value.trim();
  const url = new URL(trimmed);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid_origin");
  const canonicalInput = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  if (canonicalInput !== url.origin) throw new Error("invalid_origin");
  return url.origin;
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${name}_must_be_an_object`);
  return value;
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name}_required`);
  return value.trim();
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback;
}

function errorCode(error: unknown): string {
  return String((error as Error)?.message ?? error ?? "tool_error").split(":")[0]!.replace(/[^a-z0-9_]+/gi, "_").toLowerCase();
}
