import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { createNewtonBrowserHost } from "./bridge.ts";
import { serveNewtonBrowserMcpConnection } from "./mcp-server.ts";

import type { NewtonBrowserHost } from "./bridge.ts";

export type PersistentMcpDaemon = {
  socketPath: string;
  close: () => Promise<void>;
  closed: Promise<void>;
};

export async function runPersistentMcpDaemon(socketPath: string): Promise<void> {
  const daemon = await startPersistentMcpDaemon(socketPath);
  const stop = () => { void daemon.close(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await daemon.closed;
}

export async function startPersistentMcpDaemon(
  socketPath: string,
  input: { bridge?: NewtonBrowserHost; idleMs?: number } = {},
): Promise<PersistentMcpDaemon> {
  const target = prepareSocketPath(socketPath);
  const parent = path.dirname(target);
  const readinessTimeoutMs = Number(process.env.NEWTON_BROWSER_READINESS_TIMEOUT_MS);
  const orphanSessionTtlMs = boundedOrphanSessionTtlMs(process.env.NEWTON_BROWSER_ORPHAN_SESSION_TTL_MS);
  const bridge = input.bridge ?? createNewtonBrowserHost({
    limits: {
      ...(Number.isFinite(readinessTimeoutMs) ? { readinessTimeoutMs: Math.max(50, readinessTimeoutMs) } : {}),
      orphanSessionTtlMs,
    },
    observerRegistryDirectory: process.env.NEWTON_BROWSER_OBSERVER_REGISTRY_DIR,
    observerToken: process.env.NEWTON_BROWSER_OBSERVER_TOKEN,
  });
  await bridge.listen(undefined, "127.0.0.1");
  let connected = false;
  let lastDisconnectedAt = Date.now();
  const server = net.createServer((socket) => {
    if (connected) { socket.destroy(); return; }
    connected = true;
    void serveNewtonBrowserMcpConnection({ bridge, readable: socket, writable: socket })
      .finally(() => { connected = false; lastDisconnectedAt = Date.now(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(target, () => { server.removeListener("error", reject); resolve(); });
  });
  fs.chmodSync(target, 0o600);
  const idleMs = input.idleMs ?? boundedIdleMs(process.env.NEWTON_BROWSER_DAEMON_IDLE_MS);
  const idle = setInterval(() => {
    if (!connected && bridge.listSessions().length === 0 && Date.now() - lastDisconnectedAt >= idleMs) server.close();
  }, Math.min(5_000, idleMs));
  idle.unref();
  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const finalize = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(idle);
    bridge.stopAll();
    await bridge.close().catch(() => undefined);
    unlinkOwnedSocket(target);
    resolveClosed();
  };
  const close = async (): Promise<void> => {
    if (closed) return closedPromise;
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await finalize();
  };
  server.once("close", () => { void finalize(); });
  return { socketPath: target, close, closed: closedPromise };
}

export async function runPersistentMcpClient(socketPath: string): Promise<void> {
  const target = requiredSocketPath(socketPath);
  const socket = net.connect(target);
  socket.on("data", (chunk) => process.stdout.write(chunk));
  process.stdin.on("data", (chunk) => socket.write(chunk));
  process.stdin.once("end", () => socket.end());
  process.stdin.resume();
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => undefined);
    socket.once("error", reject);
    socket.once("close", resolve);
  });
}

function requiredSocketPath(value: string): string {
  if (process.platform === "win32") throw new Error("persistent_mcp_socket_unsupported_on_windows");
  if (!value || !path.isAbsolute(value) || value.length > 100 || value.includes("\0")) throw new Error("persistent_mcp_socket_invalid");
  return path.resolve(value);
}

export function prepareSocketPath(value: string): string {
  const target = requiredSocketPath(value);
  const parent = path.dirname(target);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !ownedByCurrentUser(parentStat) || (parentStat.mode & 0o022) !== 0) {
    throw new Error("persistent_mcp_socket_parent_unsafe");
  }
  if (!fs.existsSync(target)) return target;
  const targetStat = fs.lstatSync(target);
  if (!targetStat.isSocket() || targetStat.isSymbolicLink() || !ownedByCurrentUser(targetStat)) {
    throw new Error("persistent_mcp_socket_target_unsafe");
  }
  fs.unlinkSync(target);
  return target;
}

function unlinkOwnedSocket(target: string): void {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSocket() && !stat.isSymbolicLink() && ownedByCurrentUser(stat)) fs.unlinkSync(target);
}

function ownedByCurrentUser(stat: fs.Stats): boolean {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

export function boundedIdleMs(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(10_000, Math.min(30 * 24 * 60 * 60_000, Math.trunc(parsed))) : 60_000;
}

function boundedOrphanSessionTtlMs(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(30 * 60_000, Math.min(30 * 24 * 60 * 60_000, Math.trunc(parsed)))
    : 7 * 24 * 60 * 60_000;
}
