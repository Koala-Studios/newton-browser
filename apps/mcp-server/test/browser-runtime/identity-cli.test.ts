import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { dispatchIdentityCommand } from "../../src/browser-runtime/identity-cli.ts";
import {
  acquireNewtonIdentityLease,
  openProfileStore,
  releaseNewtonIdentityLease,
} from "../../src/browser-runtime/profile-store.ts";

test("identity create and list expose only bounded opaque metadata", () => {
  const fixture = identityFixture();
  try {
    const chrome = dispatchIdentityCommand({ store: fixture.store }, ["create", "--browser", "chrome"]);
    const edge = dispatchIdentityCommand({ store: fixture.store }, ["create", "--browser", "edge"]);
    assertSafeOutput(chrome, fixture.secrets);
    assertSafeOutput(edge, fixture.secrets);
    assert.deepEqual(Object.keys(chrome).sort(), ["browserFamily", "createdAt", "id", "source"]);
    const listed = dispatchIdentityCommand({ store: fixture.store }, ["list"]);
    assertSafeOutput(listed, fixture.secrets);
    assert.equal(Array.isArray(listed), true);
    assert.equal((listed as readonly unknown[]).length, 2);
  } finally {
    fixture.cleanup();
  }
});

test("opaque import requires injected closure evidence and never exposes hostile source paths or profile names", () => {
  const fixture = identityFixture();
  try {
    populateOpaqueSource(fixture, "AUTH_CONTENT_MUST_NOT_ESCAPE");
    const argv = [
      "import",
      "--browser", "chrome",
      "--user-data-root", fixture.userDataRoot,
      "--profile-directory", fixture.profileDirectory,
    ];
    assert.throws(
      () => dispatchIdentityCommand({ store: fixture.store }, argv),
      boundedCode("identity_cli_closure_verifier_required", fixture.secrets),
    );

    const receipt = dispatchIdentityCommand({
      store: fixture.store,
      sourceClosureVerifier(source) {
        assert.deepEqual(source, {
          userDataRoot: fixture.userDataRoot,
          profileDirectory: fixture.profileDirectory,
        });
        return true;
      },
    }, argv);
    assertSafeOutput(receipt, [...fixture.secrets, "AUTH_CONTENT_MUST_NOT_ESCAPE", "Cookies", "Local State"]);
    assert.deepEqual(Object.keys(receipt).sort(), ["browserFamily", "createdAt", "id", "source"]);
    assert.equal("source" in receipt && receipt.source, "opaque_import");
  } finally {
    fixture.cleanup();
  }
});

test("import closure failure is bounded before and after hostile verifier exceptions", () => {
  const fixture = identityFixture();
  try {
    populateOpaqueSource(fixture, "secret");
    const argv = [
      "import",
      "--browser", "edge",
      "--user-data-root", fixture.userDataRoot,
      "--profile-directory", fixture.profileDirectory,
    ];
    assert.throws(
      () => dispatchIdentityCommand({ store: fixture.store, sourceClosureVerifier: () => false }, argv),
      boundedCode("profile_source_closure_unproved", fixture.secrets),
    );
    assert.throws(
      () => dispatchIdentityCommand({
        store: fixture.store,
        sourceClosureVerifier: () => { throw new Error(`hostile ${fixture.userDataRoot}`); },
      }, argv),
      boundedCode("profile_source_closure_unproved", fixture.secrets),
    );
  } finally {
    fixture.cleanup();
  }
});

test("identity commands reject unknown, duplicate, missing, and extra arguments exactly", () => {
  const fixture = identityFixture();
  try {
    for (const argv of [
      ["unknown"],
      ["list", "extra"],
      ["create"],
      ["create", "--browser", "chrome", "--browser", "edge"],
      ["create", "--family", "chrome"],
      ["create", "--browser", "firefox"],
      ["delete", "--id"],
      ["lease-inspect", "--id", "not-an-identity"],
      ["lease-recover", "--id", "not-an-identity"],
    ]) {
      assert.throws(
        () => dispatchIdentityCommand({ store: fixture.store }, argv),
        (error: unknown) => error instanceof Error
          && ["identity_cli_unknown_command", "identity_cli_invalid_arguments"].includes(error.message)
          && !fixture.secrets.some((secret) => error.message.includes(secret)),
        argv.join(" "),
      );
    }
  } finally {
    fixture.cleanup();
  }
});

test("lease inspection is closed and delete refuses active_or_stale until exact release", () => {
  const fixture = identityFixture();
  try {
    const created = dispatchIdentityCommand({ store: fixture.store }, ["create", "--browser", "chrome"]);
    assert.equal(Array.isArray(created), false);
    assert.equal("id" in created, true);
    const id = "id" in created ? created.id : "";
    assert.deepEqual(dispatchIdentityCommand({ store: fixture.store }, ["lease-inspect", "--id", id]), {
      id,
      lease: "available",
    });
    const lease = acquireNewtonIdentityLease(fixture.store, id);
    const inspection = dispatchIdentityCommand({ store: fixture.store }, ["lease-inspect", "--id", id]);
    assert.deepEqual(inspection, { id, lease: "active_or_stale" });
    assertSafeOutput(inspection, fixture.secrets);
    assert.throws(
      () => dispatchIdentityCommand({
        store: fixture.store,
        leaseRecoveryVerifier: () => () => true,
      }, ["lease-recover", "--id", id]),
      boundedCode("profile_identity_lease_active", fixture.secrets),
    );
    assert.throws(
      () => dispatchIdentityCommand({ store: fixture.store }, ["delete", "--id", id]),
      boundedCode("identity_delete_lease_active_or_stale", fixture.secrets),
    );
    releaseNewtonIdentityLease(lease);
    assert.deepEqual(dispatchIdentityCommand({ store: fixture.store }, ["delete", "--id", id]), { id });
    assert.deepEqual(dispatchIdentityCommand({ store: fixture.store }, ["list"]), []);
  } finally {
    fixture.cleanup();
  }
});

function identityFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-identity-cli-TOP_SECRET_ROOT-"));
  const storeRoot = path.join(root, "identity-store");
  const userDataRoot = path.join(root, "HOSTILE_ACCOUNT_SOURCE_PATH");
  const profileDirectory = "Profile HOSTILE_ACCOUNT_NAME";
  fs.mkdirSync(userDataRoot);
  const store = openProfileStore(storeRoot);
  const secrets = [root, userDataRoot, profileDirectory, "TOP_SECRET_ROOT", "HOSTILE_ACCOUNT"];
  return {
    root,
    store,
    userDataRoot,
    profileDirectory,
    secrets,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function populateOpaqueSource(fixture: ReturnType<typeof identityFixture>, content: string): void {
  fs.writeFileSync(path.join(fixture.userDataRoot, "Local State"), content);
  const network = path.join(fixture.userDataRoot, fixture.profileDirectory, "Network");
  fs.mkdirSync(network, { recursive: true });
  fs.writeFileSync(path.join(network, "Cookies"), content);
}

function assertSafeOutput(output: unknown, secrets: readonly string[]): void {
  const serialized = JSON.stringify(output);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false, secret);
  const allowedKeys = new Set(["id", "browserFamily", "createdAt", "source", "lease", "recovery"]);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(allowedKeys.has(key), true, key);
      visit(child);
    }
  };
  visit(output);
}

function boundedCode(code: string, secrets: readonly string[]) {
  return (error: unknown): boolean => {
    assert.equal(error instanceof Error, true);
    const message = error instanceof Error ? error.message : String(error);
    assert.equal(message, code);
    for (const secret of secrets) assert.equal(message.includes(secret), false);
    return true;
  };
}
