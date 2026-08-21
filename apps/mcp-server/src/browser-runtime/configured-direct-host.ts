import {
  discoverBrowserExecutable,
  type BrowserDiscoveryInput,
  type BrowserExecutable,
  type BrowserFamily,
} from "./browser-discovery.ts";
import {
  createDirectBrowserHost,
  type DirectBrowserHostOptions,
  type DirectOwnedRuntime,
} from "./direct-browser-host.ts";
import {
  OwnedBrowserRuntimeError,
  launchOwnedBrowserRuntime,
  type LaunchOwnedBrowserRuntimeOptions,
} from "./owned-browser-runtime.ts";
import {
  createNewtonIdentity,
  inspectNewtonIdentityLease,
  listNewtonIdentities,
  openProfileStore,
  recoverStaleNewtonIdentityLease,
  removeNewtonIdentity,
  type IdentityLeaseClosureVerifier,
  type NewtonProfileIdentity,
  type ProfileStore,
} from "./profile-store.ts";
import type { BrowserHostPolicyManifest } from "@newton-browser/core";
import type { IdentityBinding } from "../config.ts";

type DiscoverBrowser = (input: BrowserDiscoveryInput) => BrowserExecutable | null;
type LaunchRuntime = (options: LaunchOwnedBrowserRuntimeOptions) => Promise<DirectOwnedRuntime>;

export type ConfiguredDirectBrowserHostOptions = Readonly<{
  profileStore?: ProfileStore;
  profileStoreRoot?: string;
  browserFamily?: BrowserFamily;
  executablePath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: "win32" | "darwin" | "linux";
  homeDirectory?: string;
  headless?: boolean;
  discoverBrowser?: DiscoverBrowser;
  launchRuntime?: LaunchRuntime;
  createIdentity?: typeof createNewtonIdentity;
  listIdentities?: typeof listNewtonIdentities;
  removeIdentity?: typeof removeNewtonIdentity;
  recoverIdentityLease?: typeof recoverStaleNewtonIdentityLease;
  identityLeaseRecoveryVerifier?: (browserFamily: BrowserFamily) => IdentityLeaseClosureVerifier;
  startDriverSession?: DirectBrowserHostOptions["startDriverSession"];
  maxSessions?: number;
  maxQueueItems?: number;
  maxQueueBytes?: number;
  hostPolicies?: readonly BrowserHostPolicyManifest[];
  identityBindings?: readonly IdentityBinding[];
}>;

export class ConfiguredDirectHostError extends Error {
  readonly code: string;
  readonly cleanupUncertain: boolean;
  readonly #cleanupRetry: (() => Promise<void>) | null;

  constructor(code: string, cleanupUncertain = false, cleanupRetry: (() => Promise<void>) | null = null) {
    super(code);
    this.name = "ConfiguredDirectHostError";
    this.code = code;
    this.cleanupUncertain = cleanupUncertain;
    this.#cleanupRetry = cleanupRetry;
  }

  retryCleanup(): Promise<void> {
    return this.#cleanupRetry
      ? this.#cleanupRetry()
      : Promise.reject(configuredError("configured_cleanup_retry_unavailable"));
  }
}

export function createConfiguredDirectBrowserHost(options: ConfiguredDirectBrowserHostOptions = {}) {
  const env = options.env ?? process.env;
  const store = configuredStore(options, env);
  const createIdentity = options.createIdentity ?? createNewtonIdentity;
  const listIdentities = options.listIdentities ?? listNewtonIdentities;
  const removeIdentity = options.removeIdentity ?? removeNewtonIdentity;
  const recoverIdentityLease = options.recoverIdentityLease ?? recoverStaleNewtonIdentityLease;
  const launchRuntime = options.launchRuntime ?? launchOwnedBrowserRuntime;
  const identityBindings = exactIdentityBindings(options.identityBindings ?? []);
  const configuredFamily = configuredOptional("family", options.browserFamily, env.NEWTON_BROWSER_BROWSER);
  const defaultFamily = exactFamily(configuredFamily);
  const explicitPath = configuredOptional("path", options.executablePath, env.NEWTON_BROWSER_BROWSER_EXECUTABLE);
  const executables = new Map<BrowserFamily, BrowserExecutable>();
  executables.set(defaultFamily, discoverExactBrowser(options, defaultFamily, explicitPath));
  const persistentReservations = new Set<string>();

  const launchOwnedRuntime: DirectBrowserHostOptions["launchOwnedRuntime"] = async ({ init }) => {
    const requestedIdentityId = init.identityId ?? identityBindings.get(init.origin);
    const persistentIdentity = requestedIdentityId === undefined
      ? null
      : findPersistentIdentity(store, requestedIdentityId, listIdentities);
    const requestedFamily = init.browserFamily === undefined ? undefined : exactFamily(init.browserFamily);
    if (persistentIdentity && requestedFamily !== undefined && requestedFamily !== persistentIdentity.browserFamily) {
      throw configuredError("configured_browser_identity_mismatch");
    }
    const family = persistentIdentity?.browserFamily ?? requestedFamily ?? defaultFamily;
    if (explicitPath !== undefined && family !== defaultFamily) {
      throw configuredError("configured_browser_family_conflict");
    }
    const executable = exactExecutable(options, executables, family, explicitPath, defaultFamily);
    const ephemeral = persistentIdentity === null;
    const persistentId = persistentIdentity?.id ?? null;
    if (persistentId !== null) reservePersistentIdentity(persistentReservations, persistentId);
    const releasePersistent = (): void => {
      if (persistentId !== null) persistentReservations.delete(persistentId);
    };
    let identity: NewtonProfileIdentity;
    try {
      if (persistentIdentity) {
        preparePersistentIdentityLease({
          store,
          identity: persistentIdentity,
          recoverIdentityLease,
          verifierFactory: options.identityLeaseRecoveryVerifier,
        });
      }
      identity = persistentIdentity ?? createIdentity(store, { browserFamily: family });
    } catch (error) {
      releasePersistent();
      throw boundedConfiguredError(error, "configured_identity_create_failed");
    }

    let runtime: DirectOwnedRuntime;
    try {
      runtime = await launchRuntime({
        executablePath: executable.path,
        browserFamily: identity.browserFamily,
        profileStore: store,
        identityId: identity.id,
        ephemeralIdentity: ephemeral,
        ...(options.headless === undefined ? {} : { headless: options.headless }),
        ...(options.platform === undefined ? {} : { platform: options.platform }),
      });
    } catch (error) {
      throw await startupFailure({
        error,
        store,
        identity,
        ephemeral,
        removeIdentity,
        releasePersistent,
      });
    }
    return wrapRuntime(runtime, {
      store,
      identity,
      ephemeral,
      removeIdentity,
      identityExists: () => listIdentities(store).some((candidate) => candidate.id === identity.id),
      releasePersistent,
    });
  };

  return createDirectBrowserHost({
    launchOwnedRuntime,
    ...(options.startDriverSession === undefined ? {} : { startDriverSession: options.startDriverSession }),
    ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
    ...(options.maxQueueItems === undefined ? {} : { maxQueueItems: options.maxQueueItems }),
    ...(options.maxQueueBytes === undefined ? {} : { maxQueueBytes: options.maxQueueBytes }),
    ...(options.hostPolicies === undefined ? {} : { hostPolicies: options.hostPolicies }),
  });
}

function preparePersistentIdentityLease(input: Readonly<{
  store: ProfileStore;
  identity: NewtonProfileIdentity;
  recoverIdentityLease: typeof recoverStaleNewtonIdentityLease;
  verifierFactory: ((browserFamily: BrowserFamily) => IdentityLeaseClosureVerifier) | undefined;
}>): void {
  let inspection: ReturnType<typeof inspectNewtonIdentityLease>;
  try { inspection = inspectNewtonIdentityLease(input.store, input.identity.id); }
  catch { throw configuredError("configured_identity_recovery_failed"); }
  if (inspection === "available") return;
  if (typeof input.verifierFactory !== "function") throw configuredError("configured_identity_busy");
  try {
    const verifier = input.verifierFactory(input.identity.browserFamily);
    if (typeof verifier !== "function") throw configuredError("configured_identity_recovery_unavailable");
    input.recoverIdentityLease(input.store, input.identity.id, verifier);
  } catch (error) {
    if (error instanceof ConfiguredDirectHostError) throw error;
    const code = boundedErrorCode(error);
    if (code === "profile_identity_lease_active") throw configuredError("configured_identity_busy");
    if (code === "profile_identity_lease_closure_unproved" || code === "profile_source_locked") {
      throw configuredError("configured_identity_recovery_unavailable");
    }
    throw configuredError("configured_identity_recovery_failed");
  }
}

function exactIdentityBindings(bindings: readonly IdentityBinding[]): ReadonlyMap<string, string> {
  if (!Array.isArray(bindings) || bindings.length > 64) throw configuredError("configured_identity_bindings_invalid");
  const result = new Map<string, string>();
  for (const binding of bindings) {
    if (!binding || typeof binding !== "object" || Object.keys(binding).some((key) => key !== "origin" && key !== "identityId")
      || Object.keys(binding).length !== 2
      || typeof binding.origin !== "string" || binding.origin.length > 512 || binding.origin !== binding.origin.trim()
      || typeof binding.identityId !== "string" || !/^nbi_[a-f0-9]{32}$/u.test(binding.identityId)) {
      throw configuredError("configured_identity_bindings_invalid");
    }
    let origin = "";
    try {
      const parsed = new URL(binding.origin);
      origin = (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === binding.origin
        ? binding.origin
        : "";
    } catch { /* invalid below */ }
    if (!origin || result.has(origin)) throw configuredError("configured_identity_bindings_invalid");
    result.set(origin, binding.identityId);
  }
  return result;
}

function reservePersistentIdentity(reservations: Set<string>, id: string): void {
  if (reservations.has(id)) throw configuredError("configured_identity_busy");
  reservations.add(id);
}

function exactExecutable(
  options: ConfiguredDirectBrowserHostOptions,
  executables: Map<BrowserFamily, BrowserExecutable>,
  family: BrowserFamily,
  explicitPath: string | undefined,
  defaultFamily: BrowserFamily,
): BrowserExecutable {
  const existing = executables.get(family);
  if (existing) return existing;
  const executable = discoverExactBrowser(
    options,
    family,
    family === defaultFamily ? explicitPath : undefined,
  );
  executables.set(family, executable);
  return executable;
}

function wrapRuntime(runtime: DirectOwnedRuntime, cleanup: IdentityCleanup): DirectOwnedRuntime {
  let runtimeClosed = false;
  let identityRemoved = false;
  let state: "ready" | "closing" | "cleanup_uncertain" | "closed" = "ready";
  let closeOperation: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (state === "closed") return Promise.resolve();
    if (closeOperation) return closeOperation;
    state = "closing";
    const operation = (async () => {
      if (!runtimeClosed) {
        try { await runtime.close(); } catch {
          state = "cleanup_uncertain";
          throw configuredError("configured_runtime_cleanup_uncertain", true, close);
        }
        runtimeClosed = true;
      }
      if (cleanup.ephemeral && !identityRemoved) {
        try {
          if (cleanup.identityExists?.() !== false) cleanup.removeIdentity(cleanup.store, cleanup.identity.id);
        } catch {
          state = "cleanup_uncertain";
          throw configuredError("configured_identity_cleanup_uncertain", true, close);
        }
        identityRemoved = true;
      }
      if (!cleanup.ephemeral) cleanup.releasePersistent();
      state = "closed";
    })();
    closeOperation = operation;
    void operation.finally(() => {
      if (closeOperation === operation) closeOperation = null;
    }).catch(() => {});
    return operation;
  };
  return Object.freeze({
    receipt: runtime.receipt,
    unavailable: runtime.unavailable,
    claimDriverBootstrap: () => runtime.claimDriverBootstrap(),
    cleanupState: () => state === "ready" ? runtime.cleanupState() : state,
    close,
  });
}

type IdentityCleanup = Readonly<{
  store: ProfileStore;
  identity: NewtonProfileIdentity;
  ephemeral: boolean;
  removeIdentity: typeof removeNewtonIdentity;
  identityExists?: () => boolean;
  releasePersistent(): void;
}>;

async function startupFailure(input: IdentityCleanup & { error: unknown }): Promise<ConfiguredDirectHostError> {
  if (input.error instanceof OwnedBrowserRuntimeError && input.error.identityBusy) {
    if (input.ephemeral) {
      try { input.removeIdentity(input.store, input.identity.id); }
      catch {
        return configuredError("configured_identity_cleanup_uncertain", true, async () => {
          input.removeIdentity(input.store, input.identity.id);
        });
      }
    } else {
      input.releasePersistent();
    }
    return configuredError("configured_identity_busy");
  }
  const retry = cleanupRetry(input.error);
  if (retry) {
    return configuredError("configured_runtime_start_uncertain", true, async () => {
      await retry();
      if (input.ephemeral) input.removeIdentity(input.store, input.identity.id);
      else input.releasePersistent();
    });
  }
  if (errorCleanupUncertain(input.error)) {
    // The process/proxy/lease may still own the identity. Retain both the filesystem
    // identity and the in-host reservation; a rejected cleanup retry is safer than
    // deleting or reissuing uncertain state.
    return configuredError("configured_runtime_start_uncertain", true);
  }
  if (input.ephemeral) {
    try { input.removeIdentity(input.store, input.identity.id); } catch {
      return configuredError("configured_identity_cleanup_uncertain", true, async () => {
        input.removeIdentity(input.store, input.identity.id);
      });
    }
  } else {
    input.releasePersistent();
  }
  return boundedConfiguredError(input.error, "configured_runtime_start_failed");
}

function errorCleanupUncertain(error: unknown): boolean {
  return record(error) && error.cleanupUncertain === true;
}

function configuredStore(options: ConfiguredDirectBrowserHostOptions, env: NodeJS.ProcessEnv): ProfileStore {
  if (options.profileStore) return options.profileStore;
  const root = configuredOptional("store", options.profileStoreRoot, env.NEWTON_BROWSER_PROFILE_STORE_DIR);
  if (root === undefined) throw configuredError("configured_profile_store_required");
  try { return openProfileStore(root); } catch (error) {
    throw boundedConfiguredError(error, "configured_profile_store_invalid");
  }
}

function findPersistentIdentity(
  store: ProfileStore,
  id: string,
  listIdentities: typeof listNewtonIdentities,
): NewtonProfileIdentity {
  try {
    const identity = listIdentities(store).find((candidate) => candidate.id === id);
    if (!identity) throw configuredError("configured_identity_unavailable");
    return identity;
  } catch (error) {
    throw boundedConfiguredError(error, "configured_identity_unavailable");
  }
}

function discoverExactBrowser(
  options: ConfiguredDirectBrowserHostOptions,
  family: BrowserFamily,
  explicitPath: string | undefined,
): BrowserExecutable {
  const discover = options.discoverBrowser ?? discoverBrowserExecutable;
  try {
    const executable = discover({
      family,
      ...(explicitPath === undefined ? {} : { explicitPath }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
    });
    if (!executable || executable.family !== family || typeof executable.path !== "string" || executable.path.length === 0) {
      throw configuredError("configured_browser_unavailable");
    }
    return executable;
  } catch (error) {
    throw boundedConfiguredError(error, "configured_browser_unavailable");
  }
}

function configuredOptional(
  kind: "family" | "path" | "store",
  explicit: string | undefined,
  environment: string | undefined,
): string | undefined {
  const value = explicit === undefined ? environment : explicit;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 32_768 || value.includes("\0")) {
    throw configuredError(`configured_${kind}_invalid`);
  }
  return value;
}

function exactFamily(value: string | undefined): BrowserFamily {
  if (value !== "chrome" && value !== "edge") throw configuredError("configured_browser_family_required");
  return value;
}

function cleanupRetry(error: unknown): (() => Promise<void>) | null {
  if (!record(error) || error.cleanupUncertain !== true || typeof error.retryCleanup !== "function") return null;
  const retry = error.retryCleanup;
  return () => Promise.resolve(retry.call(error)).then(() => undefined);
}

function boundedConfiguredError(error: unknown, fallback: string): ConfiguredDirectHostError {
  if (error instanceof ConfiguredDirectHostError) return error;
  const code = record(error) && typeof error.code === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(error.code)
    ? error.code
    : fallback;
  return configuredError(code);
}

function boundedErrorCode(error: unknown): string {
  const candidate = record(error) && typeof error.code === "string"
    ? error.code
    : error instanceof Error ? error.message : "";
  return /^[a-z][a-z0-9_]{0,79}$/u.test(candidate) ? candidate : "";
}

function configuredError(
  code: string,
  cleanupUncertain = false,
  retry: (() => Promise<void>) | null = null,
): ConfiguredDirectHostError {
  return new ConfiguredDirectHostError(code, cleanupUncertain, retry);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
