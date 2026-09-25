import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  configDirectory,
  ensureConfigDirectory,
  loadBrowserPreference,
  profileStoreDirectory,
  resolveConfigDirectory,
  writeBrowserPreference,
} from "../src/config.ts";

function withConfig(t: test.TestContext, value: unknown): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "newton-policy-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "config.json"), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return directory;
}

test("the browser preference is one validated value, overridable by the environment", (t) => {
  assert.equal(loadBrowserPreference({ directory: withConfig(t, {}), env: {} }), "auto");
  const directory = withConfig(t, { browser: "edge" });
  assert.equal(loadBrowserPreference({ directory, env: {} }), "edge");
  assert.equal(loadBrowserPreference({ directory, env: { NEWTON_BROWSER_BROWSER: "chrome" } }), "chrome");
  assert.throws(() => loadBrowserPreference({ directory, env: { NEWTON_BROWSER_BROWSER: "safari" } }), /auto, chrome, or edge/u);
  assert.throws(() => loadBrowserPreference({ directory: withConfig(t, { browser: "firefox" }), env: {} }), /auto, chrome, or edge/u);
  assert.deepEqual(writeBrowserPreference({ directory, browser: "chrome" }), { browser: "chrome" });
  assert.equal(loadBrowserPreference({ directory, env: {} }), "chrome");
});

test("config refuses unknown fields and leaves the file unchanged", (t) => {
  const directory = withConfig(t, { browser: "chrome", identityBindings: [] });
  assert.throws(() => loadBrowserPreference({ directory, env: {} }), /config_invalid/u);
  assert.throws(() => writeBrowserPreference({ directory, browser: "edge" }), /config_invalid/u);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "config.json"), "utf8")).browser, "chrome");
});

test("config refuses linked config files", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "newton-policy-config-"));
  const outside = path.join(directory, "outside.json");
  const configDirectory = path.join(directory, "config");
  fs.mkdirSync(configDirectory);
  fs.writeFileSync(outside, '{"browser":"chrome"}\n');
  fs.linkSync(outside, path.join(configDirectory, "config.json"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => loadBrowserPreference({ directory: configDirectory, env: {} }), /config_invalid/u);
});

test("MCP and identity utilities resolve one authoritative profile store", () => {
  const configured = path.join(path.resolve(os.tmpdir()), "newton-test-profile-store");
  const config = path.join(path.resolve(os.tmpdir()), "newton-test-config");
  assert.equal(profileStoreDirectory({ NEWTON_BROWSER_PROFILE_STORE_DIR: configured }, path.join(config, "ignored")), configured);
  assert.equal(profileStoreDirectory({}, config), path.join(config, "identities"));
  assert.throws(() => profileStoreDirectory({ NEWTON_BROWSER_PROFILE_STORE_DIR: "" }, config), /config_invalid/u);
  assert.throws(() => profileStoreDirectory({ NEWTON_BROWSER_PROFILE_STORE_DIR: "bad\0path" }, config), /config_invalid/u);
});

test("explicit config and profile roots are absolute, bounded, and never a filesystem root", () => {
  const absolute = path.resolve("newton-config-test");
  assert.equal(configDirectory({ NEWTON_BROWSER_CONFIG_DIR: absolute }), absolute);
  assert.equal(resolveConfigDirectory(absolute), absolute);
  for (const invalid of ["", "relative/config", path.parse(absolute).root, "bad\0path"]) {
    assert.throws(() => resolveConfigDirectory(invalid), /config_invalid/u);
  }
  assert.throws(() => profileStoreDirectory({ NEWTON_BROWSER_PROFILE_STORE_DIR: "relative/store" }, absolute), /config_invalid/u);
  assert.throws(() => profileStoreDirectory({ NEWTON_BROWSER_PROFILE_STORE_DIR: path.parse(absolute).root }, absolute), /config_invalid/u);
});

test("platform defaults honor the supplied isolated home instead of the operator home", () => {
  const home = path.resolve("isolated-newton-home");
  const actual = configDirectory({ HOME: home, USERPROFILE: home });
  const expected = process.platform === "win32"
    ? path.join(home, "AppData", "Local", "NewtonBrowser")
    : process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "NewtonBrowser")
      : path.join(home, ".config", "newton-browser");
  assert.equal(actual, expected);
});

test("first-use configuration creates one strict owned directory", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "newton-config-first-use-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const directory = path.join(parent, "config");
  assert.equal(ensureConfigDirectory(directory), path.resolve(directory));
  assert.equal(fs.lstatSync(directory).isDirectory(), true);
  assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
});
