import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_MAX_CONNECTIONS = 32;
const DEFAULT_MAX_HEADER_BYTES = 32 * 1024;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_TUNNEL_HEAD_BYTES = 64 * 1024;
const COUNT_CAP = 1_000_000;
const FORWARDED_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export const POLICY_PROXY_REASON_CODES = [
  "ambiguous_host",
  "authority_mismatch",
  "connection_limit",
  "dns_authority_ambiguous",
  "invalid_framing",
  "invalid_port",
  "invalid_target",
  "missing_host",
  "origin_denied",
  "proxy_auth_forbidden",
  "proxy_closed",
  "request_too_large",
  "unsupported_method",
  "unsupported_scheme",
  "upstream_failure",
  "userinfo_forbidden",
] as const;

export type PolicyProxyReasonCode = (typeof POLICY_PROXY_REASON_CODES)[number];

export type PolicyProxyLedger = Readonly<{
  requestsAllowed: number;
  requestsDenied: number;
  upstreamConnections: number;
  tunnelsOpened: number;
  upgradesOpened: number;
  activeClientConnections: number;
  activeUpstreamConnections: number;
  closed: boolean;
  reasons: Readonly<Partial<Record<PolicyProxyReasonCode, number>>>;
}>;

export type PolicyProxy = Readonly<{
  host: typeof LOOPBACK_HOST;
  port: number;
  proxyUrl: string;
  ledger: () => PolicyProxyLedger;
  close: () => Promise<void>;
  closed: Promise<void>;
}>;

export type PolicyProxyOptions = Readonly<{
  allowedOrigins: readonly string[];
  maxConnections?: number;
  maxHeaderBytes?: number;
  maxBodyBytes?: number;
  maxTunnelHeadBytes?: number;
}>;

export type PolicyProxyLaunchConfiguration = Readonly<{
  host: typeof LOOPBACK_HOST;
  port: number;
  args: readonly [string, string, string];
}>;

type Limits = Readonly<{
  maxConnections: number;
  maxBodyBytes: number;
  maxTunnelHeadBytes: number;
}>;

type AutoSelectingConnectionOptions = Readonly<{
  host: string;
  port: number;
  autoSelectFamily: true;
}>;

type AutoSelectingRequestOptions = http.RequestOptions & Readonly<{
  autoSelectFamily: true;
}>;

type MutableLedger = {
  requestsAllowed: number;
  requestsDenied: number;
  upstreamConnections: number;
  tunnelsOpened: number;
  upgradesOpened: number;
  closed: boolean;
  reasons: Partial<Record<PolicyProxyReasonCode, number>>;
};

type PolicyProxyCapabilityState = Readonly<{
  server: http.Server;
  state: MutableLedger;
  port: number;
}>;

const policyProxyCapabilities = new WeakMap<object, PolicyProxyCapabilityState>();

type ParsedAuthority = Readonly<{
  hostname: string;
  port: number;
  normalizedAuthority: string;
  origin: string;
}>;

type ParsedForwardTarget = ParsedAuthority & Readonly<{
  path: string;
  scheme: "http:";
}>;

type HeaderValidation = Readonly<{
  headers: ReadonlyMap<string, string>;
  contentLength: number;
}>;

class PolicyRejection extends Error {
  readonly reason: PolicyProxyReasonCode;
  readonly statusCode: number;

  constructor(reason: PolicyProxyReasonCode, statusCode = 400) {
    super(reason);
    this.reason = reason;
    this.statusCode = statusCode;
  }
}

export async function startPolicyProxy(options: PolicyProxyOptions): Promise<PolicyProxy> {
  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins);
  const limits: Limits = {
    maxConnections: boundedInteger(options.maxConnections, DEFAULT_MAX_CONNECTIONS, 1, 256),
    maxBodyBytes: boundedInteger(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES, 0, 16 * 1024 * 1024),
    maxTunnelHeadBytes: boundedInteger(options.maxTunnelHeadBytes, DEFAULT_MAX_TUNNEL_HEAD_BYTES, 0, 256 * 1024),
  };
  const maxHeaderBytes = boundedInteger(options.maxHeaderBytes, DEFAULT_MAX_HEADER_BYTES, 1024, 64 * 1024);
  const clients = new Set<net.Socket>();
  const upstreams = new Set<net.Socket>();
  const upstreamRequests = new Set<http.ClientRequest>();
  const state: MutableLedger = {
    requestsAllowed: 0,
    requestsDenied: 0,
    upstreamConnections: 0,
    tunnelsOpened: 0,
    upgradesOpened: 0,
    closed: false,
    reasons: {},
  };

  const server = http.createServer({
    insecureHTTPParser: false,
    maxHeaderSize: maxHeaderBytes,
    requireHostHeader: true,
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 100;

  server.on("connection", (socket) => {
    socket.setNoDelay(true);
    // A browser may reset speculative proxy connections during startup or
    // shutdown. The socket is already owned by this proxy; an expected reset
    // must close that connection, not become a process-level unhandled error.
    socket.on("error", () => {});
    if (state.closed || clients.size >= limits.maxConnections) {
      deny(state, state.closed ? "proxy_closed" : "connection_limit");
      socket.destroy();
      return;
    }
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
  });

  server.on("request", (request, response) => {
    void forwardHttpRequest(request, response, allowedOrigins, limits, state, upstreams, upstreamRequests);
  });

  server.on("connect", (request, client, head) => {
    void openConnectTunnel(request, client, head, allowedOrigins, limits, state, upstreams);
  });

  server.on("upgrade", (request, client, head) => {
    void forwardWebSocketUpgrade(request, client, head, allowedOrigins, limits, state, upstreams, upstreamRequests);
  });

  server.on("clientError", (_error, socket) => {
    deny(state, "invalid_framing");
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    else socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== LOOPBACK_HOST) {
    server.close();
    throw new Error("policy_proxy_loopback_bind_failed");
  }

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    state.closed = true;
    const listenerClosed = closeServer(server);
    server.closeAllConnections();
    closePromise = Promise.all([
      listenerClosed,
      drainOwnedResources(clients, upstreams, upstreamRequests),
    ]).then(() => {
      resolveClosed();
    });
    return closePromise;
  };
  server.on("error", () => { void close().catch(() => undefined); });

  const proxy = Object.freeze({
    host: LOOPBACK_HOST,
    port: address.port,
    proxyUrl: `http://${LOOPBACK_HOST}:${address.port}`,
    ledger: () => snapshotLedger(state, clients.size, upstreams.size),
    close,
    closed,
  });
  policyProxyCapabilities.set(proxy, { server, state, port: address.port });
  return proxy;
}

export function policyProxyLaunchConfiguration(proxy: PolicyProxy): PolicyProxyLaunchConfiguration {
  const capability = typeof proxy === "object" && proxy !== null ? policyProxyCapabilities.get(proxy) : undefined;
  if (!capability) throw new Error("policy_proxy_capability_invalid");
  const address = capability.server.address();
  if (
    capability.state.closed
    || !capability.server.listening
    || !address
    || typeof address === "string"
    || address.address !== LOOPBACK_HOST
    || address.port !== capability.port
  ) {
    throw new Error("policy_proxy_not_ready");
  }
  return Object.freeze({
    host: LOOPBACK_HOST,
    port: capability.port,
    args: Object.freeze([
      `--proxy-server=http://${LOOPBACK_HOST}:${capability.port}`,
      "--proxy-bypass-list=<-loopback>",
      "--disable-quic",
    ] as const),
  });
}

async function forwardHttpRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  allowedOrigins: ReadonlySet<string>,
  limits: Limits,
  state: MutableLedger,
  upstreams: Set<net.Socket>,
  upstreamRequests: Set<http.ClientRequest>,
): Promise<void> {
  if (state.closed) {
    deny(state, "proxy_closed");
    rejectResponse(response, 503);
    return;
  }
  try {
    const method = requiredForwardMethod(request.method);
    const headers = validateHeaders(request.rawHeaders, "request", limits.maxBodyBytes);
    const target = parseForwardTarget(request.url ?? "");
    requireMatchingHost(headers, target);
    requireGrantedOrigin(target.origin, allowedOrigins);
    allow(state);

    const requestOptions: AutoSelectingRequestOptions = {
      host: target.hostname,
      port: target.port,
      method,
      path: target.path,
      headers: forwardedHeaders(headers.headers, target.normalizedAuthority, false),
      agent: false,
      setHost: false,
      autoSelectFamily: true,
    };
    const upstream = http.request(requestOptions, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, sanitizedResponseHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    });
    trackUpstreamRequest(upstream, state, upstreams, upstreamRequests);
    upstream.once("error", () => {
      recordReason(state, "upstream_failure");
      if (!response.headersSent) rejectResponse(response, 502);
      else response.destroy();
    });
    request.once("aborted", () => upstream.destroy());
    request.pipe(upstream);
  } catch (error) {
    const rejection = asRejection(error);
    deny(state, rejection.reason);
    rejectResponse(response, rejection.statusCode);
  }
}

async function openConnectTunnel(
  request: http.IncomingMessage,
  client: Duplex,
  head: Buffer,
  allowedOrigins: ReadonlySet<string>,
  limits: Limits,
  state: MutableLedger,
  upstreams: Set<net.Socket>,
): Promise<void> {
  if (state.closed) {
    deny(state, "proxy_closed");
    rejectSocket(client, 503);
    return;
  }
  try {
    if (request.method !== "CONNECT") throw new PolicyRejection("unsupported_method", 405);
    if (head.length > limits.maxTunnelHeadBytes) throw new PolicyRejection("request_too_large", 413);
    const headers = validateHeaders(request.rawHeaders, "connect", 0);
    const target = parseAuthority(request.url ?? "", "https:");
    requireMatchingHost(headers, target);
    requireGrantedOrigin(target.origin, allowedOrigins);
    allow(state);
    client.pause();
    const connectionOptions: AutoSelectingConnectionOptions = {
      host: target.hostname,
      port: target.port,
      autoSelectFamily: true,
    };
    const upstream = net.createConnection(connectionOptions);
    if (!trackSocket(upstream, upstreams, state)) return;
    upstream.once("connect", () => {
      increment(state, "upstreamConnections");
      increment(state, "tunnelsOpened");
      if (!client.writable) { upstream.destroy(); return; }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.once("error", () => {
      recordReason(state, "upstream_failure");
      if (client.writable) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      else client.destroy();
    });
    client.once("close", () => upstream.destroy());
  } catch (error) {
    const rejection = asRejection(error);
    deny(state, rejection.reason);
    rejectSocket(client, rejection.statusCode);
  }
}

async function forwardWebSocketUpgrade(
  request: http.IncomingMessage,
  client: Duplex,
  head: Buffer,
  allowedOrigins: ReadonlySet<string>,
  limits: Limits,
  state: MutableLedger,
  upstreams: Set<net.Socket>,
  upstreamRequests: Set<http.ClientRequest>,
): Promise<void> {
  if (state.closed) {
    deny(state, "proxy_closed");
    rejectSocket(client, 503);
    return;
  }
  try {
    if (request.method !== "GET") throw new PolicyRejection("unsupported_method", 405);
    if (head.length > limits.maxTunnelHeadBytes) throw new PolicyRejection("request_too_large", 413);
    const headers = validateHeaders(request.rawHeaders, "upgrade", 0);
    const target = parseForwardTarget(request.url ?? "");
    requireMatchingHost(headers, target);
    requireGrantedOrigin(target.origin, allowedOrigins);
    allow(state);
    client.pause();
    const requestOptions: AutoSelectingRequestOptions = {
      host: target.hostname,
      port: target.port,
      method: "GET",
      path: target.path,
      headers: forwardedHeaders(headers.headers, target.normalizedAuthority, true),
      agent: false,
      setHost: false,
      autoSelectFamily: true,
    };
    const upstreamRequest = http.request(requestOptions);
    trackUpstreamRequest(upstreamRequest, state, upstreams, upstreamRequests);
    upstreamRequest.once("upgrade", (upstreamResponse, upstream, upstreamHead) => {
      increment(state, "upgradesOpened");
      if (!client.writable) { upstream.destroy(); return; }
      client.write(serializeUpgradeResponse(upstreamResponse));
      if (head.length > 0) upstream.write(head);
      if (upstreamHead.length > 0) client.write(upstreamHead);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstreamRequest.once("response", (upstreamResponse) => {
      upstreamResponse.resume();
      rejectSocket(client, upstreamResponse.statusCode ?? 502);
    });
    upstreamRequest.once("error", () => {
      recordReason(state, "upstream_failure");
      rejectSocket(client, 502);
    });
    client.once("close", () => upstreamRequest.destroy());
    upstreamRequest.end();
  } catch (error) {
    const rejection = asRejection(error);
    deny(state, rejection.reason);
    rejectSocket(client, rejection.statusCode);
  }
}

function normalizeAllowedOrigins(origins: readonly string[]): ReadonlySet<string> {
  if (origins.length === 0 || origins.length > 32) throw new Error("policy_proxy_invalid_allowlist");
  const normalized = new Set<string>();
  for (const value of origins) {
    try {
      if (typeof value !== "string" || value.length === 0 || value.length > 2048) throw new Error();
      const url = new URL(value);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new Error();
      if (url.pathname !== "/" || url.search || url.hash) throw new Error();
      const parsed = parseAuthority(url.host, url.protocol);
      if (parsed.origin !== url.origin) throw new Error();
      normalized.add(parsed.origin);
    } catch {
      throw new Error("policy_proxy_invalid_allowlist");
    }
  }
  return normalized;
}

function parseForwardTarget(rawTarget: string): ParsedForwardTarget {
  if (rawTarget.length === 0 || rawTarget.length > 8192 || containsUnsafeTargetCharacter(rawTarget)) {
    throw new PolicyRejection("invalid_target");
  }
  const match = /^(https?|wss?):\/\/([^/?#]+)(\/[^#]*)?$/iu.exec(rawTarget);
  if (!match) throw new PolicyRejection("invalid_target");
  const requestedScheme = `${match[1]!.toLowerCase()}:`;
  if (requestedScheme !== "http:" && requestedScheme !== "ws:") throw new PolicyRejection("unsupported_scheme", 400);
  const scheme = "http:";
  const authority = parseAuthority(match[2]!, scheme);
  const url = new URL(rawTarget);
  if (url.host !== authority.normalizedAuthority || url.username || url.password) throw new PolicyRejection("invalid_target");
  return { ...authority, scheme, path: `${url.pathname}${url.search}` || "/" };
}

function parseAuthority(rawAuthority: string, scheme: string): ParsedAuthority {
  if (rawAuthority.length === 0 || rawAuthority.length > 512 || /[\s\\/?#%,]/u.test(rawAuthority)) {
    throw new PolicyRejection("dns_authority_ambiguous");
  }
  if (rawAuthority.includes("@")) throw new PolicyRejection("userinfo_forbidden");
  const bracketed = rawAuthority.startsWith("[");
  let rawHost: string;
  let rawPort = "";
  if (bracketed) {
    const close = rawAuthority.indexOf("]");
    if (close < 0 || rawAuthority.indexOf("]", close + 1) >= 0) throw new PolicyRejection("dns_authority_ambiguous");
    rawHost = rawAuthority.slice(0, close + 1);
    const suffix = rawAuthority.slice(close + 1);
    if (suffix && !suffix.startsWith(":")) throw new PolicyRejection("invalid_port");
    rawPort = suffix.slice(1);
    if (net.isIP(rawHost.slice(1, -1)) !== 6) throw new PolicyRejection("dns_authority_ambiguous");
  } else {
    if ((rawAuthority.match(/:/gu) ?? []).length > 1) throw new PolicyRejection("dns_authority_ambiguous");
    const colon = rawAuthority.lastIndexOf(":");
    rawHost = colon >= 0 ? rawAuthority.slice(0, colon) : rawAuthority;
    rawPort = colon >= 0 ? rawAuthority.slice(colon + 1) : "";
    validateDnsName(rawHost);
  }
  if (!rawHost || (rawAuthority.endsWith(":") && !rawPort)) throw new PolicyRejection("invalid_port");
  if (rawPort && (!/^[1-9][0-9]{0,4}$/u.test(rawPort) || Number(rawPort) > 65_535)) {
    throw new PolicyRejection("invalid_port");
  }
  const protocol = scheme === "https:" ? "https:" : scheme === "http:" ? "http:" : "";
  if (!protocol) throw new PolicyRejection("unsupported_scheme");
  let url: URL;
  try { url = new URL(`${protocol}//${rawAuthority}`); }
  catch { throw new PolicyRejection("invalid_target"); }
  const defaultPort = protocol === "https:" ? 443 : 80;
  const port = url.port ? Number(url.port) : defaultPort;
  const canonicalHost = url.hostname.toLowerCase();
  const rawHostLower = rawHost.toLowerCase();
  if (canonicalHost !== rawHostLower) throw new PolicyRejection("dns_authority_ambiguous");
  return { hostname: bracketed ? canonicalHost.slice(1, -1) : canonicalHost, port, normalizedAuthority: url.host, origin: url.origin };
}

function validateDnsName(rawHost: string): void {
  if (!rawHost || rawHost.length > 253 || rawHost !== rawHost.toLowerCase() || /[^a-z0-9.-]/u.test(rawHost)) {
    throw new PolicyRejection("dns_authority_ambiguous");
  }
  if (rawHost.startsWith(".") || rawHost.endsWith(".") || rawHost.includes("..")) throw new PolicyRejection("dns_authority_ambiguous");
  if (/^[0-9.]+$/u.test(rawHost)) {
    const parts = rawHost.split(".");
    if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9][0-9]{0,2})$/u.test(part) || Number(part) > 255)) {
      throw new PolicyRejection("dns_authority_ambiguous");
    }
    return;
  }
  if (rawHost.split(".").some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) {
    throw new PolicyRejection("dns_authority_ambiguous");
  }
}

function validateHeaders(rawHeaders: readonly string[], mode: "request" | "connect" | "upgrade", maxBodyBytes: number): HeaderValidation {
  if (rawHeaders.length % 2 !== 0) throw new PolicyRejection("invalid_framing");
  const headers = new Map<string, string>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!.toLowerCase();
    const value = rawHeaders[index + 1]!;
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name) || /[\0\r\n]/u.test(value)) throw new PolicyRejection("invalid_framing");
    if (headers.has(name)) throw new PolicyRejection(name === "host" ? "ambiguous_host" : "invalid_framing");
    headers.set(name, value.trim());
  }
  if (!headers.has("host")) throw new PolicyRejection("missing_host");
  if (headers.has("proxy-authorization") || headers.has("proxy-authenticate")) throw new PolicyRejection("proxy_auth_forbidden", 407);
  if (headers.has("transfer-encoding") || headers.has("expect") || headers.has("trailer")) {
    throw new PolicyRejection("invalid_framing");
  }
  const proxyConnectionTokens = (headers.get("proxy-connection") ?? "").split(",")
    .map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (proxyConnectionTokens.some((token) => token !== "keep-alive" && token !== "close")) {
    throw new PolicyRejection("invalid_framing");
  }
  const connectionTokens = (headers.get("connection") ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (connectionTokens.some((token) => token === "host" || token === "content-length" || token === "transfer-encoding" || token === "proxy-authorization")) {
    throw new PolicyRejection("invalid_framing");
  }
  const rawLength = headers.get("content-length");
  const contentLength = rawLength === undefined ? 0 : /^[0-9]+$/u.test(rawLength) ? Number(rawLength) : Number.NaN;
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) throw new PolicyRejection("invalid_framing");
  if (contentLength > maxBodyBytes) throw new PolicyRejection("request_too_large", 413);
  if (mode !== "request" && contentLength !== 0) throw new PolicyRejection("invalid_framing");
  const upgrade = headers.get("upgrade")?.toLowerCase();
  if (mode === "upgrade") {
    if (upgrade !== "websocket" || !connectionTokens.includes("upgrade")) throw new PolicyRejection("invalid_framing");
  } else if (upgrade !== undefined || connectionTokens.includes("upgrade")) {
    throw new PolicyRejection("invalid_framing");
  }
  return { headers, contentLength };
}

function requireMatchingHost(headers: HeaderValidation, target: ParsedAuthority): void {
  const host = headers.headers.get("host");
  if (!host) throw new PolicyRejection("missing_host");
  const parsedHost = parseAuthority(host, target.origin.startsWith("https:") ? "https:" : "http:");
  if (parsedHost.origin !== target.origin) throw new PolicyRejection("authority_mismatch", 400);
}

function requireGrantedOrigin(origin: string, allowedOrigins: ReadonlySet<string>): void {
  if (!allowedOrigins.has(origin)) throw new PolicyRejection("origin_denied", 403);
}

function requiredForwardMethod(method: string | undefined): string {
  if (!method || !FORWARDED_METHODS.has(method)) throw new PolicyRejection("unsupported_method", 405);
  return method;
}

function forwardedHeaders(headers: ReadonlyMap<string, string>, authority: string, upgrade: boolean): http.OutgoingHttpHeaders {
  const output: http.OutgoingHttpHeaders = { host: authority, connection: upgrade ? "Upgrade" : "close" };
  for (const [name, value] of headers) {
    if (name === "host" || HOP_BY_HOP_HEADERS.has(name)) continue;
    output[name] = value;
  }
  if (upgrade) output.upgrade = "websocket";
  return output;
}

function sanitizedResponseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const output: http.OutgoingHttpHeaders = { connection: "close" };
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name) || value === undefined) continue;
    output[name] = value;
  }
  return output;
}

function serializeUpgradeResponse(response: http.IncomingMessage): string {
  let output = `HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}\r\n`;
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index]!;
    const value = response.rawHeaders[index + 1]!;
    if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) && !/[\0\r\n]/u.test(value)) output += `${name}: ${value}\r\n`;
  }
  return `${output}\r\n`;
}

function trackUpstreamRequest(
  request: http.ClientRequest,
  state: MutableLedger,
  upstreams: Set<net.Socket>,
  upstreamRequests: Set<http.ClientRequest>,
): void {
  if (state.closed) {
    request.destroy();
    return;
  }
  upstreamRequests.add(request);
  request.once("close", () => upstreamRequests.delete(request));
  request.once("socket", (socket) => {
    if (state.closed) {
      socket.destroy();
      request.destroy();
      return;
    }
    trackSocket(socket, upstreams, state);
    socket.once("connect", () => increment(state, "upstreamConnections"));
  });
}

function trackSocket(socket: net.Socket, upstreams: Set<net.Socket>, state: MutableLedger): boolean {
  if (state.closed) {
    socket.destroy();
    return false;
  }
  upstreams.add(socket);
  socket.on("error", () => {});
  socket.once("close", () => upstreams.delete(socket));
  return true;
}

async function drainOwnedResources(
  clients: Set<net.Socket>,
  upstreams: Set<net.Socket>,
  upstreamRequests: Set<http.ClientRequest>,
): Promise<void> {
  while (clients.size > 0 || upstreams.size > 0 || upstreamRequests.size > 0) {
    const requests = [...upstreamRequests];
    const sockets = new Set([...clients, ...upstreams]);
    const closed = [
      ...requests.map(waitForRequestClose),
      ...[...sockets].map(waitForSocketClose),
    ];
    for (const request of requests) request.destroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all(closed);
  }
}

function waitForSocketClose(socket: net.Socket): Promise<void> {
  return new Promise<void>((resolve) => socket.once("close", resolve));
}

function waitForRequestClose(request: http.ClientRequest): Promise<void> {
  return new Promise<void>((resolve) => request.once("close", resolve));
}

function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function rejectResponse(response: http.ServerResponse, statusCode: number): void {
  if (response.destroyed) return;
  response.writeHead(statusCode, { connection: "close", "content-length": "0" });
  response.end();
}

function rejectSocket(socket: Duplex, statusCode: number): void {
  if (!socket.writable) { socket.destroy(); return; }
  socket.end(`HTTP/1.1 ${statusCode} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function asRejection(error: unknown): PolicyRejection {
  return error instanceof PolicyRejection ? error : new PolicyRejection("invalid_target");
}

function containsUnsafeTargetCharacter(value: string): boolean {
  return /[\0-\x20\x7f\\#]/u.test(value);
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("policy_proxy_invalid_limit");
  return value;
}

function allow(state: MutableLedger): void {
  state.requestsAllowed = cappedIncrement(state.requestsAllowed);
}

function deny(state: MutableLedger, reason: PolicyProxyReasonCode): void {
  state.requestsDenied = cappedIncrement(state.requestsDenied);
  recordReason(state, reason);
}

function recordReason(state: MutableLedger, reason: PolicyProxyReasonCode): void {
  state.reasons[reason] = cappedIncrement(state.reasons[reason] ?? 0);
}

function increment(state: MutableLedger, key: "upstreamConnections" | "tunnelsOpened" | "upgradesOpened"): void {
  state[key] = cappedIncrement(state[key]);
}

function cappedIncrement(value: number): number {
  return Math.min(COUNT_CAP, value + 1);
}

function snapshotLedger(state: MutableLedger, activeClientConnections: number, activeUpstreamConnections: number): PolicyProxyLedger {
  return Object.freeze({
    requestsAllowed: state.requestsAllowed,
    requestsDenied: state.requestsDenied,
    upstreamConnections: state.upstreamConnections,
    tunnelsOpened: state.tunnelsOpened,
    upgradesOpened: state.upgradesOpened,
    activeClientConnections,
    activeUpstreamConnections,
    closed: state.closed,
    reasons: Object.freeze({ ...state.reasons }),
  });
}
