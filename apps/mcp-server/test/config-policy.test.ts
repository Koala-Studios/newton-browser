import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadHostPolicies } from "../src/config.ts";

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
      label: "example",
      routeClass: "app",
      defaultForUnmatched: "conservative",
      commitRules: [{ match: { role: "button" }, effect: "commit", reason: "save" }],
      sensitiveZones: [{ selector: "#private" }],
    }],
  });
  assert.deepEqual(loadHostPolicies({ directory }), [{
    origins: ["https://example.com"],
    label: "example",
    routeClass: "app",
    defaultForUnmatched: "conservative",
    commitRules: [{ match: { role: "button" }, effect: "commit", reason: "save" }],
    sensitiveZones: [{ selector: "#private" }],
  }]);
});

test("host policy rejects ambiguous sensitive zones and non-origin grants", (t) => {
  const ambiguous = withConfig(t, { hostPolicies: [{ origins: ["https://example.com"], sensitiveZones: [{ selector: "#x", label: "x" }] }] });
  assert.throws(() => loadHostPolicies({ directory: ambiguous }), /invalid sensitive zone/u);
  const pathGrant = withConfig(t, { hostPolicies: [{ origins: ["https://example.com/path"] }] });
  assert.throws(() => loadHostPolicies({ directory: pathGrant }), /invalid origin/u);
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
