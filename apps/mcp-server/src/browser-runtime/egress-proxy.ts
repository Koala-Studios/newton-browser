import http from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";
import type { Duplex } from "node:stream";

/** Chromium arguments that send every browser connection through the proxy: no implicit
 * loopback bypass, no QUIC (it does not use HTTP proxies) and no direct WebRTC UDP. */
export function egressProxyArgs(proxyServer: string): readonly string[] {
  return [`--proxy-server=${proxyServer}`, "--proxy-bypass-list=<-loopback>", "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"];
}

export type EgressProxy = Readonly<{ proxyServer: string; close(): Promise<void> }>;
type Resolve = (hostname: string) => Promise<readonly string[]>;

/** A loopback forward proxy that lets the browser reach only public internet addresses.
 * Each destination is resolved once and the connection goes to that vetted address,
 * so a name cannot resolve publicly for the check and privately for the connection. */
export async function startEgressProxy(options: { resolve?: Resolve; allow?: (address: string) => boolean } = {}): Promise<EgressProxy> {
  const resolve = options.resolve ?? (async (hostname: string) => (await lookup(hostname, { all: true, verbatim: true })).map(entry => entry.address));
  const allow = options.allow ?? isPublicAddress;
  const sockets = new Set<Duplex>();
  const track = (socket: Duplex) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); };
  const server = http.createServer((request, response) => { void forward(request, response); });
  server.on("connection", track);
  server.on("connect", (request: http.IncomingMessage, client: Duplex, head: Buffer) => { void tunnel(request, client, head); });

  async function destination(hostname: string, port: number): Promise<string | null> {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
    const bare = hostname.replace(/^\[|\]$/gu, "");
    let addresses: readonly string[];
    try { addresses = net.isIP(bare) ? [bare] : await resolve(bare); } catch { return null; }
    // Every address must be public: a name that also resolves privately is refused.
    return addresses.length > 0 && addresses.every(allow) ? addresses[0]! : null;
  }

  async function tunnel(request: http.IncomingMessage, client: Duplex, head: Buffer) {
    track(client);
    const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/u.exec(request.url ?? "");
    const address = match ? await destination(match[1]!, Number(match[2])) : null;
    if (!address) { client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"); return; }
    const upstream = net.connect({ host: address, port: Number(match![2]) });
    track(upstream);
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    upstream.once("error", () => client.destroy());
    client.once("error", () => upstream.destroy());
  }

  async function forward(request: http.IncomingMessage, response: http.ServerResponse) {
    let url: URL;
    try { url = new URL(request.url ?? ""); } catch { response.writeHead(400).end(); return; }
    if (url.protocol !== "http:") { response.writeHead(400).end(); return; }
    const port = url.port ? Number(url.port) : 80;
    const address = await destination(url.hostname, port);
    if (!address) { response.writeHead(403).end(); return; }
    const headers: http.OutgoingHttpHeaders = { ...request.headers, host: url.host };
    delete headers["proxy-connection"]; delete headers["proxy-authorization"];
    const upstream = http.request({ host: address, port, method: request.method, path: url.pathname + url.search, headers }, reply => {
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
    });
    upstream.once("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(upstream);
  }

  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolveListen()); });
  server.unref();
  const port = (server.address() as net.AddressInfo).port;
  return Object.freeze({
    proxyServer: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolveClose => { for (const socket of sockets) socket.destroy(); server.close(() => resolveClose()); }),
  });
}

/** Globally routable unicast only: no private, loopback, link-local (cloud metadata), shared,
 * benchmarking, documentation, multicast or reserved ranges, in IPv4 or IPv6 forms. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return publicV4(address.split(".").map(Number));
  if (family !== 6) return false;
  const groups = expandV6(address.toLowerCase());
  if (!groups) return false;
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible and NAT64 (64:ff9b::/96) carry an IPv4 address.
  if (groups.slice(0, 5).every(group => group === 0) && (groups[5] === 0xffff || groups[5] === 0)) return groups[5] === 0xffff && publicV4(v4(groups));
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every(group => group === 0)) return publicV4(v4(groups));
  const first = groups[0]!;
  if ((first & 0xe000) !== 0x2000) return false; // only 2000::/3 is global unicast
  if (first === 0x2001 && (groups[1]! < 0x0200 || groups[1] === 0x0db8)) return false; // protocol assignments, documentation
  if (first === 0x2002) return publicV4([groups[1]! >> 8, groups[1]! & 255, groups[2]! >> 8, groups[2]! & 255]); // 6to4
  return true;
}

function v4(groups: number[]): number[] { return [groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8, groups[7]! & 255]; }

function publicV4([a, b, c]: number[]): boolean {
  if (a === undefined || b === undefined || c === undefined) return false;
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || a === 100 && b >= 64 && b <= 127 // shared address space
    || a === 169 && b === 254 // link-local, including cloud metadata
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && b === 168
    || a === 192 && b === 0 && (c === 0 || c === 2) // protocol assignments, documentation
    || a === 192 && b === 88 && c === 99
    || a === 198 && (b === 18 || b === 19) // benchmarking
    || a === 198 && b === 51 && c === 100
    || a === 203 && b === 0 && c === 113);
}

function expandV6(address: string): number[] | null {
  let text = address.split("%")[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/u.exec(text);
  if (dotted) {
    const parts = dotted[1]!.split(".").map(Number);
    text = text.slice(0, -dotted[1]!.length) + ((parts[0]! << 8) | parts[1]!).toString(16) + ":" + ((parts[2]! << 8) | parts[3]!).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [], tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail].map(group => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every(group => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}
