import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { createDefaultDirectBrowserHost } from "./browser-runtime/default-direct-host.ts";
import { serveNewtonBrowserMcpConnection, type BrowserHost } from "./mcp-server.ts";


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
  input: { bridge?: BrowserHost; idleMs?: number; orphanSessionTtlMs?: number } = {},
): Promise<PersistentMcpDaemon> {
  const target = prepareSocketPath(socketPath);
  const parent = path.dirname(target);
  const orphanSessionTtlMs = input.orphanSessionTtlMs === undefined
    ? boundedOrphanSessionTtlMs(process.env.NEWTON_BROWSER_ORPHAN_SESSION_TTL_MS)
    : boundedInjectedOrphanTtl(input.orphanSessionTtlMs);
  const bridge = input.bridge ?? createDefaultDirectBrowserHost();
  await bridge.listen();
  let connected = false;
  let closing = false;
  let lastDisconnectedAt = Date.now();
  const server = net.createServer((socket) => {
    if (closing || connected) { socket.destroy(); return; }
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
  let orphanCleanup: Promise<void> | null = null;
  let nextOrphanAttemptAt = 0;
  const idle = setInterval(() => {
    if (connected) return;
    const now = Date.now();
    const sessions = bridge.listSessions();
    if (sessions.length === 0) {
      if (now - lastDisconnectedAt >= idleMs) void finalize().catch(() => undefined);
      return;
    }
    if (now - lastDisconnectedAt < orphanSessionTtlMs || now < nextOrphanAttemptAt || orphanCleanup) return;
    const operation = Promise.resolve().then(() => bridge.stopAll());
    orphanCleanup = operation;
    void operation.then(() => {
      if (bridge.listSessions().length === 0 && !connected) void finalize().catch(() => undefined);
    }, () => {
      nextOrphanAttemptAt = Date.now() + Math.min(5_000, orphanSessionTtlMs);
    }).finally(() => {
      if (orphanCleanup === operation) orphanCleanup = null;
    });
  }, Math.min(5_000, idleMs, orphanSessionTtlMs));
  idle.unref();
  let terminalClosed = false;
  let cleanupOperation: Promise<void> | null = null;
  let closedSettled = false;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closedPromise = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  void closedPromise.catch(() => undefined);
  const finalize = (): Promise<void> => {
    if (terminalClosed) return Promise.resolve();
    if (cleanupOperation) return cleanupOperation;
    closing = true;
    clearInterval(idle);
    const operation = (async () => {
      try { await bridge.stopAll(); } catch { /* bridge.close remains the authoritative cleanup retry */ }
      await bridge.close();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      unlinkOwnedSocket(target);
      terminalClosed = true;
      if (!closedSettled) { closedSettled = true; resolveClosed(); }
    })();
    cleanupOperation = operation;
    void operation.catch((error: unknown) => {
      if (!closedSettled) { closedSettled = true; rejectClosed(error); }
    }).finally(() => {
      if (cleanupOperation === operation) cleanupOperation = null;
    });
    return operation;
  };
  const close = async (): Promise<void> => {
    if (terminalClosed) return;
    await finalize();
  };
  server.once("close", () => { void finalize().catch(() => undefined); });
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

function boundedInjectedOrphanTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value < 10 || value > 30 * 24 * 60 * 60_000) {
    throw new Error("persistent_mcp_orphan_ttl_invalid");
  }
  return value;
}
