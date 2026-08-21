import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { configDirectory, ensureConfigDirectory, loadBrowserPreference, profileStoreDirectory, resolveConfigDirectory, writeBrowserPreference } from "../config.ts";
import { discoverBrowserExecutable, type BrowserExecutable, type BrowserFamily } from "./browser-discovery.ts";
import { createConfiguredDirectBrowserHost } from "./configured-direct-host.ts";
import { createIdentityLeaseClosureVerifier } from "./identity-lease-closure.ts";
import {
  launchOwnedBrowserRuntime,
  type LaunchOwnedBrowserRuntimeOptions,
  type OwnedBrowserRuntime,
} from "./owned-browser-runtime.ts";
import {
  inspectNewtonIdentityLease,
  listNewtonIdentities,
  openProfileStore,
  recoverStaleNewtonIdentityLease,
  type IdentityLeaseClosureVerifier,
} from "./profile-store.ts";

const IDENTITY_PATTERN = /^nbi_[a-f0-9]{32}$/u;

type SetupOwnedRuntime = Readonly<{
  receipt: OwnedBrowserRuntime["receipt"];
  unavailable: Promise<void>;
  claimDriverBootstrap: OwnedBrowserRuntime["claimDriverBootstrap"];
  close(): Promise<void>;
}>;
type SetupRuntimeLauncher = (options: LaunchOwnedBrowserRuntimeOptions) => Promise<SetupOwnedRuntime>;

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
  cleanupConfirmed?: true;
}>;

export type DirectLiveDoctorReceipt = Readonly<{
  configured: true;
  runtimeVerified: true;
  cleanupConfirmed: true;
  browserFamily: BrowserFamily;
  transport: "private_cdp_pipe";
  networking: "normal_browser";
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
  directory?: string;
  env?: NodeJS.ProcessEnv;
  onReady?(receipt: DirectIdentityLoginReceipt): void;
  discoverBrowser?: typeof discoverBrowserExecutable;
  launchRuntime?: SetupRuntimeLauncher;
  identityLeaseRecoveryVerifier?: IdentityLeaseClosureVerifier;
  createTerminationSignal?: typeof terminationSignal;
}): Promise<DirectIdentityLoginReceipt> {
  const env = input.env ?? process.env;
  const directory = resolveConfigDirectory(input.directory ?? configDirectory(env));
  if (!IDENTITY_PATTERN.test(input.identityId)) fail("identity_login_invalid_arguments");
  const origin = exactOrigin(input.origin);
  const store = openProfileStore(profileStoreDirectory(env, directory));
  const identity = listNewtonIdentities(store).find((candidate) => candidate.id === input.identityId);
  if (!identity) fail("identity_login_unavailable");
  recoverIdentityForLogin(
    store,
    identity.id,
    input.identityLeaseRecoveryVerifier
      ?? createIdentityLeaseClosureVerifier({ browserFamily: identity.browserFamily }),
  );
  const executable = discoverConfiguredBrowser(input.discoverBrowser, identity.browserFamily, env, "identity_login_browser_unavailable");
  let runtime: SetupOwnedRuntime;
  try {
    runtime = await (input.launchRuntime ?? launchOwnedBrowserRuntime)({
      executablePath: executable.path,
      browserFamily: identity.browserFamily,
      profileStore: store,
      identityId: identity.id,
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
  const termination = (input.createTerminationSignal ?? terminationSignal)();
  try {
    const bootstrap = runtime.claimDriverBootstrap();
    await navigateOperatorLogin(bootstrap, `${origin}/`);
    input.onReady?.(Object.freeze({
      status: "ready",
      browserFamily: identity.browserFamily,
      identityId: identity.id,
    }));
    await Promise.race([
      runtime.unavailable.then(() => "runtime_unavailable" as const),
      termination.promise.then(() => "operator_close" as const),
    ]);
    // Closing the owned visible Chrome window is the normal operator completion
    // path. Cleanup below must still confirm the exact process tree and identity
    // lease before this command reports `closed`.
  } catch (error) {
    if (!await cleanupLoginRuntime(runtime)) fail("identity_login_cleanup_uncertain");
    throw bounded(error, "identity_login_failed");
  } finally {
    termination.dispose();
  }
  if (!await cleanupLoginRuntime(runtime)) fail("identity_login_cleanup_uncertain");
  return Object.freeze({
    status: "closed",
    browserFamily: identity.browserFamily,
    identityId: identity.id,
    cleanupConfirmed: true,
  });
}

async function cleanupLoginRuntime(
  runtime: SetupOwnedRuntime,
): Promise<boolean> {
  try { await runtime.close(); return true; } catch {
    try { await runtime.close(); return true; } catch { return false; }
  }
}

function recoverIdentityForLogin(
  store: ReturnType<typeof openProfileStore>,
  identityId: string,
  verifier: IdentityLeaseClosureVerifier,
): void {
  let inspection: ReturnType<typeof inspectNewtonIdentityLease>;
  try { inspection = inspectNewtonIdentityLease(store, identityId); }
  catch { fail("identity_login_identity_recovery_failed"); }
  if (inspection === "available") return;
  try { recoverStaleNewtonIdentityLease(store, identityId, verifier); }
  catch (error) {
    const code = boundedCode(error);
    if (code === "profile_identity_lease_active") fail("identity_login_identity_busy");
    if (code === "profile_identity_lease_closure_unproved" || code === "profile_source_locked") {
      fail("identity_login_identity_recovery_unavailable");
    }
    fail("identity_login_identity_recovery_failed");
  }
}

async function navigateOperatorLogin(
  bootstrap: ReturnType<SetupOwnedRuntime["claimDriverBootstrap"]>,
  url: string,
): Promise<void> {
  const attached = await bootstrap.transport.send("Target.attachToTarget", {
    targetId: bootstrap.rootTargetId,
    flatten: true,
  });
  const sessionId = typeof attached.sessionId === "string" && attached.sessionId.length > 0
    ? attached.sessionId
    : null;
  if (!sessionId) fail("identity_login_start_failed");
  await bootstrap.transport.send("Page.enable", {}, sessionId);
  const navigation = await bootstrap.transport.send("Page.navigate", { url }, sessionId);
  if (typeof navigation.errorText === "string" && navigation.errorText.length > 0) {
    fail("identity_login_navigation_failed");
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
    networking: "normal_browser",
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
    const executable = (provider ?? discoverBrowserExecutable)({
      family,
      env,
      ...(env.NEWTON_BROWSER_BROWSER_EXECUTABLE
        ? { explicitPath: env.NEWTON_BROWSER_BROWSER_EXECUTABLE }
        : {}),
    });
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

function boundedCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : error instanceof Error ? error.message : "";
  return /^[a-z][a-z0-9_]{0,79}$/u.test(code) ? code : "";
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
