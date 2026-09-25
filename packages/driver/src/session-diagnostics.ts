import { EngineError } from "@newton-browser/core";

type RecordValue = Record<string, unknown>;
type Send = (method: string, params?: RecordValue) => Promise<RecordValue>;
const object = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";

export type DiagnosticKind = "console" | "network";
export type ConsoleEntry = { pageId: string; level: "log" | "info" | "warn" | "error" | "debug"; text: string; source?: string; at: string };
export type NetworkEntry = { requestId: string; pageId: string; method: string; url: string; resourceType?: string; status?: number;
  mimeType?: string; failed?: string; bytes?: number; at: string };

const CONSOLE_MAX = 500, NETWORK_MAX = 500, TEXT_MAX = 2000, URL_MAX = 2048;

/**
 * Console and network records for one session, collected only after the session asks
 * for them: enabling the Runtime domain is observable to pages, so nothing is enabled
 * by default. Network records are metadata; headers are never kept.
 */
export class SessionDiagnostics {
  private readonly enabled = new Set<DiagnosticKind>();
  private console: ConsoleEntry[] = [];
  private consoleDropped = 0;
  private readonly network = new Map<string, NetworkEntry>();
  private networkDropped = 0;
  private readonly requestRoutes = new Map<string, string>();

  isEnabled(kind: DiagnosticKind): boolean { return this.enabled.has(kind); }

  /** Turn collection on; `routes` are the session's attached page and frame routes. */
  async enable(kind: DiagnosticKind, routes: Iterable<[string, Send]>): Promise<boolean> {
    if (this.enabled.has(kind)) return false;
    this.enabled.add(kind);
    await Promise.all([...routes].map(([, send]) => this.enableRoute(kind, send).catch(() => undefined)));
    return true;
  }

  /** Called for every newly attached route. */
  async attachRoute(send: Send): Promise<void> {
    for (const kind of this.enabled) await this.enableRoute(kind, send);
  }

  private async enableRoute(kind: DiagnosticKind, send: Send): Promise<void> {
    if (kind === "console") { await send("Runtime.enable"); await send("Log.enable"); }
    else await send("Network.enable", { maxTotalBufferSize: 4 * 1024 * 1024, maxResourceBufferSize: 1024 * 1024 });
  }

  handle(event: { method: string; params: RecordValue; sessionId?: string | null }, pageOf: (route: string) => string | undefined): void {
    if (!this.enabled.size || !event.method.startsWith("Runtime.") && !event.method.startsWith("Log.") && !event.method.startsWith("Network.")) return;
    const route = event.sessionId ?? "", pageId = pageOf(route);
    if (!pageId) return;
    const params = event.params, at = new Date().toISOString();
    if (this.enabled.has("console")) {
      if (event.method === "Runtime.consoleAPICalled") { this.pushConsole({ pageId, level: consoleLevel(params.type), text: consoleText(params.args), at }); return; }
      if (event.method === "Runtime.exceptionThrown") {
        const detail = object(params.exceptionDetails);
        this.pushConsole({ pageId, level: "error", text: (string(object(detail.exception).description) || string(detail.text) || "Uncaught exception").slice(0, TEXT_MAX), source: "exception", at });
        return;
      }
      if (event.method === "Log.entryAdded") {
        const entry = object(params.entry);
        this.pushConsole({ pageId, level: consoleLevel(entry.level), text: string(entry.text).slice(0, TEXT_MAX), ...(string(entry.source) ? { source: string(entry.source).slice(0, 40) } : {}), at });
        return;
      }
    }
    if (!this.enabled.has("network")) return;
    const requestId = string(params.requestId);
    if (!requestId) return;
    if (event.method === "Network.requestWillBeSent") {
      const request = object(params.request);
      if (!this.network.has(requestId) && this.network.size >= NETWORK_MAX) {
        const oldest = this.network.keys().next().value as string;
        this.network.delete(oldest); this.requestRoutes.delete(oldest); this.networkDropped++;
      }
      // A redirect reuses the request ID: the entry follows the latest URL.
      this.network.set(requestId, { requestId, pageId, method: string(request.method).slice(0, 16) || "GET", url: string(request.url).slice(0, URL_MAX),
        ...(string(params.type) ? { resourceType: string(params.type) } : {}), at });
      this.requestRoutes.set(requestId, route);
      return;
    }
    const entry = this.network.get(requestId);
    if (!entry) return;
    if (event.method === "Network.responseReceived") {
      const response = object(params.response);
      if (Number.isSafeInteger(response.status)) entry.status = Number(response.status);
      if (string(response.mimeType)) entry.mimeType = string(response.mimeType).slice(0, 120);
    } else if (event.method === "Network.loadingFinished") {
      if (Number.isFinite(params.encodedDataLength)) entry.bytes = Math.round(Number(params.encodedDataLength));
    } else if (event.method === "Network.loadingFailed") {
      entry.failed = (string(params.blockedReason) || (params.canceled === true ? "canceled" : "") || string(params.errorText) || "failed").slice(0, 200);
    }
  }

  private pushConsole(entry: ConsoleEntry): void {
    this.console.push(entry);
    if (this.console.length > CONSOLE_MAX) { this.console.splice(0, this.console.length - CONSOLE_MAX); this.consoleDropped++; }
  }

  readConsole(options: { level?: ConsoleEntry["level"]; pattern?: string; limit: number; clear?: boolean; pageId?: string }) {
    const pattern = options.pattern?.toLowerCase();
    const matching = this.console.filter(entry => (!options.level || entry.level === options.level) && (!options.pageId || entry.pageId === options.pageId)
      && (!pattern || entry.text.toLowerCase().includes(pattern)));
    const entries = newest(matching, options.limit);
    const result = { entries, ...(matching.length > entries.length ? { omitted: matching.length - entries.length } : {}), ...(this.consoleDropped ? { dropped: this.consoleDropped } : {}) };
    if (options.clear) { this.console = []; this.consoleDropped = 0; }
    return result;
  }

  readNetwork(options: { urlPattern?: string; failedOnly?: boolean; limit: number; pageId?: string }) {
    const pattern = options.urlPattern?.toLowerCase();
    const matching = [...this.network.values()].filter(entry => (!options.pageId || entry.pageId === options.pageId)
      && (!pattern || entry.url.toLowerCase().includes(pattern)) && (!options.failedOnly || entry.failed !== undefined || (entry.status ?? 0) >= 400));
    const entries = newest(matching, options.limit);
    return { entries, ...(matching.length > entries.length ? { omitted: matching.length - entries.length } : {}), ...(this.networkDropped ? { dropped: this.networkDropped } : {}) };
  }

  /** A text body of a same-origin response on the page's current origin. Opaque, binary and cross-origin bodies are refused. */
  async responseBody(requestId: string, pageOrigin: string, maxBytes: number, send: (route: string, method: string, params: RecordValue) => Promise<RecordValue>) {
    const entry = this.network.get(requestId), route = this.requestRoutes.get(requestId);
    if (!entry || route === undefined) throw new EngineError("not_found");
    let origin = "";
    try { origin = new URL(entry.url).origin; } catch { /* not a URL */ }
    if (!origin || origin !== pageOrigin || !textual(entry.mimeType)) throw new EngineError("unsupported_capability");
    const body = await send(route, "Network.getResponseBody", { requestId });
    if (body.base64Encoded === true || typeof body.body !== "string") throw new EngineError("unsupported_capability");
    const bytes = Buffer.from(body.body, "utf8");
    const truncated = bytes.length > maxBytes;
    return { requestId, url: entry.url, ...(entry.status === undefined ? {} : { status: entry.status }), mimeType: entry.mimeType,
      body: truncated ? bytes.subarray(0, maxBytes).toString("utf8").replace(/�$/u, "") : body.body, ...(truncated ? { truncated: true } : {}) };
  }

  forgetRoute(route: string): void {
    for (const [requestId, owner] of this.requestRoutes) if (owner === route) this.requestRoutes.delete(requestId);
  }

  close(): void { this.enabled.clear(); this.console = []; this.network.clear(); this.requestRoutes.clear(); }
}

/** The newest entries, oldest first, within the count and a byte budget that fits one tool result. */
function newest<T>(entries: readonly T[], limit: number, maxBytes = 56 * 1024): T[] {
  const kept: T[] = [];
  let bytes = 0;
  for (let index = entries.length - 1; index >= 0 && kept.length < limit; index--) {
    bytes += Buffer.byteLength(JSON.stringify(entries[index]), "utf8") + 1;
    if (bytes > maxBytes) break;
    kept.push(entries[index]!);
  }
  return kept.reverse();
}

function textual(mimeType: string | undefined): boolean {
  return !!mimeType && /^(text\/|application\/(?:json|[a-z0-9.+-]*\+json|javascript|xml|[a-z0-9.+-]*\+xml|x-www-form-urlencoded))/iu.test(mimeType);
}

function consoleLevel(value: unknown): ConsoleEntry["level"] {
  const type = string(value);
  if (type === "warning" || type === "warn") return "warn";
  if (type === "error" || type === "assert") return "error";
  if (type === "info") return "info";
  if (type === "debug" || type === "verbose") return "debug";
  return "log";
}

// Primitive values and CDP descriptions only: rendering never runs page getters.
function consoleText(args: unknown): string {
  if (!Array.isArray(args)) return "";
  return args.map(raw => {
    const arg = object(raw);
    if (arg.value !== undefined) return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value) ?? "";
    if (arg.description !== undefined) return string(arg.description);
    if (arg.unserializableValue !== undefined) return string(arg.unserializableValue);
    return arg.type ? `[${string(arg.type)}]` : "";
  }).join(" ").trim().slice(0, TEXT_MAX);
}
