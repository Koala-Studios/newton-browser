import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireNewtonIdentityLease,
  createNewtonIdentity,
  importOpaqueProfile,
  inspectNewtonIdentityLease,
  listNewtonIdentities,
  openProfileStore,
  prepareOpaqueProfileSource,
  recoverStaleNewtonIdentityLease,
  releaseNewtonIdentityLease,
  removeNewtonIdentity,
  validateNewtonIdentityLease,
} from "../../src/browser-runtime/profile-store.ts";

test("persistent Newton identities use host-generated opaque IDs and are removable", () => {
  const fixture = createFixture();
  try {
    const store = openProfileStore(fixture.storeRoot);
    const first = createNewtonIdentity(store, { browserFamily: "chrome" });
    const second = createNewtonIdentity(store, { browserFamily: "edge" });
    assert.match(first.id, /^nbi_[a-f0-9]{32}$/);
    assert.notEqual(second.id, first.id);
    assert.equal(first.source, "new");
    assert.equal(first.browserFamily, "chrome");
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(first.path, ".newton-browser-profile.json"), "utf8"))).sort(), [
      "browserFamily", "createdAt", "id", "source", "version",
    ]);
    assert.deepEqual(listNewtonIdentities(store), [first, second].sort((left, right) => left.id.localeCompare(right.id)));
    assert.equal(fs.existsSync(path.join(first.path, ".newton-browser-profile-identity")), true);
    removeNewtonIdentity(store, first.id);
    assert.equal(fs.existsSync(first.path), false);
  } finally {
    fixture.cleanup();
  }
});

test("opaque import copies only the fixed auth allowlist and never returns contents", () => {
  const fixture = createFixture();
  try {
    const secret = "opaque-cookie-secret";
    populateSource(fixture, secret);
    const store = openProfileStore(fixture.storeRoot);
    let closureChecks = 0;
    const source = prepareOpaqueProfileSource({
      browserFamily: "edge",
      userDataRoot: fixture.userDataRoot,
      profileDirectory: fixture.sourceProfileDirectory,
      verifyClosed: () => { closureChecks += 1; return true; },
    });
    const receipt = importOpaqueProfile(store, { source });
    assert.equal(receipt.source, "opaque_import");
    assert.equal(receipt.browserFamily, "edge");
    assert.match(receipt.id, /^nbi_[a-f0-9]{32}$/);
    assert.equal(closureChecks, 3);
    assert.equal(fs.readFileSync(path.join(receipt.path, "Default", "Network", "Cookies"), "utf8"), secret);
    assert.equal(fs.readFileSync(path.join(receipt.path, "Default", "Local Storage", "leveldb", "CURRENT"), "utf8"), "local-state");
    assert.equal(fs.existsSync(path.join(receipt.path, "Default", "History")), false);
    assert.equal(fs.existsSync(path.join(receipt.path, "Default", "Login Data")), false);
    assert.equal(fs.existsSync(path.join(receipt.path, "Default", "Web Data")), false);
    assert.equal(fs.existsSync(path.join(receipt.path, "Default", "Extensions")), false);
    assert.equal(fs.existsSync(path.join(receipt.path, "Default", "Sessions")), false);
    assert.equal(fs.existsSync(path.join(receipt.path, "Default", "Session Storage")), false);
    assert.equal(fs.existsSync(path.join(receipt.path, "Default", "Service Worker")), false);
    assert.equal(fs.existsSync(path.join(receipt.path, fixture.sourceProfileDirectory)), false);
    assert.equal(JSON.stringify(receipt).includes(secret), false);
    assert.equal(JSON.stringify(receipt).includes(fixture.sourceProfileDirectory), false);
    assert.equal(receipt.path.includes(fixture.sourceProfileDirectory), false);
    assert.equal(fs.readFileSync(path.join(fixture.profileRoot, "Network", "Cookies"), "utf8"), secret);
    assert.throws(() => importOpaqueProfile(store, { source }), /profile_source_unrecognized/);
  } finally {
    fixture.cleanup();
  }
});

test("opaque import requires a closure proof and rejects browser lock indicators", () => {
  const fixture = createFixture();
  try {
    populateSource(fixture, "secret");
    assert.throws(() => prepareOpaqueProfileSource({
      browserFamily: "chrome",
      userDataRoot: fixture.userDataRoot,
      profileDirectory: fixture.sourceProfileDirectory,
      verifyClosed: () => false,
    }), /profile_source_closure_unproved/);
    assert.throws(() => prepareOpaqueProfileSource({
      browserFamily: "chrome",
      userDataRoot: fixture.userDataRoot,
      profileDirectory: fixture.sourceProfileDirectory,
      verifyClosed: () => { throw new Error("hostile source detail"); },
    }), (error: unknown) => error instanceof Error && error.message === "profile_source_closure_unproved");
    fs.writeFileSync(path.join(fixture.userDataRoot, "SingletonLock"), "locked");
    assert.throws(() => prepareOpaqueProfileSource({
      browserFamily: "chrome",
      userDataRoot: fixture.userDataRoot,
      profileDirectory: fixture.sourceProfileDirectory,
      verifyClosed: () => true,
    }), /profile_source_locked/);
  } finally {
    fixture.cleanup();
  }
});

test("closed Chromium profiles may retain database LOCK files", () => {
  const fixture = createFixture();
  try {
    populateSource(fixture, "secret");
    fs.writeFileSync(path.join(fixture.profileRoot, "LOCK"), "");
    const store = openProfileStore(fixture.storeRoot);
    const source = prepareOpaqueProfileSource({
      browserFamily: "chrome",
      userDataRoot: fixture.userDataRoot,
      profileDirectory: fixture.sourceProfileDirectory,
      verifyClosed: () => true,
    });
    const receipt = importOpaqueProfile(store, { source });
    assert.equal(receipt.source, "opaque_import");
    assert.equal(receipt.browserFamily, "chrome");
  } finally {
    fixture.cleanup();
  }
});

test("source mutation during staged copy fails closed without publication", () => {
  const fixture = createFixture();
  try {
    populateSource(fixture, "before");
    const store = openProfileStore(fixture.storeRoot);
    let checks = 0;
    const source = prepareOpaqueProfileSource({
      browserFamily: "chrome",
      userDataRoot: fixture.userDataRoot,
      profileDirectory: fixture.sourceProfileDirectory,
      verifyClosed: () => {
        checks += 1;
        if (checks === 3) fs.appendFileSync(path.join(fixture.profileRoot, "Network", "Cookies"), "changed");
        return true;
      },
    });
    assert.throws(() => importOpaqueProfile(store, { source }), /profile_source_changed/);
    assert.deepEqual(listNewtonIdentities(store), []);
    assert.deepEqual(fs.readdirSync(fixture.storeRoot).filter((name) => name.startsWith(".staging-")), []);
  } finally {
    fixture.cleanup();
  }
});

test("links, hard links, path escape, and nonregular allowed entries are rejected", (context) => {
  const fixture = createFixture();
  try {
    populateSource(fixture, "secret");
    assert.throws(() => prepareOpaqueProfileSource({
      browserFamily: "chrome",
      userDataRoot: fixture.userDataRoot,
      profileDirectory: "../Default",
      verifyClosed: () => true,
    }), /profile_source_invalid/);

    const outside = path.join(fixture.root, "outside-secret");
    fs.writeFileSync(outside, "outside");
    const link = path.join(fixture.profileRoot, "IndexedDB", "escape");
    try {
      fs.symlinkSync(outside, link, "file");
      assert.throws(() => prepareOpaqueProfileSource({
        browserFamily: "chrome",
        userDataRoot: fixture.userDataRoot,
        profileDirectory: fixture.sourceProfileDirectory,
        verifyClosed: () => true,
      }), /profile_source_link_rejected/);
      fs.unlinkSync(link);
    } catch (error) {
      if (error instanceof Error && "code" in error && ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))) context.diagnostic(`symlink unavailable: ${String(error.code)}`);
      else throw error;
    }

    const cookie = path.join(fixture.profileRoot, "Network", "Cookies");
    const hardLink = path.join(fixture.profileRoot, "Network", "Cookies-journal");
    fs.linkSync(cookie, hardLink);
    assert.throws(() => prepareOpaqueProfileSource({
      browserFamily: "chrome",
      userDataRoot: fixture.userDataRoot,
      profileDirectory: fixture.sourceProfileDirectory,
      verifyClosed: () => true,
    }), /profile_source_nonregular/);
  } finally {
    fixture.cleanup();
  }
});

test("identity cleanup refuses path replacement and preserves outside data", (context) => {
  const fixture = createFixture();
  try {
    const store = openProfileStore(fixture.storeRoot);
    const identity = createNewtonIdentity(store, { browserFamily: "chrome" });
    const outside = path.join(fixture.root, "outside");
    const sentinel = path.join(outside, "sentinel");
    fs.mkdirSync(outside);
    fs.writeFileSync(sentinel, "preserve");
    fs.rmSync(identity.path, { recursive: true });
    try {
      fs.symlinkSync(outside, identity.path, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))) {
        context.skip(`link creation unavailable: ${String(error.code)}`);
        return;
      }
      throw error;
    }
    assert.throws(() => removeNewtonIdentity(store, identity.id), /profile_owner_marker_invalid|profile_identity_invalid/);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve");
  } finally {
    fixture.cleanup();
  }
});

test("identity lease is exclusive, exact, opaque, releasable, and does not affect listing", () => {
  const fixture = createFixture();
  try {
    const store = openProfileStore(fixture.storeRoot);
    const identity = createNewtonIdentity(store, { browserFamily: "chrome" });
    const other = createNewtonIdentity(store, { browserFamily: "edge" });
    const before = listNewtonIdentities(store);
    const lease = acquireNewtonIdentityLease(store, identity.id);
    assert.equal(Object.isFrozen(lease), true);
    assert.deepEqual(lease, { id: identity.id, path: identity.path, browserFamily: "chrome" });
    assert.equal("nonce" in lease, false);
    assert.equal(inspectNewtonIdentityLease(store, identity.id), "active_or_stale");
    assert.equal(validateNewtonIdentityLease(lease, identity.path), true);
    assert.equal(validateNewtonIdentityLease(lease, `${identity.path}${path.sep}.`), false);
    assert.equal(validateNewtonIdentityLease(lease, other.path), false);
    assert.equal(validateNewtonIdentityLease({ ...lease }, identity.path), false);
    assert.throws(() => acquireNewtonIdentityLease(store, identity.id), /profile_identity_busy/);
    assert.throws(() => removeNewtonIdentity(store, identity.id), /profile_identity_busy/);
    assert.deepEqual(listNewtonIdentities(store), before);
    const leasePath = path.join(identity.path, ".newton-browser-profile-lease");
    if (process.platform !== "win32") assert.equal(fs.statSync(leasePath).mode & 0o777, 0o600);

    releaseNewtonIdentityLease(lease);
    releaseNewtonIdentityLease(lease);
    assert.equal(validateNewtonIdentityLease(lease, identity.path), false);
    assert.equal(inspectNewtonIdentityLease(store, identity.id), "available");
    const replacement = acquireNewtonIdentityLease(store, identity.id);
    assert.equal(validateNewtonIdentityLease(replacement, identity.path), true);
    releaseNewtonIdentityLease(replacement);
  } finally {
    fixture.cleanup();
  }
});

test("lease replacement is refused without touching outside data or clearing busy state", () => {
  const fixture = createFixture();
  try {
    const store = openProfileStore(fixture.storeRoot);
    const identity = createNewtonIdentity(store, { browserFamily: "chrome" });
    const lease = acquireNewtonIdentityLease(store, identity.id);
    const leasePath = path.join(identity.path, ".newton-browser-profile-lease");
    const outside = path.join(fixture.root, "lease-outside-sentinel");
    fs.writeFileSync(outside, "preserve");
    fs.unlinkSync(leasePath);
    fs.linkSync(outside, leasePath);
    assert.equal(validateNewtonIdentityLease(lease, identity.path), false);
    assert.throws(() => releaseNewtonIdentityLease(lease), /profile_identity_lease_invalid/);
    assert.equal(fs.readFileSync(outside, "utf8"), "preserve");
    assert.equal(inspectNewtonIdentityLease(store, identity.id), "active_or_stale");
    assert.throws(() => acquireNewtonIdentityLease(store, identity.id), /profile_identity_busy/);
    assert.throws(() => removeNewtonIdentity(store, identity.id), /profile_identity_busy/);
  } finally {
    fixture.cleanup();
  }
});

test("stale lease recovery is explicit, exact, and refuses a live owner", () => {
  const fixture = createFixture();
  try {
    const store = openProfileStore(fixture.storeRoot);
    const identity = createNewtonIdentity(store, { browserFamily: "chrome" });
    const active = acquireNewtonIdentityLease(store, identity.id);
    assert.throws(() => recoverStaleNewtonIdentityLease(store, identity.id, () => true), /profile_identity_lease_active/);
    releaseNewtonIdentityLease(active);

    const leasePath = path.join(identity.path, ".newton-browser-profile-lease");
    fs.writeFileSync(leasePath, `${JSON.stringify({
      version: 1,
      type: "identity_lease",
      id: identity.id,
      browserFamily: identity.browserFamily,
      nonce: "a".repeat(64),
      pid: absentProcessId(),
      createdAt: new Date().toISOString(),
    })}\n`, { flag: "wx", mode: 0o600 });
    assert.throws(
      () => recoverStaleNewtonIdentityLease(store, identity.id, () => false),
      /profile_identity_lease_closure_unproved/,
    );
    assert.equal(inspectNewtonIdentityLease(store, identity.id), "active_or_stale");
    assert.equal(recoverStaleNewtonIdentityLease(store, identity.id, () => true), "recovered");
    assert.equal(inspectNewtonIdentityLease(store, identity.id), "available");
    assert.equal(recoverStaleNewtonIdentityLease(store, identity.id, () => true), "available");
  } finally {
    fixture.cleanup();
  }
});

function createFixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "newton-browser-profile-store-test-"));
  const userDataRoot = path.join(root, "source-user-data");
  const sourceProfileDirectory = "Source Person 7";
  const profileRoot = path.join(userDataRoot, sourceProfileDirectory);
  const storeRoot = path.join(root, "store");
  fs.mkdirSync(profileRoot, { recursive: true });
  return {
    root,
    userDataRoot,
    sourceProfileDirectory,
    profileRoot,
    storeRoot,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function populateSource(fixture: ReturnType<typeof createFixture>, secret: string): void {
  fs.writeFileSync(path.join(fixture.userDataRoot, "Local State"), "opaque-local-state");
  write(fixture.profileRoot, "Network/Cookies", secret);
  write(fixture.profileRoot, "Local Storage/leveldb/CURRENT", "local-state");
  write(fixture.profileRoot, "IndexedDB/app.leveldb/data", "indexed-db");
  write(fixture.profileRoot, "Session Storage/CURRENT", "session-state");
  for (const excluded of ["History", "Login Data", "Web Data", "Extensions/manifest", "Sessions/Tabs", "Service Worker/Database", "Cache/data", "Downloads/item"]) {
    write(fixture.profileRoot, excluded, `excluded-${excluded}`);
  }
}

function write(root: string, relative: string, value: string): void {
  const target = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

function absentProcessId(): number {
  const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (!Number.isSafeInteger(exited.pid) || Number(exited.pid) <= 0 || exited.status !== 0) {
    throw new Error("absent_process_fixture_failed");
  }
  try { process.kill(Number(exited.pid), 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return Number(exited.pid);
  }
  throw new Error("exited_process_id_was_reused");
}
