import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDefaultDirectBrowserHost } from "../../src/browser-runtime/default-direct-host.ts";
import { createNewtonIdentity, openProfileStore } from "../../src/browser-runtime/profile-store.ts";
import { writeDirectBrowserConfig } from "../../src/config.ts";

function fixtureExecutable(root: string): string {
  const file = path.join(root, process.platform === "win32" ? "browser.exe" : "browser");
  fs.writeFileSync(file, "fixture", { mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o700);
  return file;
}

test("default host is always direct and uses the configured opaque identity", async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "newton-default-direct-"));
  try {
    const directory = path.join(root, "config");
    fs.mkdirSync(directory, { recursive: true });
    const store = openProfileStore(path.join(directory, "identities"));
    const identity = createNewtonIdentity(store, { browserFamily: "chrome" });
    writeDirectBrowserConfig({ directory, browserTarget: "chrome", identityId: identity.id });
    const host = createDefaultDirectBrowserHost({
      NEWTON_BROWSER_CONFIG_DIR: directory,
      NEWTON_BROWSER_BROWSER_EXECUTABLE: fixtureExecutable(root),
    });
    assert.equal(host.getStatus().mode, "direct");
    assert.equal(host.getStatus().configured, true);
    assert.equal("extensionConnected" in host.getStatus(), false);
    await host.close();
    assert.equal(fs.existsSync(path.join(store.root, identity.id)), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("default host requires an explicit family when a custom executable is supplied", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "newton-default-family-"));
  try {
    assert.throws(() => createDefaultDirectBrowserHost({
      NEWTON_BROWSER_CONFIG_DIR: path.join(root, "config"),
      NEWTON_BROWSER_BROWSER_EXECUTABLE: fixtureExecutable(root),
    }), /configured_browser_family_required/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
