import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { BROWSER_CONTROL_TRANSPORTS, type BrowserControlTransportMode, type BrowserFloorDecision } from "@browser-bridge/core";

import { BROWSER_BRIDGE_VERSION, SUPPORTED_MCP_PROTOCOLS } from "./cli.ts";
import type { BrowserBridgeHost } from "./bridge.ts";
import { createBrowserBridgeHost } from "./bridge.ts";
import { evaluateHostFloor } from "./floor-gate.ts";

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId; method?: string; params?: Record<string, unknown> };
type JsonRpcResponse = { jsonrpc: "2.0"; id: JsonRpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } };
type MessageMode = "framed" | "json-line";
type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolCallResult = { content: ToolContent[]; isError?: boolean };

const LOCAL_TRANSPORTS = new Set<BrowserControlTransportMode>(BROWSER_CONTROL_TRANSPORTS);
const CURRENT_PROTOCOL = SUPPORTED_MCP_PROTOCOLS.at(-1)!;
const INLINE_SCREENSHOT_CAP = 1_000_000;
const SCREENSHOT_BYTES_CAP = 16 * 1024 * 1024;

export async function startBrowserBridgeMcpServer(input: { bridge?: BrowserBridgeHost; port?: number; host?: string } = {}): Promise<void> {
  const readinessTimeoutMs = Number(process.env.BROWSER_BRIDGE_READINESS_TIMEOUT_MS);
  const bridge = input.bridge ?? createBrowserBridgeHost({
    ...(Number.isFinite(readinessTimeoutMs) ? { limits: { readinessTimeoutMs: Math.max(50, readinessTimeoutMs) } } : {}),
  });
  await bridge.listen(input.port, input.host ?? "127.0.0.1");
  await new Promise<void>((resolve) => {
    const parser = new McpFrameParser(async (message, mode) => {
      const response = await handleMcpMessage(bridge, message);
      if (response) writeMessage(response, mode);
    }, (error, mode) => {
      writeMessage(errorResponse(null, -32700, "Malformed MCP frame.", { errorCode: "malformed_frame", detail: error.message }), mode);
    });
    process.stdin.on("data", (chunk) => parser.push(Buffer.from(chunk)));
    process.stdin.on("end", () => {
      void (async () => {
        bridge.stopAll();
        await bridge.close();
        resolve();
      })();
    });
    process.stdin.resume();
  });
}

export async function handleMcpMessage(bridge: BrowserBridgeHost, message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
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
      serverInfo: { name: "browser-bridge", version: BROWSER_BRIDGE_VERSION },
    });
  }
  if (message.method === "ping") return response(id, {});
  if (message.method === "tools/list") return response(id, { tools: toolList() });
  if (message.method === "tools/call") {
    try {
      const params = asObject(message.params ?? {}, "params");
      const name = requiredString(params.name, "name");
      const args = isObject(params.arguments) ? params.arguments : {};
      return response(id, await callTool(bridge, name, args));
    } catch (error) {
      return response(id, toolError(errorCode(error), error instanceof Error ? error.message : String(error)));
    }
  }
  return errorResponse(id, -32601, `Unsupported MCP method: ${message.method ?? "unknown"}.`);
}

async function callTool(bridge: BrowserBridgeHost, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  const transport = resolveTransport(args.transport);
  if (!LOCAL_TRANSPORTS.has(transport)) return toolError("unsupported_transport", "Only local Browser Bridge transports are supported.");

  if (name === "browser.status") {
    const status = bridge.getStatus();
    return toolJson({
      ready: status.extensionConnected,
      version: BROWSER_BRIDGE_VERSION,
      protocolVersions: SUPPORTED_MCP_PROTOCOLS,
      ...status,
      paired: true,
      hostCountSeenByExtension: status.authenticatedClientCount,
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
      instanceLabel: typeof args.instanceLabel === "string" ? args.instanceLabel.slice(0, 120) : "mcp",
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

  if (["browser.observe", "browser.screenshot", "browser.act"].includes(name)) {
    const sessionId = requiredString(args.sessionId, "sessionId");
    const session = bridge.listSessions().find((candidate) => candidate.sessionId === sessionId);
    if (!session) return toolError("unknown_session", "The session does not exist.");
    const action = prepareActionForRelay(actionForTool(name, args));
    const verdict = evaluateHostFloor({ session, action });
    if (!verdict.relay) return toolJson({ ok: false, errorCode: verdict.errorCode, decision: publicDecision(verdict.decision), transport }, true);
    const event = await bridge.dispatch(sessionId, verdict.action);
    if (!event.ok) return toolJson({ ok: false, errorCode: event.errorCode, decision: publicDecision(event.decision ?? verdict.decision), transport }, true);
    const decision = strongestDecision(verdict.decision, event.decision);
    if (name === "browser.screenshot") return screenshotToolResult(event.result, decision, args);
    if (name === "browser.act") {
      const result = isObject(event.result) ? event.result : { value: event.result };
      return toolJson({
        ok: true,
        actionStatus: typeof result.actionStatus === "string" ? result.actionStatus : typeof result.status === "string" ? result.status : "verified",
        decision: publicDecision(decision),
        result,
        transport,
      });
    }
    return toolJson({ ok: true, result: event.result, transport });
  }
  return toolError("unknown_tool", `Unknown tool: ${name}`);
}

function actionForTool(name: string, args: Record<string, unknown>): unknown {
  if (name === "browser.observe") {
    return { kind: "observe", mode: args.mode === "diff" ? "diff" : "full", maxNodes: clampNumber(args.maxNodes, 80, 1, 250) };
  }
  if (name === "browser.screenshot") {
    return {
      kind: "screenshot",
      fullPage: Boolean(args.fullPage),
      inline: true,
      device: args.device === "mobile" ? "mobile" : args.device === "desktop" ? "desktop" : undefined,
      waitMs: clampNumber(args.waitMs, 0, 0, 10_000),
    };
  }
  return isObject(args.action) ? args.action : {};
}

function prepareActionForRelay(raw: unknown): unknown {
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
    return value;
  });
  return { ...raw, files };
}

function screenshotToolResult(raw: unknown, decision: BrowserFloorDecision, args: Record<string, unknown>): ToolCallResult {
  if (!isObject(raw) || typeof raw.dataUrl !== "string") return toolError("screenshot_unavailable", "The extension returned no screenshot bytes.");
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(raw.dataUrl);
  if (!match?.[1]) return toolError("invalid_screenshot", "The extension returned malformed screenshot bytes.");
  const buffer = Buffer.from(match[1], "base64");
  if (buffer.length > SCREENSHOT_BYTES_CAP) return toolError("result_too_large", "Screenshot exceeds the 16 MiB result bound.", { recommendedDelivery: "file" });
  const metadata = { ...raw } as Record<string, unknown>;
  delete metadata.dataUrl;
  delete metadata.inline;
  const delivery = args.delivery === "file" || args.delivery === "inline" ? args.delivery : "image";
  const common = { ok: true, delivery, decision: publicDecision(decision), ...metadata };
  if (delivery === "image") {
    return { content: [{ type: "text", text: JSON.stringify(common) }, { type: "image", data: match[1], mimeType: "image/png" }] };
  }
  if (delivery === "inline") {
    if (raw.dataUrl.length > INLINE_SCREENSHOT_CAP) return toolError("result_too_large", "Inline screenshot exceeds the 1,000,000 character bound.", { recommendedDelivery: "image" });
    return toolJson({ ...common, dataUrl: raw.dataUrl });
  }
  try {
    return toolJson(writeScreenshotFile(buffer, common, args));
  } catch (error) {
    return toolError(errorCode(error), error instanceof Error ? error.message : String(error));
  }
}

function writeScreenshotFile(buffer: Buffer, metadata: Record<string, unknown>, args: Record<string, unknown>) {
  const rawDirectory = requiredString(args.outputDirectory, "outputDirectory");
  if (!path.isAbsolute(rawDirectory)) throw new Error("output_directory_must_be_absolute");
  const directory = path.resolve(rawDirectory);
  fs.mkdirSync(directory, { recursive: true });
  const requested = typeof args.filename === "string" ? path.basename(args.filename.trim()) : "";
  const base = requested && /^[A-Za-z0-9._-]+\.png$/i.test(requested)
    ? requested
    : `browser-bridge-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  let output = path.join(directory, base);
  if (path.dirname(output) !== directory) throw new Error("invalid_output_filename");
  if (fs.existsSync(output)) output = path.join(directory, `${path.parse(base).name}-${Date.now()}.png`);
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
    tool("browser.status", "Report local host, extension, protocol, pairing, and limit readiness.", { transport }),
    tool("browser.session.start", "Start and attach an origin-scoped browser session.", {
      transport,
      origin: { type: "string" },
      allowedOrigins: { type: "array", items: { type: "string" } },
      goal: { type: "string" },
      tabMode: { type: "string", enum: ["owned_group", "current"] },
      instanceLabel: { type: "string" },
    }, ["origin"]),
    tool("browser.observe", "Observe the current session tab.", { transport, sessionId: { type: "string" }, mode: { type: "string", enum: ["full", "diff"] }, maxNodes: { type: "number" } }, ["sessionId"]),
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

function writeMessage(message: JsonRpcResponse, mode: MessageMode): void {
  const body = JSON.stringify(message);
  process.stdout.write(mode === "json-line" ? `${body}\n` : `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

class McpFrameParser {
  private buffer = Buffer.alloc(0);
  private draining = false;
  private framesSeen = 0;
  private readonly onMessage: (message: JsonRpcRequest, mode: MessageMode) => Promise<void>;
  private readonly onError: (error: Error, mode: MessageMode) => void;

  constructor(
    onMessage: (message: JsonRpcRequest, mode: MessageMode) => Promise<void>,
    onError: (error: Error, mode: MessageMode) => void,
  ) {
    this.onMessage = onMessage;
    this.onError = onError;
  }

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (true) {
        try {
          const lineMessage = this.readJsonLineMessage();
          if (lineMessage) {
            this.framesSeen += 1;
            await this.onMessage(lineMessage, "json-line");
            continue;
          }
          const headerEnd = findHeaderEnd(this.buffer);
          if (headerEnd.index < 0) return;
          const headerText = this.buffer.subarray(0, headerEnd.index).toString("utf8");
          const contentLength = parseContentLength(headerText);
          if (contentLength === null) throw new Error("missing_content_length");
          const frameEnd = headerEnd.index + headerEnd.length + contentLength;
          if (this.buffer.length < frameEnd) return;
          const body = this.buffer.subarray(headerEnd.index + headerEnd.length, frameEnd).toString("utf8");
          this.buffer = this.buffer.subarray(frameEnd);
          this.framesSeen += 1;
          await this.onMessage(JSON.parse(body) as JsonRpcRequest, "framed");
        } catch (error) {
          const mode = this.buffer.toString("utf8").trimStart().startsWith("{") ? "json-line" : "framed";
          this.buffer = Buffer.alloc(0);
          this.onError(error instanceof Error ? error : new Error(String(error)), mode);
          return;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private readJsonLineMessage(): JsonRpcRequest | null {
    const text = this.buffer.toString("utf8");
    const trimmedStart = text.trimStart();
    if (!trimmedStart.startsWith("{")) return null;
    const skipped = text.length - trimmedStart.length;
    const newline = trimmedStart.indexOf("\n");
    if (newline < 0) return null;
    const line = trimmedStart.slice(0, newline).trim();
    const parsed = line ? JSON.parse(line) as JsonRpcRequest : null;
    this.buffer = this.buffer.subarray(skipped + newline + 1);
    return parsed;
  }
}

function findHeaderEnd(buffer: Buffer): { index: number; length: number } {
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf >= 0) return { index: crlf, length: 4 };
  const lf = buffer.indexOf("\n\n");
  return lf >= 0 ? { index: lf, length: 2 } : { index: -1, length: 0 };
}

function parseContentLength(headerText: string): number | null {
  const match = headerText.match(/^content-length:\s*(\d+)\s*$/im);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
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
