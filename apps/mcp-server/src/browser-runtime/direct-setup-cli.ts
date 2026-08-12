import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  startDirectDriverSession,
  type DirectDriverSession,
  type StartDirectDriverSessionOptions,
} from "@newton-browser/driver/direct-session-runtime";

import { configDirectory, ensureConfigDirectory, loadBrowserPreference, profileStoreDirectory, resolveConfigDirectory, writeBrowserPreference } from "../config.ts";
import { discoverBrowserExecutable, type BrowserExecutable, type BrowserFamily } from "./browser-discovery.ts";
import { createConfiguredDirectBrowserHost } from "./configured-direct-host.ts";
import {
  launchOwnedBrowserRuntime,
  type LaunchOwnedBrowserRuntimeOptions,
  type OwnedBrowserRuntime,
} from "./owned-browser-runtime.ts";
import {
  listNewtonIdentities,
  openProfileStore,
} from "./profile-store.ts";

const IDENTITY_PATTERN = /^nbi_[a-f0-9]{32}$/u;

type SetupOwnedRuntime = Readonly<{
  receipt: OwnedBrowserRuntime["receipt"];
  unavailable: Promise<void>;
  claimDriverBootstrap: OwnedBrowserRuntime["claimDriverBootstrap"];
  close(): Promise<void>;
}>;
type SetupRuntimeLauncher = (options: LaunchOwnedBrowserRuntimeOptions) => Promise<SetupOwnedRuntime>;
type SetupSessionStarter = (options: StartDirectDriverSessionOptions) => Promise<DirectDriverSession>;

export type DirectBrowserSetupReceipt = Readonly<{
  configured: true;
  browserFamily: BrowserFamily;
  transport: "stdio";
  nextAction: "start_session";
}>;

export type DirectIdentityLoginReceipt = Readonly<{
  status: "ready" | "closed";
  browserFamily: BrowserFamily;
  identityId: string;
  grantedOriginCount: number;
  cleanupConfirmed?: true;
}>;

export type DirectLiveDoctorReceipt = Readonly<{
  configured: true;
  runtimeVerified: true;
  cleanupConfirmed: true;
  browserFamily: BrowserFamily;
  transport: "private_cdp_pipe";
  containment: "enabled_before_navigation";
}>;

export function setupDirectBrowser(input: {
  browserFamily: BrowserFamily;
  directory?: string;
  env?: NodeJS.ProcessEnv;
  discoverBrowser?: typeof discoverBrowserExecutable;
}): DirectBrowserSetupReceipt {
  const env = input.env ?? process.env;
  const directory = resolveConfigDirectory(input.directory ?? configDirectory(env));
  const browserFamily = exactFamily(input.browserFamily);
  try { ensureConfigDirectory(directory); } catch { fail("direct_setup_failed"); }
  discoverConfiguredBrowser(input.discoverBrowser, browserFamily, env, "direct_browser_unavailable");
  try {
    writeBrowserPreference({ directory, browser: browserFamily });
  } catch { fail("direct_setup_failed"); }
  return Object.freeze({
    configured: true,
    browserFamily,
    transport: "stdio",
    nextAction: "start_session",
  });
}

export async function runDirectIdentityLogin(input: {
  identityId: string;
  origin: string;
  allowedOrigins?: readonly string[];
  directory?: string;
  env?: NodeJS.ProcessEnv;
  onReady?(receipt: DirectIdentityLoginReceipt): void;
  discoverBrowser?: typeof discoverBrowserExecutable;
  launchRuntime?: SetupRuntimeLauncher;
  startDriverSession?: SetupSessionStarter;
  createTerminationSignal?: typeof terminationSignal;
}): Promise<DirectIdentityLoginReceipt> {
  const env = input.env ?? process.env;
  const directory = resolveConfigDirectory(input.directory ?? configDirectory(env));
  if (!IDENTITY_PATTERN.test(input.identityId)) fail("identity_login_invalid_arguments");
  const origin = exactOrigin(input.origin);
  const allowedOrigins = exactOrigins(origin, input.allowedOrigins ?? []);
  const store = openProfileStore(profileStoreDirectory(env, directory));
  const identity = listNewtonIdentities(store).find((candidate) => candidate.id === input.identityId);
  if (!identity) fail("identity_login_unavailable");
  const executable = discoverConfiguredBrowser(input.discoverBrowser, identity.browserFamily, env, "identity_login_browser_unavailable");
  let runtime: SetupOwnedRuntime;
  try {
    runtime = await (input.launchRuntime ?? launchOwnedBrowserRuntime)({
      executablePath: executable.path,
      browserFamily: identity.browserFamily,
      profileStore: store,
      identityId: identity.id,
      allowedOrigins,
      headless: false,
    });
  } catch (error) {
    if (cleanupUncertain(error)) {
      const retry = cleanupRetry(error);
      if (!retry) fail("identity_login_cleanup_uncertain");
      try { await retry(); } catch { fail("identity_login_cleanup_uncertain"); }
    }
    fail("identity_login_start_failed");
  }
  let session: DirectDriverSession | null = null;
  const termination = (input.createTerminationSignal ?? terminationSignal)();
  try {
    const bootstrap = runtime.claimDriverBootstrap(allowedOrigins);
    session = await (input.startDriverSession ?? startDirectDriverSession)({
      bootstrap,
      primaryOrigin: origin,
      allowedOrigins: allowedOrigins.filter((candidate) => candidate !== origin),
      initialUrl: `${origin}/`,
    });
    input.onReady?.(Object.freeze({
      status: "ready",
      browserFamily: identity.browserFamily,
      identityId: identity.id,
      grantedOriginCount: allowedOrigins.length,
    }));
    const completion = await Promise.race([
      runtime.unavailable.then(() => "runtime_unavailable" as const),
      termination.promise.then(() => "operator_close" as const),
    ]);
    if (completion === "runtime_unavailable") fail("identity_login_runtime_unavailable");
  } catch (error) {
    if (!await cleanupLoginRuntime(session, runtime)) fail("identity_login_cleanup_uncertain");
    throw bounded(error, "identity_login_failed");
  } finally {
    termination.dispose();
  }
  if (!await cleanupLoginRuntime(session, runtime)) fail("identity_login_cleanup_uncertain");
  return Object.freeze({
    status: "closed",
    browserFamily: identity.browserFamily,
    identityId: identity.id,
    grantedOriginCount: allowedOrigins.length,
    cleanupConfirmed: true,
  });
}

async function cleanupLoginRuntime(
  session: DirectDriverSession | null,
  runtime: SetupOwnedRuntime,
): Promise<boolean> {
  if (session) try { await session.stop(); } catch { /* process close is authoritative */ }
  try { await runtime.close(); return true; } catch {
    try { await runtime.close(); return true; } catch { return false; }
  }
}

export async function runDirectLiveDoctor(input: {
  directory?: string;
  env?: NodeJS.ProcessEnv;
  discoverBrowser?: typeof discoverBrowserExecutable;
  createHost?: typeof createConfiguredDirectBrowserHost;
} = {}): Promise<DirectLiveDoctorReceipt> {
  const env = input.env ?? process.env;
  const directory = resolveConfigDirectory(input.directory ?? configDirectory(env));
  const configuredTarget = loadBrowserPreference({ directory, env: withoutDirectConfigOverrides(env) });
  const browserFamily = configuredTarget === "auto"
    ? discoverDefaultBrowserFamily(input.discoverBrowser, env)
    : configuredTarget;
  const executable = discoverConfiguredBrowser(input.discoverBrowser, browserFamily, env, "direct_browser_unavailable");
  const ownedTemp = createOwnedDoctorRoot();
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Newton Browser live doctor</title><main>ready</main>");
  });
  let host: ReturnType<typeof createConfiguredDirectBrowserHost> | null = null;
  let cleanupConfirmed = false;
  try {
    const origin = await listenLoopback(server);
    host = (input.createHost ?? createConfiguredDirectBrowserHost)({
      env: withoutDirectConfigOverrides(env),
      profileStoreRoot: path.join(ownedTemp.root, "identities"),
      browserFamily,
      executablePath: executable.path,
      headless: true,
    });
    const created = host.createSession({
      origin,
      allowedOrigins: [origin],
    });
    await host.waitForSessionReady(created.sessionId);
    const observed = await host.dispatch(created.sessionId, { kind: "observe" });
    if (!observed.ok || observed.outcome !== "completed") fail("direct_live_doctor_observe_failed");
    await host.stopSession(created.sessionId);
    if (host.listSessions().length !== 0) fail("direct_live_doctor_session_residue");
    await host.close();
    cleanupConfirmed = true;
    host = null;
  } catch (error) {
    if (host) {
      try { await host.close(); cleanupConfirmed = true; } catch { fail("direct_live_doctor_cleanup_uncertain"); }
    } else cleanupConfirmed = true;
    throw bounded(error, "direct_live_doctor_failed");
  } finally {
    await closeLoopback(server);
    if (cleanupConfirmed) removeOwnedDoctorRoot(ownedTemp);
  }
  return Object.freeze({
    configured: true,
    runtimeVerified: true,
    cleanupConfirmed: true,
    browserFamily,
    transport: "private_cdp_pipe",
    containment: "enabled_before_navigation",
  });
}

function terminationSignal(): Readonly<{ promise: Promise<void>; dispose(): void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  const signal = () => resolve();
  const stdin = process.stdin;
  const watchStdin = stdin.isTTY !== true && !stdin.destroyed && !stdin.readableEnded;
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  if (watchStdin) {
    // Windows child-process signals terminate immediately rather than reaching the
    // Node signal handler. EOF on an explicitly piped stdin is the portable graceful
    // close contract used by automation; interactive terminals continue to use Ctrl+C.
    stdin.once("end", signal);
    stdin.once("close", signal);
    stdin.resume();
  }
  return Object.freeze({
    promise,
    dispose() {
      process.off("SIGINT", signal);
      process.off("SIGTERM", signal);
      if (watchStdin) {
        stdin.off("end", signal);
        stdin.off("close", signal);
        stdin.pause();
      }
    },
  });
}

function exactOrigins(primary: string, secondary: readonly string[]): string[] {
  if (!Array.isArray(secondary) || secondary.length > 31) fail("identity_login_invalid_arguments");
  const normalized = secondary.map(exactOrigin);
  if (normalized.includes(primary) || new Set(normalized).size !== normalized.length) fail("identity_login_invalid_arguments");
  return [primary, ...normalized];
}

function exactOrigin(value: string): string {
  if (typeof value !== "string" || value !== value.trim() || value.length > 512) fail("identity_login_invalid_arguments");
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== value) {
      fail("identity_login_invalid_arguments");
    }
    return parsed.origin;
  } catch {
    fail("identity_login_invalid_arguments");
  }
}

function exactFamily(value: BrowserFamily): BrowserFamily {
  if (value !== "chrome" && value !== "edge") fail("direct_setup_invalid_arguments");
  return value;
}

function discoverConfiguredBrowser(
  provider: typeof discoverBrowserExecutable | undefined,
  family: BrowserFamily,
  env: NodeJS.ProcessEnv,
  errorCode: string,
): BrowserExecutable {
  try {
    const executable = (provider ?? discoverBrowserExecutable)({ family, env });
    if (!executable || executable.family !== family || typeof executable.path !== "string" || executable.path.length === 0) fail(errorCode);
    return executable;
  } catch { fail(errorCode); }
}

function listenLoopback(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    const onError = () => reject(failError("direct_live_doctor_fixture_failed"));
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") reject(failError("direct_live_doctor_fixture_failed"));
      else resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeLoopback(server: http.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

type OwnedDoctorRoot = Readonly<{ root: string; parent: string; nonce: string; dev: number; ino: number }>;

function createOwnedDoctorRoot(): OwnedDoctorRoot {
  const parent = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, "newton-direct-doctor-")));
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(root) !== parent) fail("direct_live_doctor_temp_invalid");
  const nonce = randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(root, ".newton-direct-doctor-owner"), nonce, { flag: "wx", mode: 0o600 });
  return Object.freeze({ root, parent, nonce, dev: stat.dev, ino: stat.ino });
}

function removeOwnedDoctorRoot(owned: OwnedDoctorRoot): void {
  const stat = fs.lstatSync(owned.root);
  const resolved = fs.realpathSync.native(owned.root);
  const marker = path.join(resolved, ".newton-direct-doctor-owner");
  const markerStat = fs.lstatSync(marker);
  if (resolved !== owned.root || path.dirname(resolved) !== owned.parent
    || !/^newton-direct-doctor-[^/\\]+$/u.test(path.basename(resolved))
    || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== owned.dev || stat.ino !== owned.ino
    || !markerStat.isFile() || markerStat.isSymbolicLink()
    || fs.readFileSync(marker, "utf8") !== owned.nonce) {
    fail("direct_live_doctor_temp_cleanup_refused");
  }
  fs.rmSync(resolved, { recursive: true });
}

function withoutDirectConfigOverrides(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output = { ...env };
  delete output.NEWTON_BROWSER_BROWSER;
  return output;
}

function discoverDefaultBrowserFamily(
  provider: typeof discoverBrowserExecutable | undefined,
  env: NodeJS.ProcessEnv,
): BrowserFamily {
  const discover = provider ?? discoverBrowserExecutable;
  if (discover({ family: "chrome", env })) return "chrome";
  if (discover({ family: "edge", env })) return "edge";
  fail("direct_browser_unavailable");
}

function bounded(error: unknown, fallback: string): Error & { code: string } {
  const code = error && typeof error === "object" && "code" in error
    && typeof error.code === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(error.code)
    ? error.code
    : fallback;
  return Object.assign(new Error(code), { code });
}

function cleanupUncertain(error: unknown): boolean {
  return typeof error === "object" && error !== null && "cleanupUncertain" in error
    && error.cleanupUncertain === true;
}

function cleanupRetry(error: unknown): (() => Promise<void>) | null {
  if (typeof error !== "object" || error === null || !("retryCleanup" in error)
    || typeof error.retryCleanup !== "function") return null;
  const retry = error.retryCleanup;
  return () => Promise.resolve(retry.call(error)).then(() => undefined);
}

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

function failError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
