import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runDirectIdentityLogin,
  runDirectLiveDoctor,
  setupDirectBrowser,
} from "../../src/browser-runtime/direct-setup-cli.ts";
import { createNewtonIdentity, listNewtonIdentities, openProfileStore } from "../../src/browser-runtime/profile-store.ts";
import { loadBrowserTarget, loadDirectBrowserConfig } from "../../src/config.ts";

test("setup persists only browser family, an opaque identity, and current host policies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-direct-config-"));
  try {
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transportAuth: "local_trust" }));
    const first = setupDirectBrowser({
      browserFamily: "chrome",
      directory: root,
      env: {},
      discoverBrowser: () => ({ family: "chrome", path: "ignored", source: "system" }),
    });
    assert.equal(first.identityCreated, true);
    assert.match(first.identityId, /^nbi_[a-f0-9]{32}$/u);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")), {
      browserTarget: "chrome",
      identityId: first.identityId,
    });
    assert.deepEqual(loadDirectBrowserConfig({ directory: root, env: {} }), {
      browserTarget: "chrome",
      identityId: first.identityId,
    });

    const second = setupDirectBrowser({
      browserFamily: "chrome",
      directory: root,
      env: {},
      discoverBrowser: () => ({ family: "chrome", path: "ignored", source: "system" }),
    });
    assert.equal(second.identityCreated, false);
    assert.equal(second.identityId, first.identityId);
    assert.equal(listNewtonIdentities(openProfileStore(path.join(root, "identities"))).length, 1);
    assert.throws(() => setupDirectBrowser({
      browserFamily: "edge",
      directory: root,
      env: {},
      discoverBrowser: () => ({ family: "edge", path: "ignored", source: "system" }),
    }), /direct_setup_conflict/u);

    fs.rmSync(path.join(root, "identities", first.identityId), { recursive: true });
    const repaired = setupDirectBrowser({
      browserFamily: "chrome",
      directory: root,
      env: {},
      discoverBrowser: () => ({ family: "chrome", path: "ignored", source: "system" }),
    });
    assert.equal(repaired.identityCreated, true);
    assert.notEqual(repaired.identityId, first.identityId);
    assert.equal(loadDirectBrowserConfig({ directory: root, env: {} })?.identityId, repaired.identityId);

    const selected = createNewtonIdentity(openProfileStore(path.join(root, "identities")), { browserFamily: "chrome" });
    const selectedReceipt = setupDirectBrowser({
      browserFamily: "chrome",
      identityId: selected.id,
      directory: root,
      env: {},
      discoverBrowser: () => ({ family: "chrome", path: "ignored", source: "system" }),
    });
    assert.equal(selectedReceipt.identityCreated, false);
    assert.equal(selectedReceipt.identityId, selected.id);
    assert.equal(loadDirectBrowserConfig({ directory: root, env: {} })?.identityId, selected.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("contained identity login publishes readiness before event-driven cleanup and leaks no path", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-direct-login-private-"));
  const privateExecutable = path.join(root, "PRIVATE_BROWSER.exe");
  try {
    const setup = setupDirectBrowser({
      browserFamily: "edge",
      directory: root,
      env: {},
      discoverBrowser: () => ({ family: "edge", path: privateExecutable, source: "explicit" }),
    });
    const order: string[] = [];
    const launchInputs: unknown[] = [];
    const readyReceipts: unknown[] = [];
    const result = await runDirectIdentityLogin({
      identityId: setup.identityId,
      origin: "https://example.com",
      allowedOrigins: ["https://assets.example.com"],
      directory: root,
      env: {},
      discoverBrowser: () => ({ family: "edge", path: privateExecutable, source: "explicit" }),
      async launchRuntime(options) {
        launchInputs.push(options);
        return {
          receipt: { status: "ready", identityId: setup.identityId, browserFamily: "edge", pid: 991 },
          unavailable: Promise.resolve(),
          claimDriverBootstrap(origins) {
            order.push(`claim:${origins.length}`);
            return { transport: { async send() { return {}; }, onEvent() { return () => {}; } }, rootTargetId: "root", syntheticTabId: 7 };
          },
          cleanupState: () => "ready",
          async close() { order.push("runtime_close"); },
        };
      },
      async startDriverSession(options) {
        order.push(`session_start:${options.allowedOrigins.length}`);
        return {
          initialObservation: undefined,
          async execute() { return { status: "verified" }; },
          async stop() { order.push("session_stop"); },
          snapshot() { return { state: "active", runningCommands: 0, queuedCommands: 0, runningBytes: 0, queuedBytes: 0, queueClosed: false }; },
        };
      },
      onReady(receipt) { order.push("ready"); readyReceipts.push(receipt); },
    });
    assert.deepEqual(order, ["claim:2", "session_start:1", "ready", "session_stop", "runtime_close"]);
    assert.equal(result.status, "closed");
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(readyReceipts.length, 1);
    const serialized = JSON.stringify({ result, readyReceipts });
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes(privateExecutable), false);
    assert.equal(JSON.stringify(launchInputs).includes("https://assets.example.com"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("live doctor returns only closed capability facts and confirms host cleanup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-direct-doctor-config-"));
  try {
    setupDirectBrowser({
      browserFamily: "chrome",
      directory: root,
      env: {},
      discoverBrowser: () => ({ family: "chrome", path: "private-browser", source: "system" }),
    });
    const order: string[] = [];
    const receipt = await runDirectLiveDoctor({
      directory: root,
      env: {},
      discoverBrowser: () => ({ family: "chrome", path: "private-browser", source: "system" }),
      createHost() {
        let sessions = 0;
        return {
          createSession() { sessions += 1; order.push("create"); return { sessionId: "private-session" }; },
          async waitForSessionReady() { order.push("ready"); return { sessionId: "private-session", liveOrigin: "http://127.0.0.1" }; },
          async dispatch() { order.push("observe"); return { ok: true, outcome: "completed", retrySafe: false, commandId: "private", sessionEpoch: 1, sequence: 1, result: {} }; },
          async stopSession() { sessions = 0; order.push("stop"); },
          listSessions() { return Array.from({ length: sessions }, () => ({ sessionId: "private-session", origin: "http://127.0.0.1", lifecycleState: "active" as const })); },
          async close() { order.push("close"); },
        } as never;
      },
    });
    assert.deepEqual(order, ["create", "ready", "observe", "stop", "close"]);
    assert.deepEqual(receipt, {
      configured: true,
      runtimeVerified: true,
      cleanupConfirmed: true,
      browserFamily: "chrome",
      transport: "private_cdp_pipe",
      containment: "enabled_before_navigation",
    });
    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes("private-session"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("identity login retries uncertain startup cleanup before returning a bounded failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-direct-login-rollback-"));
  try {
    const setup = setupDirectBrowser({
      browserFamily: "chrome",
      directory: root,
      env: {},
      discoverBrowser: () => ({ family: "chrome", path: "private-browser", source: "system" }),
    });
    let cleanupCalls = 0;
    await assert.rejects(runDirectIdentityLogin({
      identityId: setup.identityId,
      origin: "https://example.com",
      directory: root,
      env: {},
      discoverBrowser: () => ({ family: "chrome", path: "private-browser", source: "system" }),
      async launchRuntime() {
        throw Object.assign(new Error("private startup detail"), {
          cleanupUncertain: true,
          async retryCleanup() { cleanupCalls += 1; },
        });
      },
    }), /identity_login_start_failed/u);
    assert.equal(cleanupCalls, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("direct runtime and browser selection refuse a hard-linked config file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-direct-config-link-"));
  const outside = path.join(root, "outside.json");
  const directory = path.join(root, "config");
  fs.mkdirSync(directory);
  fs.writeFileSync(outside, JSON.stringify({ browserTarget: "chrome", secret: "PRIVATE" }));
  fs.linkSync(outside, path.join(directory, "config.json"));
  try {
    assert.throws(() => loadDirectBrowserConfig({ directory, env: {} }), /direct_config_invalid/u);
    assert.throws(() => loadBrowserTarget({ directory, env: {} }), /direct_config_invalid/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
