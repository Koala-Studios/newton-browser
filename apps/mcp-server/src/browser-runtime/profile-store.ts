import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const STORE_MARKER = ".newton-browser-profile-store";
const IDENTITY_MARKER = ".newton-browser-profile-identity";
const IDENTITY_MANIFEST = ".newton-browser-profile.json";
const IDENTITY_LEASE = ".newton-browser-profile-lease";
const STORE_LOCK = ".newton-browser-profile-store.lock";
const IDENTITY_PATTERN = /^nbi_[a-f0-9]{32}$/;
const MAX_IMPORT_FILES = 4_096;
const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
const MAX_IMPORT_DEPTH = 12;

export const OPAQUE_PROFILE_ALLOWLIST = Object.freeze({
  rootFiles: ["Local State"],
  profileFiles: ["Cookies", "Cookies-journal", "Network/Cookies", "Network/Cookies-journal"],
  profileDirectories: ["Local Storage/leveldb", "IndexedDB"],
  excludedByDefault: ["History", "Login Data", "Web Data", "Autofill", "Downloads", "Extensions", "Sessions", "Session Storage", "Service Worker", "Cache", "Code Cache", "GPUCache"],
});

export type ProfileStore = Readonly<{ root: string }>;
export type IdentityManifest = Readonly<{
  version: 1;
  id: string;
  browserFamily: "chrome" | "edge";
  createdAt: string;
  source: "new" | "opaque_import";
}>;
export type NewtonProfileIdentity = IdentityManifest & Readonly<{
  path: string;
}>;
export type OpaqueImportReceipt = NewtonProfileIdentity & Readonly<{
  fileCount: number;
  totalBytes: number;
}>;
export type NewtonIdentityLease = Readonly<{
  id: string;
  path: string;
  browserFamily: "chrome" | "edge";
}>;
export type NewtonIdentityLeaseInspection = "available" | "active_or_stale";
export type NewtonIdentityLeaseRecovery = "available" | "recovered";
export type GuardianProfileCleanupPlan = Readonly<{
  storeRoot: string;
  identityPath: string;
  identityId: string;
  identityDev: string;
  identityIno: string;
  identityMarkerNonce: string;
  storeNonce: string;
  leasePath: string;
  leaseDev: string;
  leaseIno: string;
  leaseNonce: string;
  leasePid: number;
  leaseCreatedAt: string;
  removeIdentity: boolean;
}>;
export type SourceClosureVerifier = (source: Readonly<{ userDataRoot: string; profileDirectory: string }>) => boolean;
export type OpaqueProfileSource = Readonly<{ browserFamily: "chrome" | "edge"; fileCount: number; totalBytes: number }>;

type Marker = {
  version: 1;
  type: "store" | "identity";
  nonce: string;
  storeNonce: string;
  identity?: string;
  kind?: "persistent" | "opaque_import";
  dev: string;
  ino: string;
};

type FileFact = {
  relative: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

type PreparedSource = {
  userDataRoot: string;
  profileDirectory: string;
  browserFamily: "chrome" | "edge";
  verifier: SourceClosureVerifier;
  snapshot: FileFact[];
  fileCount: number;
  totalBytes: number;
};

type LeaseFileIdentity = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

type RegisteredLease = {
  store: ProfileStore;
  identity: NewtonProfileIdentity;
  identityMarker: Marker;
  nonce: string;
  pid: number;
  createdAt: string;
  fileIdentity: LeaseFileIdentity;
  active: boolean;
};

const stores = new WeakMap<ProfileStore, Marker>();
const preparedSources = new WeakMap<OpaqueProfileSource, PreparedSource>();
const leases = new WeakMap<NewtonIdentityLease, RegisteredLease>();

export function openProfileStore(storeRoot: string): ProfileStore {
  const requested = checkedAbsolute(storeRoot, "profile_store_invalid");
  const parent = canonicalDirectory(path.dirname(requested), "profile_store_invalid");
  const absolute = path.join(parent, path.basename(requested));
  if (!fs.existsSync(absolute)) {
    try {
      fs.mkdirSync(absolute, { mode: 0o700 });
    } catch {
      fail("profile_store_create_failed");
    }
    writeMarker(absolute, { version: 1, type: "store", nonce: nonce(), storeNonce: "", ...directoryIdentity(absolute) });
  }
  assertPlainDirectory(absolute, "profile_store_invalid");
  try {
    fs.chmodSync(absolute, 0o700);
  } catch {
    fail("profile_store_invalid");
  }
  const marker = readMarker(absolute, STORE_MARKER, "store");
  assertMarkerIdentity(absolute, marker, "profile_store_invalid");
  let resolvedRoot: string;
  try {
    resolvedRoot = fs.realpathSync.native(absolute);
  } catch {
    fail("profile_store_invalid");
  }
  const store = Object.freeze({ root: resolvedRoot });
  stores.set(store, marker);
  return store;
}

export function createNewtonIdentity(store: ProfileStore, input: { browserFamily: "chrome" | "edge" }): NewtonProfileIdentity {
  const storeMarker = requireStore(store);
  const browserFamily = checkedBrowserFamily(input.browserFamily);
  return withStoreLock(store, () => {
    const identity = newIdentityId(store);
    const destination = identityPath(store, identity);
    const stage = createStage(store, identity, "new", browserFamily, storeMarker);
    try {
      publishStage(stage.path, destination);
      stage.published = true;
      return describeIdentity(store, destination, identity);
    } finally {
      if (!stage.published) removeOwnedStage(stage);
    }
  });
}

export function prepareOpaqueProfileSource(input: {
  browserFamily: "chrome" | "edge";
  userDataRoot: string;
  profileDirectory: string;
  verifyClosed: SourceClosureVerifier;
}): OpaqueProfileSource {
  if (typeof input.verifyClosed !== "function") fail("profile_source_closure_unproved");
  const browserFamily = checkedBrowserFamily(input.browserFamily);
  const userDataRoot = checkedAbsolute(input.userDataRoot, "profile_source_invalid");
  assertPlainDirectory(userDataRoot, "profile_source_invalid");
  const profileDirectory = checkedProfileDirectory(input.profileDirectory);
  const profileRoot = path.join(userDataRoot, profileDirectory);
  assertDirectChild(userDataRoot, profileRoot, "profile_source_invalid");
  assertPlainDirectory(profileRoot, "profile_source_invalid");
  assertNoBrowserLocks(userDataRoot);
  if (!closureProved(input.verifyClosed, userDataRoot, profileDirectory)) fail("profile_source_closure_unproved");
  const snapshot = snapshotAllowedFiles(userDataRoot, profileDirectory);
  const totalBytes = snapshot.reduce((sum, fact) => sum + Number(fact.size), 0);
  const source = Object.freeze({ browserFamily, fileCount: snapshot.length, totalBytes });
  preparedSources.set(source, { userDataRoot, profileDirectory, browserFamily, verifier: input.verifyClosed, snapshot, fileCount: snapshot.length, totalBytes });
  return source;
}

export function importOpaqueProfile(store: ProfileStore, input: { source: OpaqueProfileSource }): OpaqueImportReceipt {
  const storeMarker = requireStore(store);
  const source = preparedSources.get(input.source);
  if (!source) fail("profile_source_unrecognized");
  return withStoreLock(store, () => {
    const identity = newIdentityId(store);
    const destination = identityPath(store, identity);
    verifyPreparedSource(source);
    const stage = createStage(store, identity, "opaque_import", source.browserFamily, storeMarker);
    try {
      copySnapshot(source, stage.path);
      verifyPreparedSource(source);
      publishStage(stage.path, destination);
      stage.published = true;
      return Object.freeze({ ...readManifest(destination), path: destination, fileCount: source.fileCount, totalBytes: source.totalBytes });
    } finally {
      preparedSources.delete(input.source);
      if (!stage.published) removeOwnedStage(stage);
    }
  });
}

export function listNewtonIdentities(store: ProfileStore): NewtonProfileIdentity[] {
  requireStore(store);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(store.root, { withFileTypes: true });
  } catch {
    fail("profile_store_invalid");
  }
  const identities = entries.filter((entry) => IDENTITY_PATTERN.test(entry.name));
  if (identities.length > 256) fail("profile_store_identity_limit");
  return identities.sort((left, right) => left.name.localeCompare(right.name)).map((entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail("profile_identity_invalid");
    return describeIdentity(store, identityPath(store, entry.name), entry.name);
  });
}

export function acquireNewtonIdentityLease(store: ProfileStore, id: string): NewtonIdentityLease {
  requireStore(store);
  const identityId = checkedIdentity(id);
  return withStoreLock(store, () => {
    const identity = describeIdentity(store, identityPath(store, identityId), identityId);
    const identityMarker = readMarker(identity.path, IDENTITY_MARKER, "identity");
    const leasePath = path.join(identity.path, IDENTITY_LEASE);
    if (pathEntryExists(leasePath, "profile_identity_lease_unreadable")) fail("profile_identity_busy");
    const leaseNonce = nonce();
    const createdAt = new Date().toISOString();
    const metadata = { version: 1, type: "identity_lease", id: identity.id, browserFamily: identity.browserFamily, nonce: leaseNonce, pid: process.pid, createdAt };
    let handle: number | undefined;
    try {
      handle = fs.openSync(leasePath, "wx", 0o600);
      fs.writeFileSync(handle, `${JSON.stringify(metadata)}\n`);
      fs.fsyncSync(handle);
    } catch {
      fail("profile_identity_busy");
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
    }
    try {
      fs.chmodSync(leasePath, 0o600);
    } catch {
      fail("profile_identity_lease_invalid");
    }
    const fileIdentity = leaseFileIdentity(leasePath);
    const capability = Object.freeze({ id: identity.id, path: identity.path, browserFamily: identity.browserFamily });
    leases.set(capability, { store, identity, identityMarker, nonce: leaseNonce, pid: process.pid, createdAt, fileIdentity, active: true });
    return capability;
  });
}

export function validateNewtonIdentityLease(lease: NewtonIdentityLease, directory: string): boolean {
  const state = leases.get(lease);
  if (!state || !state.active) return false;
  try {
    validateLeaseState(state, directory, path.join(state.identity.path, IDENTITY_LEASE));
    return true;
  } catch {
    return false;
  }
}

export function releaseNewtonIdentityLease(lease: NewtonIdentityLease): void {
  const state = leases.get(lease);
  if (!state) fail("profile_identity_lease_unrecognized");
  if (!state.active) return;
  withStoreLock(state.store, () => {
    const leasePath = path.join(state.identity.path, IDENTITY_LEASE);
    validateLeaseState(state, state.identity.path, leasePath);
    const quarantine = path.join(state.identity.path, `.released-lease-${nonce()}`);
    try {
      fs.renameSync(leasePath, quarantine);
    } catch {
      fail("profile_identity_lease_release_failed");
    }
    try {
      validateLeaseState(state, state.identity.path, quarantine, true);
      fs.unlinkSync(quarantine);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("profile_identity_lease_")) throw error;
      fail("profile_identity_lease_release_failed");
    }
    state.active = false;
  });
}

export function guardianProfileCleanupPlan(lease: NewtonIdentityLease, removeIdentity: boolean): GuardianProfileCleanupPlan {
  const state = leases.get(lease);
  if (!state || !state.active) fail("profile_identity_lease_unrecognized");
  const leasePath = path.join(state.identity.path, IDENTITY_LEASE);
  validateLeaseState(state, state.identity.path, leasePath);
  const identityFact = directoryIdentity(state.identity.path);
  return Object.freeze({
    storeRoot: state.store.root,
    identityPath: state.identity.path,
    identityId: state.identity.id,
    identityDev: identityFact.dev,
    identityIno: identityFact.ino,
    identityMarkerNonce: state.identityMarker.nonce,
    storeNonce: state.identityMarker.storeNonce,
    leasePath,
    leaseDev: state.fileIdentity.dev.toString(),
    leaseIno: state.fileIdentity.ino.toString(),
    leaseNonce: state.nonce,
    leasePid: state.pid,
    leaseCreatedAt: state.createdAt,
    removeIdentity: removeIdentity === true,
  });
}

export function acknowledgeGuardianProfileCleanup(lease: NewtonIdentityLease): void {
  const state = leases.get(lease);
  if (!state) fail("profile_identity_lease_unrecognized");
  if (!state.active) return;
  const leasePath = path.join(state.identity.path, IDENTITY_LEASE);
  if (pathEntryExists(leasePath, "profile_identity_lease_unreadable")) {
    releaseNewtonIdentityLease(lease);
    return;
  }
  state.active = false;
}

export function inspectNewtonIdentityLease(store: ProfileStore, id: string): NewtonIdentityLeaseInspection {
  requireStore(store);
  const identityId = checkedIdentity(id);
  const identity = describeIdentity(store, identityPath(store, identityId), identityId);
  return pathEntryExists(path.join(identity.path, IDENTITY_LEASE), "profile_identity_lease_unreadable") ? "active_or_stale" : "available";
}

export function recoverStaleNewtonIdentityLease(
  store: ProfileStore,
  id: string,
  verifyBrowserClosed: SourceClosureVerifier,
): NewtonIdentityLeaseRecovery {
  requireStore(store);
  const identityId = checkedIdentity(id);
  return withStoreLock(store, () => {
    const identity = describeIdentity(store, identityPath(store, identityId), identityId);
    const leasePath = path.join(identity.path, IDENTITY_LEASE);
    if (!pathEntryExists(leasePath, "profile_identity_lease_unreadable")) return "available";
    const metadata = readLeaseMetadata(leasePath);
    if (metadata.id !== identity.id || metadata.browserFamily !== identity.browserFamily) fail("profile_identity_lease_invalid");
    if (processExists(metadata.pid)) fail("profile_identity_lease_active");
    // The recorded host can be gone while its guardian/browser tree is still
    // cleaning up. Never infer profile closure from the host PID alone. The
    // independently supplied verifier is deliberately conservative and proves
    // that no process from this identity's browser family is running before the
    // exact stale lease is quarantined.
    if (!closureProved(verifyBrowserClosed, identity.path, "Default")) {
      fail("profile_identity_lease_closure_unproved");
    }
    const fileIdentity = leaseFileIdentity(leasePath);
    const quarantine = path.join(identity.path, `.recovered-lease-${nonce()}`);
    try { fs.renameSync(leasePath, quarantine); } catch { fail("profile_identity_lease_recovery_failed"); }
    try {
      const moved = leaseFileIdentity(quarantine);
      if (!sameLeaseFileIdentity(moved, fileIdentity, true)) fail("profile_identity_lease_recovery_failed");
      const movedMetadata = readLeaseMetadata(quarantine);
      if (movedMetadata.nonce !== metadata.nonce || movedMetadata.pid !== metadata.pid || movedMetadata.createdAt !== metadata.createdAt) {
        fail("profile_identity_lease_recovery_failed");
      }
      fs.unlinkSync(quarantine);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("profile_identity_lease_")) throw error;
      fail("profile_identity_lease_recovery_failed");
    }
    return "recovered";
  });
}

export function removeNewtonIdentity(store: ProfileStore, id: string): void {
  requireStore(store);
  const identity = checkedIdentity(id);
  withStoreLock(store, () => {
    const target = identityPath(store, identity);
    if (pathEntryExists(path.join(target, IDENTITY_LEASE), "profile_identity_lease_unreadable")) fail("profile_identity_busy");
    const marker = readMarker(target, IDENTITY_MARKER, "identity");
    if (marker.identity !== identity) fail("profile_identity_invalid");
    assertMarkerIdentity(target, marker, "profile_identity_invalid");
    const quarantine = path.join(store.root, `.removing-${identity}-${nonce()}`);
    try {
      fs.renameSync(target, quarantine);
    } catch {
      fail("profile_identity_cleanup_failed");
    }
    assertDirectChild(store.root, quarantine, "profile_identity_cleanup_failed");
    assertMarkerIdentity(quarantine, marker, "profile_identity_cleanup_failed");
    try {
      fs.rmSync(quarantine, { recursive: true });
    } catch {
      fail("profile_identity_cleanup_failed");
    }
  });
}

function verifyPreparedSource(source: PreparedSource): void {
  assertNoBrowserLocks(source.userDataRoot);
  if (!closureProved(source.verifier, source.userDataRoot, source.profileDirectory)) fail("profile_source_closure_unproved");
  const current = snapshotAllowedFiles(source.userDataRoot, source.profileDirectory);
  if (!sameSnapshot(source.snapshot, current)) fail("profile_source_changed");
}

function validateLeaseState(state: RegisteredLease, directory: string, leasePath: string, renamed = false): void {
  requireStore(state.store);
  const absoluteDirectory = checkedAbsolute(directory, "profile_identity_lease_invalid");
  if (directory !== state.identity.path || absoluteDirectory !== state.identity.path) fail("profile_identity_lease_invalid");
  const identity = describeIdentity(state.store, state.identity.path, state.identity.id);
  if (identity.id !== state.identity.id || identity.path !== state.identity.path || identity.browserFamily !== state.identity.browserFamily
    || identity.createdAt !== state.identity.createdAt || identity.source !== state.identity.source) fail("profile_identity_lease_invalid");
  const currentMarker = readMarker(identity.path, IDENTITY_MARKER, "identity");
  if (!sameMarker(currentMarker, state.identityMarker)) fail("profile_identity_lease_invalid");
  const currentFileIdentity = leaseFileIdentity(leasePath);
  if (!sameLeaseFileIdentity(currentFileIdentity, state.fileIdentity, renamed)) fail("profile_identity_lease_invalid");
  const metadata = readLeaseMetadata(leasePath);
  if (metadata.id !== state.identity.id || metadata.browserFamily !== state.identity.browserFamily || metadata.nonce !== state.nonce
    || metadata.pid !== state.pid || metadata.createdAt !== state.createdAt) fail("profile_identity_lease_invalid");
}

function readLeaseMetadata(leasePath: string): { id: string; browserFamily: "chrome" | "edge"; nonce: string; pid: number; createdAt: string } {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(leasePath, "utf8"));
  } catch {
    fail("profile_identity_lease_invalid");
  }
  if (!value || typeof value !== "object") fail("profile_identity_lease_invalid");
  const metadata = value as Record<string, unknown>;
  if (metadata.version !== 1 || metadata.type !== "identity_lease" || typeof metadata.id !== "string" || !IDENTITY_PATTERN.test(metadata.id)
    || (metadata.browserFamily !== "chrome" && metadata.browserFamily !== "edge")
    || typeof metadata.nonce !== "string" || !/^[a-f0-9]{64}$/.test(metadata.nonce)
    || typeof metadata.pid !== "number" || !Number.isSafeInteger(metadata.pid) || metadata.pid <= 0
    || typeof metadata.createdAt !== "string" || !Number.isFinite(Date.parse(metadata.createdAt))
    || Object.keys(metadata).sort().join(",") !== "browserFamily,createdAt,id,nonce,pid,type,version") fail("profile_identity_lease_invalid");
  return metadata as { id: string; browserFamily: "chrome" | "edge"; nonce: string; pid: number; createdAt: string };
}

function leaseFileIdentity(leasePath: string): LeaseFileIdentity {
  let stat: fs.BigIntStats;
  let real: string;
  try {
    stat = fs.lstatSync(leasePath, { bigint: true });
    real = fs.realpathSync.native(leasePath);
  } catch {
    fail("profile_identity_lease_invalid");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || path.resolve(real) !== path.resolve(leasePath)) fail("profile_identity_lease_invalid");
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

function sameLeaseFileIdentity(left: LeaseFileIdentity, right: LeaseFileIdentity, renamed: boolean): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && (renamed || (left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs));
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function sameMarker(left: Marker, right: Marker): boolean {
  return left.version === right.version && left.type === right.type && left.nonce === right.nonce && left.storeNonce === right.storeNonce
    && left.identity === right.identity && left.kind === right.kind && left.dev === right.dev && left.ino === right.ino;
}

function copySnapshot(source: PreparedSource, stage: string): void {
  for (const fact of source.snapshot) {
    const from = path.join(source.userDataRoot, fact.relative);
    const destinationRelative = fact.relative === "Local State"
      ? "Local State"
      : path.join("Default", path.relative(source.profileDirectory, fact.relative));
    const to = path.join(stage, destinationRelative);
    assertWithin(source.userDataRoot, from, "profile_source_invalid");
    assertWithin(stage, to, "profile_import_failed");
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      copyOpaqueFile(from, to, fact);
    } catch (error) {
      if (error instanceof Error && error.message === "profile_source_changed") throw error;
      fail("profile_import_failed");
    }
    const after = regularFileFact(source.userDataRoot, fact.relative);
    if (!sameFact(fact, after)) fail("profile_source_changed");
  }
}

function snapshotAllowedFiles(userDataRoot: string, profileDirectory: string): FileFact[] {
  const facts: FileFact[] = [];
  facts.push(regularFileFact(userDataRoot, "Local State"));
  for (const relative of OPAQUE_PROFILE_ALLOWLIST.profileFiles) {
    const candidate = path.join(profileDirectory, ...relative.split("/"));
    if (pathEntryExists(path.join(userDataRoot, candidate))) facts.push(regularFileFact(userDataRoot, candidate));
  }
  for (const relative of OPAQUE_PROFILE_ALLOWLIST.profileDirectories) {
    const candidate = path.join(profileDirectory, ...relative.split("/"));
    const absolute = path.join(userDataRoot, candidate);
    if (pathEntryExists(absolute)) walkAllowedDirectory(userDataRoot, candidate, facts, 0);
  }
  facts.sort((left, right) => left.relative.localeCompare(right.relative));
  let bytes = 0;
  for (const fact of facts) {
    if (fact.size > BigInt(MAX_IMPORT_BYTES) || fact.size > BigInt(Number.MAX_SAFE_INTEGER)) fail("profile_source_too_large");
    bytes += Number(fact.size);
    if (!Number.isSafeInteger(bytes) || bytes > MAX_IMPORT_BYTES || facts.length > MAX_IMPORT_FILES) fail("profile_source_too_large");
  }
  return facts;
}

function walkAllowedDirectory(root: string, relative: string, facts: FileFact[], depth: number): void {
  if (depth > MAX_IMPORT_DEPTH) fail("profile_source_too_large");
  const directory = path.join(root, relative);
  assertWithin(root, directory, "profile_source_invalid");
  assertPlainDirectory(directory, "profile_source_invalid");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    fail("profile_source_unreadable");
  }
  const foldedNames = new Set<string>();
  for (const entry of entries) {
    if (entry.name.length === 0 || entry.name.length > 255 || entry.name === "." || entry.name === "..") fail("profile_source_invalid");
    const folded = entry.name.normalize("NFC").toLocaleLowerCase("en-US");
    if (foldedNames.has(folded)) fail("profile_source_case_collision");
    foldedNames.add(folded);
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) fail("profile_source_link_rejected");
    if (entry.isDirectory()) walkAllowedDirectory(root, child, facts, depth + 1);
    else if (entry.isFile()) facts.push(regularFileFact(root, child));
    else fail("profile_source_nonregular");
    if (facts.length > MAX_IMPORT_FILES) fail("profile_source_too_large");
  }
}

function copyOpaqueFile(from: string, to: string, expected: FileFact): void {
  const noFollow = "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;
  let sourceHandle: number | undefined;
  let destinationHandle: number | undefined;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    sourceHandle = fs.openSync(from, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(sourceHandle, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== expected.dev || opened.ino !== expected.ino
      || opened.size !== expected.size || opened.mtimeNs !== expected.mtimeNs || opened.ctimeNs !== expected.ctimeNs) fail("profile_source_changed");
    destinationHandle = fs.openSync(to, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    let copied = 0n;
    while (true) {
      const read = fs.readSync(sourceHandle, buffer, 0, buffer.length, null);
      if (read === 0) break;
      let written = 0;
      while (written < read) written += fs.writeSync(destinationHandle, buffer, written, read - written);
      copied += BigInt(read);
      if (copied > BigInt(MAX_IMPORT_BYTES) || copied > expected.size) fail("profile_source_changed");
    }
    if (copied !== expected.size) fail("profile_source_changed");
    fs.fsyncSync(destinationHandle);
  } finally {
    buffer.fill(0);
    if (destinationHandle !== undefined) fs.closeSync(destinationHandle);
    if (sourceHandle !== undefined) fs.closeSync(sourceHandle);
  }
}

function regularFileFact(root: string, relative: string): FileFact {
  const absolute = path.join(root, relative);
  assertWithin(root, absolute, "profile_source_invalid");
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(absolute, { bigint: true });
  } catch {
    fail("profile_source_unreadable");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) fail("profile_source_nonregular");
  let real: string;
  try {
    real = fs.realpathSync.native(absolute);
  } catch {
    fail("profile_source_unreadable");
  }
  if (path.resolve(real) !== path.resolve(absolute)) fail("profile_source_link_rejected");
  return { relative, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

function sameSnapshot(left: FileFact[], right: FileFact[]): boolean {
  return left.length === right.length && left.every((fact, index) => sameFact(fact, right[index]));
}

function sameFact(left: FileFact, right: FileFact | undefined): boolean {
  return right !== undefined && left.relative === right.relative && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function assertNoBrowserLocks(userDataRoot: string): void {
  for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"]) {
    if (pathEntryExists(path.join(userDataRoot, lock))) fail("profile_source_locked");
  }
  // Chromium profile subtrees contain persistent database files named LOCK.
  // Their presence is not evidence that the browser is running. Source closure
  // is proven independently from the process table, while the user-data-level
  // Singleton* artifacts above remain an additional fail-closed signal.
}

function createStage(store: ProfileStore, identity: string, source: "new" | "opaque_import", browserFamily: "chrome" | "edge", storeMarker: Marker) {
  let stage: string;
  try {
    stage = fs.mkdtempSync(path.join(store.root, `.staging-${identity}-`));
  } catch {
    fail("profile_identity_create_failed");
  }
  const marker = writeMarker(stage, {
    version: 1,
    type: "identity",
    nonce: nonce(),
    storeNonce: storeMarker.nonce,
    identity,
    kind: source === "new" ? "persistent" : "opaque_import",
    ...directoryIdentity(stage),
  });
  writeManifest(stage, Object.freeze({ version: 1, id: identity, browserFamily, createdAt: new Date().toISOString(), source }));
  return { path: stage, marker, published: false };
}

function publishStage(stage: string, destination: string): void {
  if (fs.existsSync(destination)) fail("profile_identity_exists");
  try {
    fs.renameSync(stage, destination);
  } catch {
    fail("profile_identity_publish_failed");
  }
}

function removeOwnedStage(stage: { path: string; marker: Marker }): void {
  if (!fs.existsSync(stage.path)) return;
  assertMarkerIdentity(stage.path, stage.marker, "profile_identity_cleanup_failed");
  const quarantine = path.join(path.dirname(stage.path), `.discarded-${nonce()}`);
  try {
    fs.renameSync(stage.path, quarantine);
  } catch {
    fail("profile_identity_cleanup_failed");
  }
  assertDirectChild(path.dirname(stage.path), quarantine, "profile_identity_cleanup_failed");
  assertMarkerIdentity(quarantine, stage.marker, "profile_identity_cleanup_failed");
  try {
    fs.rmSync(quarantine, { recursive: true });
  } catch {
    fail("profile_identity_cleanup_failed");
  }
}

function describeIdentity(store: ProfileStore, target: string, identity: string): NewtonProfileIdentity {
  assertDirectChild(store.root, target, "profile_identity_invalid");
  const marker = readMarker(target, IDENTITY_MARKER, "identity");
  if (marker.identity !== identity || marker.storeNonce !== requireStore(store).nonce) fail("profile_identity_invalid");
  assertMarkerIdentity(target, marker, "profile_identity_invalid");
  const manifest = readManifest(target);
  if ((manifest.source === "new" ? "persistent" : "opaque_import") !== marker.kind) fail("profile_identity_invalid");
  return Object.freeze({ ...manifest, path: target });
}

function withStoreLock<T>(store: ProfileStore, operation: () => T): T {
  const lock = path.join(store.root, STORE_LOCK);
  const value = nonce();
  let handle: number;
  try {
    handle = fs.openSync(lock, "wx", 0o600);
    try {
      fs.writeFileSync(handle, value);
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    fail("profile_store_busy");
  }
  try {
    return operation();
  } finally {
    try {
      const stat = fs.lstatSync(lock);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.readFileSync(lock, "utf8") !== value) fail("profile_store_lock_changed");
      fs.unlinkSync(lock);
    } catch (error) {
      if (error instanceof Error && error.message === "profile_store_lock_changed") throw error;
      fail("profile_store_lock_changed");
    }
  }
}

function requireStore(store: ProfileStore): Marker {
  const marker = stores.get(store);
  if (!marker) fail("profile_store_unrecognized");
  assertPlainDirectory(store.root, "profile_store_invalid");
  assertMarkerIdentity(store.root, marker, "profile_store_invalid");
  return marker;
}

function identityPath(store: ProfileStore, identity: string): string {
  const target = path.join(store.root, identity);
  assertDirectChild(store.root, target, "profile_identity_invalid");
  return target;
}

function newIdentityId(store: ProfileStore): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const id = `nbi_${randomBytes(16).toString("hex")}`;
    if (!pathEntryExists(identityPath(store, id))) return id;
  }
  fail("profile_identity_id_unavailable");
}

function writeManifest(directory: string, manifest: IdentityManifest): void {
  try {
    fs.writeFileSync(path.join(directory, IDENTITY_MANIFEST), `${JSON.stringify(manifest)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch {
    fail("profile_identity_manifest_failed");
  }
}

function readManifest(directory: string): IdentityManifest {
  const manifestPath = path.join(directory, IDENTITY_MANIFEST);
  let stat: fs.Stats;
  let value: unknown;
  try {
    stat = fs.lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("profile_identity_manifest_invalid");
    value = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    if (error instanceof Error && error.message === "profile_identity_manifest_invalid") throw error;
    fail("profile_identity_manifest_invalid");
  }
  if (!value || typeof value !== "object") fail("profile_identity_manifest_invalid");
  const manifest = value as Partial<IdentityManifest>;
  if (manifest.version !== 1 || typeof manifest.id !== "string" || !IDENTITY_PATTERN.test(manifest.id)
    || (manifest.browserFamily !== "chrome" && manifest.browserFamily !== "edge")
    || typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))
    || (manifest.source !== "new" && manifest.source !== "opaque_import")
    || Object.keys(manifest).sort().join(",") !== "browserFamily,createdAt,id,source,version") fail("profile_identity_manifest_invalid");
  if (manifest.id !== path.basename(directory)) fail("profile_identity_manifest_invalid");
  return Object.freeze(manifest as IdentityManifest);
}

function writeMarker(directory: string, input: Marker): Marker {
  const filename = input.type === "store" ? STORE_MARKER : IDENTITY_MARKER;
  const marker = { ...input, storeNonce: input.type === "store" ? input.nonce : input.storeNonce };
  try {
    fs.writeFileSync(path.join(directory, filename), `${JSON.stringify(marker)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch {
    fail("profile_owner_marker_failed");
  }
  return marker;
}

function readMarker(directory: string, filename: string, expectedType: Marker["type"]): Marker {
  const markerPath = path.join(directory, filename);
  let stat: fs.Stats;
  let value: unknown;
  try {
    stat = fs.lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("profile_owner_marker_invalid");
    value = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch (error) {
    if (error instanceof Error && error.message === "profile_owner_marker_invalid") throw error;
    fail("profile_owner_marker_invalid");
  }
  if (!value || typeof value !== "object") fail("profile_owner_marker_invalid");
  const marker = value as Partial<Marker>;
  if (marker.version !== 1 || marker.type !== expectedType || typeof marker.nonce !== "string" || !/^[a-f0-9]{64}$/.test(marker.nonce)
    || typeof marker.storeNonce !== "string" || typeof marker.dev !== "string" || typeof marker.ino !== "string") fail("profile_owner_marker_invalid");
  return marker as Marker;
}

function assertMarkerIdentity(directory: string, marker: Marker, code: string): void {
  assertPlainDirectory(directory, code);
  const identity = directoryIdentity(directory);
  if (identity.dev !== marker.dev || identity.ino !== marker.ino) fail(code);
}

function directoryIdentity(directory: string): { dev: string; ino: string } {
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(directory, { bigint: true });
  } catch {
    fail("profile_path_invalid");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.nlink < 1n) fail("profile_path_invalid");
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

function assertPlainDirectory(directory: string, code: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    fail(code);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code);
  let real: string;
  try {
    real = fs.realpathSync.native(directory);
  } catch {
    fail(code);
  }
  let parentReal: string;
  try {
    parentReal = fs.realpathSync.native(path.dirname(directory));
  } catch {
    fail(code);
  }
  const expected = path.join(parentReal, path.basename(path.resolve(directory)));
  if (path.relative(real, expected) !== "") fail(code);
}

function canonicalDirectory(directory: string, code: string): string {
  let stat: fs.Stats;
  let real: string;
  try {
    stat = fs.statSync(directory);
    real = fs.realpathSync.native(directory);
  } catch {
    fail(code);
  }
  if (!stat.isDirectory()) fail(code);
  return real;
}

function assertDirectChild(parent: string, child: string, code: string): void {
  let parentReal: string;
  try {
    parentReal = fs.realpathSync.native(parent);
  } catch {
    fail(code);
  }
  const resolved = path.resolve(child);
  if (path.dirname(resolved) !== parentReal || path.resolve(parentReal, path.basename(resolved)) !== resolved) fail(code);
}

function assertWithin(parent: string, child: string, code: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) fail(code);
}

function checkedAbsolute(value: string, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !path.isAbsolute(value)) fail(code);
  return path.resolve(value);
}

function checkedIdentity(value: string): string {
  if (typeof value !== "string" || !IDENTITY_PATTERN.test(value)) fail("profile_identity_invalid");
  return value;
}

function checkedBrowserFamily(value: "chrome" | "edge"): "chrome" | "edge" {
  if (value !== "chrome" && value !== "edge") fail("profile_browser_family_invalid");
  return value;
}

function checkedProfileDirectory(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value === "." || value === ".." || path.basename(value) !== value || value.includes("\0")) {
    fail("profile_source_invalid");
  }
  return value;
}

function closureProved(verifier: SourceClosureVerifier, userDataRoot: string, profileDirectory: string): boolean {
  try {
    return verifier(Object.freeze({ userDataRoot, profileDirectory })) === true;
  } catch {
    return false;
  }
}

function pathEntryExists(candidate: string, unreadableCode = "profile_source_unreadable"): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code !== "ENOENT" ? fail(unreadableCode) : false;
  }
}

function nonce(): string {
  return randomBytes(32).toString("hex");
}

function fail(code: string): never {
  throw new Error(code);
}
