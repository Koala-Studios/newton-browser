import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ENTRYPOINT = path.join(process.cwd(), "apps", "mcp-server", "src", "index.ts");

test("identity binding CLI persists exact-origin selection and fences bound deletion", (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "newton-identity-binding-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    NEWTON_BROWSER_CONFIG_DIR: path.join(root, "config"),
    NEWTON_BROWSER_PROFILE_STORE_DIR: path.join(root, "identities"),
  };

  const created = run(["identity", "create", "--browser", "chrome"], env);
  assert.equal(created.status, 0, created.stderr);
  const identity = JSON.parse(created.stdout) as { id: string };
  assert.match(identity.id, /^nbi_[a-f0-9]{32}$/u);

  const missingBindingLogin = run(["identity", "login", "--origin", "https://accounts.example.com"], env);
  assert.equal(missingBindingLogin.status, 1);
  assert.equal(missingBindingLogin.stderr.trim(), "identity_login_binding_missing");

  const bound = run(["identity", "bind", "--id", identity.id, "--origin", "https://accounts.example.com"], env);
  assert.equal(bound.status, 0, bound.stderr);
  assert.deepEqual(JSON.parse(bound.stdout), {
    origin: "https://accounts.example.com",
    identityId: identity.id,
  });

  const listed = run(["identity", "bindings"], env);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), [{
    origin: "https://accounts.example.com",
    identityId: identity.id,
  }]);

  const resolvedBindingLogin = run(["identity", "login", "--origin", "https://accounts.example.com"], {
    ...env,
    NEWTON_BROWSER_BROWSER_EXECUTABLE: path.join(root, "missing-browser.exe"),
  });
  assert.equal(resolvedBindingLogin.status, 1);
  assert.equal(resolvedBindingLogin.stderr.trim(), "identity_login_browser_unavailable");

  const refusedDelete = run(["identity", "delete", "--id", identity.id], env);
  assert.equal(refusedDelete.status, 1);
  assert.equal(refusedDelete.stderr.trim(), "identity_delete_binding_active");

  const unbound = run(["identity", "unbind", "--origin", "https://accounts.example.com"], env);
  assert.equal(unbound.status, 0, unbound.stderr);
  assert.deepEqual(JSON.parse(unbound.stdout), {
    origin: "https://accounts.example.com",
    removed: true,
  });

  const deleted = run(["identity", "delete", "--id", identity.id], env);
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.deepEqual(JSON.parse(deleted.stdout), { id: identity.id });
});

test("identity binding CLI refuses missing identities and non-origin values", (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "newton-identity-binding-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    NEWTON_BROWSER_CONFIG_DIR: path.join(root, "config"),
    NEWTON_BROWSER_PROFILE_STORE_DIR: path.join(root, "identities"),
  };
  const missing = run([
    "identity", "bind",
    "--id", "nbi_0123456789abcdef0123456789abcdef",
    "--origin", "https://example.com",
  ], env);
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr.trim(), "identity_binding_identity_missing");

  const created = run(["identity", "create", "--browser", "chrome"], env);
  const identity = JSON.parse(created.stdout) as { id: string };
  const invalid = run([
    "identity", "bind",
    "--id", identity.id,
    "--origin", "https://example.com/path",
  ], env);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stderr.trim(), "identity_binding_failed");
  assert.deepEqual(JSON.parse(run(["identity", "bindings"], env).stdout), []);
});

function run(args: readonly string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--experimental-strip-types", ENTRYPOINT, ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
}
