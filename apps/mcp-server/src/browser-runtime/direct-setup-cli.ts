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

import { configDirectory, loadDirectBrowserConfig, writeDirectBrowserConfig } from "../config.ts";
import { discoverBrowserExecutable, type BrowserExecutable, type BrowserFamily } from "./browser-discovery.ts";
import { createConfiguredDirectBrowserHost } from "./configured-direct-host.ts";
import {
  launchOwnedBrowserRuntime,
  type LaunchOwnedBrowserRuntimeOptions,
  type OwnedBrowserRuntime,
} from "./owned-browser-runtime.ts";
import {
  createNewtonIdentity,
  inspectNewtonIdentityLease,
  listNewtonIdentities,
  openProfileStore,
  removeNewtonIdentity,
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
  identityId: string;
  identityCreated: boolean;
  transport: "stdio";
  nextAction: "identity_login";
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
  identityId?: string;
  directory?: string;
  env?: NodeJS.ProcessEnv;
  discoverBrowser?: typeof discoverBrowserExecutable;
}): DirectBrowserSetupReceipt {
  const env = input.env ?? process.env;
  const directory = path.resolve(input.directory ?? configDirectory(env));
  const browserFamily = exactFamily(input.browserFamily);
  ensureDirectory(directory);
  discoverConfiguredBrowser(input.discoverBrowser, browserFamily, env, "direct_browser_unavailable");
  const store = openProfileStore(path.join(directory, "identities"));
  const existing = loadDirectBrowserConfig({ directory, env: withoutDirectConfigOverrides(env) });
  if (input.identityId !== undefined) {
    if (!IDENTITY_PATTERN.test(input.identityId)) fail("direct_identity_unavailable");
    const selected = listNewtonIdentities(store).find((candidate) => candidate.id === input.identityId);
    if (!selected || selected.browserFamily !== browserFamily) fail("direct_identity_unavailable");
    try { writeDirectBrowserConfig({ directory, browserTarget: browserFamily, identityId: selected.id }); }
    catch { fail("direct_setup_failed"); }
    return Object.freeze({
      configured: true,
      browserFamily,
      identityId: selected.id,
      identityCreated: false,
      transport: "stdio",
      nextAction: "identity_login",
    });
  }
  if (existing) {
    if (existing.browserTarget !== browserFamily) fail("direct_setup_conflict");
    const identity = listNewtonIdentities(store).find((candidate) => candidate.id === existing.identityId);
    if (!identity) return createConfiguredIdentity(store, directory, browserFamily);
    if (identity.browserFamily !== browserFamily) fail("direct_identity_unavailable");
    return Object.freeze({
      configured: true,
      browserFamily,
      identityId: identity.id,
      identityCreated: false,
      transport: "stdio",
      nextAction: "identity_login",
    });
  }
  return createConfiguredIdentity(store, directory, browserFamily);
}

function createConfiguredIdentity(
  store: ReturnType<typeof openProfileStore>,
  directory: string,
  browserFamily: BrowserFamily,
): DirectBrowserSetupReceipt {
  const identity = createNewtonIdentity(store, { browserFamily });
  try {
    writeDirectBrowserConfig({ directory, browserTarget: browserFamily, identityId: identity.id });
  } catch {
    try { removeNewtonIdentity(store, identity.id); } catch { fail("direct_setup_cleanup_uncertain"); }
    fail("direct_setup_failed");
  }
  return Object.freeze({
    configured: true,
    browserFamily,
    identityId: identity.id,
    identityCreated: true,
    transport: "stdio",
    nextAction: "identity_login",
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
}): Promise<DirectIdentityLoginReceipt> {
  const env = input.env ?? process.env;
  const directory = path.resolve(input.directory ?? configDirectory(env));
  if (!IDENTITY_PATTERN.test(input.identityId)) fail("identity_login_invalid_arguments");
  const origin = exactOrigin(input.origin);
  const allowedOrigins = exactOrigins(origin, input.allowedOrigins ?? []);
  const store = openProfileStore(path.join(directory, "identities"));
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
  const termination = terminationSignal();
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
    await Promise.race([runtime.unavailable, termination.promise]);
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
  const directory = path.resolve(input.directory ?? configDirectory(env));
  const configured = loadDirectBrowserConfig({ directory, env: withoutDirectConfigOverrides(env) });
  if (!configured) fail("direct_not_configured");
  const configuredStore = openProfileStore(path.join(directory, "identities"));
  const configuredIdentity = listNewtonIdentities(configuredStore)
    .find((candidate) => candidate.id === configured.identityId);
  if (!configuredIdentity || configuredIdentity.browserFamily !== configured.browserTarget) {
    fail("direct_identity_unavailable");
  }
  if (inspectNewtonIdentityLease(configuredStore, configured.identityId) !== "available") {
    fail("direct_identity_busy");
  }
  const executable = discoverConfiguredBrowser(input.discoverBrowser, configured.browserTarget, env, "direct_browser_unavailable");
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
      browserFamily: configured.browserTarget,
      executablePath: executable.path,
      headless: true,
    });
    const created = host.createSession({
      origin,
      allowedOrigins: [origin],
      goal: "live_doctor",
      instanceLabel: "live_doctor",
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
    browserFamily: configured.browserTarget,
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
  const origins = [...new Set([primary, ...secondary.map(exactOrigin)])];
  if (origins.length > 32) fail("identity_login_invalid_arguments");
  return origins;
}

function exactOrigin(value: string): string {
  if (typeof value !== "string" || value !== value.trim() || value.length > 2_048) fail("identity_login_invalid_arguments");
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

function ensureDirectory(directory: string): void {
  try {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    fs.chmodSync(directory, 0o700);
  } catch {
    fail("direct_config_directory_invalid");
  }
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
  delete output.NEWTON_BROWSER_IDENTITY_ID;
  return output;
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
