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
import { createNewtonIdentity, openProfileStore } from "../../src/browser-runtime/profile-store.ts";
import { loadBrowserPreference } from "../../src/config.ts";

test("setup persists only the selected browser family and creates no identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-direct-config-"));
  try {
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ hostPolicies: [] }));
    const receipt = setupDirectBrowser({
      browserFamily: "chrome",
      directory: root,
      env: {},
      discoverBrowser: () => ({ family: "chrome", path: "ignored", source: "system" }),
    });
    assert.deepEqual(receipt, {
      configured: true,
      browserFamily: "chrome",
      transport: "stdio",
      nextAction: "start_session",
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")), { browser: "chrome" });
    assert.equal(fs.existsSync(path.join(root, "identities")), false);
    assert.equal(loadBrowserPreference({ directory: root, env: {} }), "chrome");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("contained identity login uses only the explicitly selected identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-direct-login-private-"));
  const privateExecutable = path.join(root, "PRIVATE_BROWSER.exe");
  try {
    const identity = createNewtonIdentity(openProfileStore(path.join(root, "identities")), { browserFamily: "edge" });
    const order: string[] = [];
    const launchInputs: unknown[] = [];
    const readyReceipts: unknown[] = [];
    const result = await runDirectIdentityLogin({
      identityId: identity.id,
      origin: "https://example.com",
      allowedOrigins: ["https://assets.example.com"],
      directory: root,
      env: {},
      discoverBrowser: () => ({ family: "edge", path: privateExecutable, source: "explicit" }),
      async launchRuntime(options) {
        launchInputs.push(options);
        return {
          receipt: { status: "ready", identityId: identity.id, browserFamily: "edge", pid: 991 },
          unavailable: new Promise<void>(() => {}),
          claimDriverBootstrap(origins) {
            order.push(`claim:${origins.length}`);
            return { transport: { async send() { return {}; }, onEvent() { return () => {}; } }, rootTargetId: "root" };
          },
          async close() { order.push("runtime_close"); },
        };
      },
      async startDriverSession(options) {
        order.push(`session_start:${options.allowedOrigins.length}`);
        return {
          async execute() { return { status: "verified" }; },
          async stop() { order.push("session_stop"); },
          snapshot() { return { state: "active", runningCommands: 0, queuedCommands: 0, runningBytes: 0, queuedBytes: 0, queueClosed: false }; },
        };
      },
      createTerminationSignal: () => ({ promise: Promise.resolve(), dispose() {} }),
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

test("identity login rejects a repeated primary origin before browser discovery", async () => {
  await assert.rejects(runDirectIdentityLogin({
    identityId: "nbi_0123456789abcdef0123456789abcdef",
    origin: "https://example.com",
    allowedOrigins: ["https://example.com"],
    discoverBrowser: () => { throw new Error("must_not_discover"); },
  }), /identity_login_invalid_arguments/u);
});

test("identity login uses the one 512-character origin bound", async () => {
  const overlongOrigin = `https://${Array.from({ length: 90 }, () => "aaaaa").join(".")}.example`;
  assert.ok(overlongOrigin.length > 512);
  await assert.rejects(runDirectIdentityLogin({
    identityId: "nbi_00000000000000000000000000000000",
    origin: overlongOrigin,
    env: {},
  }), /identity_login_invalid_arguments/u);
});

test("live doctor auto-discovers a browser and confirms ephemeral host cleanup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-direct-doctor-config-"));
  try {
    const order: string[] = [];
    const receipt = await runDirectLiveDoctor({
      directory: root,
      env: {},
      discoverBrowser: ({ family }) => family === "chrome" ? ({ family: "chrome", path: "private-browser", source: "system" }) : null,
      createHost() {
        let sessions = 0;
        return {
          createSession() { sessions += 1; order.push("create"); return { sessionId: "private-session" }; },
          async waitForSessionReady() { order.push("ready"); return { sessionId: "private-session", origin: "http://127.0.0.1" }; },
          async dispatch() { order.push("observe"); return { ok: true, status: "verified", outcome: "completed", retrySafe: false, commandId: "private", sequence: 1, result: {} }; },
          async stopSession() { sessions = 0; order.push("stop"); },
          listSessions() { return Array.from({ length: sessions }, () => ({ sessionId: "private-session", origin: "http://127.0.0.1", allowedOrigins: ["http://127.0.0.1"], lifecycleState: "active" as const })); },
          async close() { order.push("close"); },
        } as never;
      },
    });
    assert.deepEqual(order, ["create", "ready", "observe", "stop", "close"]);
    assert.equal(receipt.browserFamily, "chrome");
    assert.equal(receipt.runtimeVerified, true);
    assert.equal(receipt.cleanupConfirmed, true);
    assert.equal(JSON.stringify(receipt).includes(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("identity login retries uncertain startup cleanup before bounded failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-direct-login-rollback-"));
  try {
    const identity = createNewtonIdentity(openProfileStore(path.join(root, "identities")), { browserFamily: "chrome" });
    let cleanupCalls = 0;
    await assert.rejects(runDirectIdentityLogin({
      identityId: identity.id,
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

test("configuration rejects old identity defaults and hard-linked files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-direct-config-link-"));
  try {
    const oldDirectory = path.join(root, "old");
    fs.mkdirSync(oldDirectory);
    fs.writeFileSync(path.join(oldDirectory, "config.json"), JSON.stringify({ browserTarget: "chrome", identityId: "nbi_0123456789abcdef0123456789abcdef" }));
    assert.throws(() => loadBrowserPreference({ directory: oldDirectory, env: {} }), /direct_config_invalid/u);

    const outside = path.join(root, "outside.json");
    const linkedDirectory = path.join(root, "linked");
    fs.mkdirSync(linkedDirectory);
    fs.writeFileSync(outside, JSON.stringify({ browser: "chrome" }));
    fs.linkSync(outside, path.join(linkedDirectory, "config.json"));
    assert.throws(() => loadBrowserPreference({ directory: linkedDirectory, env: {} }), /direct_config_invalid/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
