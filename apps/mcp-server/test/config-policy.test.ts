import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { configDirectory, ensureConfigDirectory, loadDirectConfiguration, loadHostPolicies, profileStoreDirectory, resolveConfigDirectory, writeBrowserPreference } from "../src/config.ts";

function withConfig(t: test.TestContext, value: unknown): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "newton-policy-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "config.json"), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return directory;
}

test("host policy normalization retains only bounded exact direct-runtime fields", (t) => {
  const directory = withConfig(t, {
    hostPolicies: [{
      origins: ["https://example.com"],
      commitRules: [{ match: { role: "button" }, effect: "commit", reason: "save" }],
      sensitiveZones: [{ selector: "#private" }],
    }],
  });
  assert.deepEqual(loadHostPolicies({ directory }), [{
    origins: ["https://example.com"],
    commitRules: [{ match: { role: "button" }, effect: "commit", reason: "save" }],
    sensitiveZones: [{ selector: "#private" }],
  }]);
});

test("host policy rejects removed labels, route classes, and permissive defaults", (t) => {
  for (const retired of [
    { label: "example" },
    { routeClass: "app" },
    { defaultForUnmatched: "agentic" },
  ]) {
    const directory = withConfig(t, { hostPolicies: [{ origins: ["https://example.com"], ...retired }] });
    assert.throws(() => loadHostPolicies({ directory }), /unsupported field/u);
  }
});

test("host policy rejects ambiguous sensitive zones and non-origin grants", (t) => {
  const ambiguous = withConfig(t, { hostPolicies: [{ origins: ["https://example.com"], sensitiveZones: [{ selector: "#x", label: "x" }] }] });
  assert.throws(() => loadHostPolicies({ directory: ambiguous }), /invalid sensitive zone/u);
  const pathGrant = withConfig(t, { hostPolicies: [{ origins: ["https://example.com/path"] }] });
  assert.throws(() => loadHostPolicies({ directory: pathGrant }), /invalid origin/u);
  const overlap = withConfig(t, { hostPolicies: [
    { origins: ["https://example.com"] },
    { origins: ["https://other.example", "https://example.com"] },
  ] });
  assert.throws(() => loadHostPolicies({ directory: overlap }), /overlapping origin/u);
});

test("direct configuration returns one validated browser and policy snapshot", (t) => {
  const directory = withConfig(t, {
    browser: "edge",
    hostPolicies: [{ origins: ["https://example.com"] }],
  });
  const configuration = loadDirectConfiguration({ directory, env: {} });
  assert.equal(configuration.browser, "edge");
  assert.deepEqual(configuration.hostPolicies, [{ origins: ["https://example.com"] }]);
  assert.equal(Object.isFrozen(configuration), true);
  assert.equal(Object.isFrozen(configuration.hostPolicies), true);
});

test("browser setup refuses to preserve invalid policy state", (t) => {
  const directory = withConfig(t, {
    browser: "chrome",
    hostPolicies: [{ origins: ["https://example.com"], retiredCompatibilityField: true }],
  });
  assert.throws(() => writeBrowserPreference({ directory, browser: "edge" }), /unsupported field/u);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "config.json"), "utf8")).browser, "chrome");
});

test("host policy refuses linked config files", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "newton-policy-config-"));
  const outside = path.join(directory, "outside.json");
  const configDirectory = path.join(directory, "config");
  fs.mkdirSync(configDirectory);
  fs.writeFileSync(outside, '{"hostPolicies":[]}\n');
  fs.linkSync(outside, path.join(configDirectory, "config.json"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => loadHostPolicies({ directory: configDirectory }), /direct_config_invalid/u);
});

test("MCP and identity utilities resolve one authoritative profile store", () => {
  const configured = path.resolve("C:/newton-test-profile-store");
  assert.equal(profileStoreDirectory({ NEWTON_BROWSER_PROFILE_STORE_DIR: configured }, "C:/ignored-config"), configured);
  assert.equal(profileStoreDirectory({}, "C:/newton-config"), path.resolve("C:/newton-config/identities"));
  assert.throws(() => profileStoreDirectory({ NEWTON_BROWSER_PROFILE_STORE_DIR: "" }, "C:/newton-config"), /direct_config_invalid/u);
  assert.throws(() => profileStoreDirectory({ NEWTON_BROWSER_PROFILE_STORE_DIR: "bad\0path" }, "C:/newton-config"), /direct_config_invalid/u);
});

test("explicit config and profile roots are absolute, bounded, and never a filesystem root", () => {
  const absolute = path.resolve("newton-config-test");
  assert.equal(configDirectory({ NEWTON_BROWSER_CONFIG_DIR: absolute }), absolute);
  assert.equal(resolveConfigDirectory(absolute), absolute);
  for (const invalid of ["", "relative/config", path.parse(absolute).root, "bad\0path"]) {
    assert.throws(() => resolveConfigDirectory(invalid), /direct_config_invalid/u);
  }
  assert.throws(() => profileStoreDirectory({ NEWTON_BROWSER_PROFILE_STORE_DIR: "relative/store" }, absolute), /direct_config_invalid/u);
  assert.throws(() => profileStoreDirectory({ NEWTON_BROWSER_PROFILE_STORE_DIR: path.parse(absolute).root }, absolute), /direct_config_invalid/u);
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
