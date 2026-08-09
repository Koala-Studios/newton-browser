import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createNewtonBrowserHost } from "../src/bridge.ts";
import { collectDoctorReport } from "../src/cli.ts";

const SECRET = "d".repeat(43);

test("doctor reports runtime, config, loopback, protocol, extension state, and next action", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-doctor-test-"));
  fs.writeFileSync(path.join(directory, "pairing.json"), `${JSON.stringify({ version: 1, secret: SECRET })}\n`);
  fs.writeFileSync(path.join(directory, "config.json"), `${JSON.stringify({ transportAuth: "paired", browserTarget: "edge", hostPolicies: [{ label: "example", origins: ["https://example.com"] }] })}\n`);
  const host = createNewtonBrowserHost({ pairingSecret: SECRET });
  const address = await host.listen(0);
  try {
    const report = await collectDoctorReport({ directory, firstPort: address.port, lastPort: address.port });
    assert.equal(report.ok, true);
    assert.equal(report.ready, false);
    assert.equal(report.authMode, "paired");
    assert.equal(report.pairingSecret, SECRET);
    assert.deepEqual(report.checks.node, { ok: true, version: process.version, required: ">=20.0.0" });
    assert.equal(report.checks.config.ok, true);
    assert.equal(report.checks.config.hostPolicyCount > 0, true);
    assert.deepEqual(report.checks.transportAuth, { ok: true, mode: "paired", pairingRequired: true });
    assert.deepEqual(report.checks.browserSelection, { ok: true, target: "edge" });
    assert.equal(report.checks.loopback.availablePort, null);
    assert.equal(report.checks.loopback.incumbents.length, 1);
    assert.equal(report.checks.extension.state, "disconnected");
    assert.equal(report.checks.protocol.supported.includes("2025-06-18"), true);
    assert.deepEqual(report.checks.framing, {
      ok: true,
      headerBytes: 16 * 1024,
      bodyBytes: 4 * 1024 * 1024,
      bufferBytes: 4 * 1024 * 1024 + 16 * 1024,
      bufferedBytes: 0,
    });
    assert.equal(report.nextAction, "load_or_pair_extension");
  } finally {
    await host.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("doctor identifies a free bounded port when no host is running", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-doctor-free-"));
  try {
    const probe = createNewtonBrowserHost({ pairingSecret: SECRET });
    const address = await probe.listen(0);
    await probe.close();
    const report = await collectDoctorReport({ directory, firstPort: address.port, lastPort: address.port });
    assert.equal(report.ok, true);
    assert.equal(report.ready, false);
    assert.equal(report.authMode, "local_trust");
    assert.equal(report.pairingState, "not_required");
    assert.equal("pairingSecret" in report, false);
    assert.deepEqual(report.checks.transportAuth, { ok: true, mode: "local_trust", pairingRequired: false });
    assert.deepEqual(report.checks.browserSelection, { ok: true, target: "auto" });
    assert.equal(report.checks.loopback.availablePort, address.port);
    assert.equal(report.checks.extension.state, "no_running_host");
    assert.equal(report.nextAction, "start_or_restart_mcp_client_then_check_browser_status");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
