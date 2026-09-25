import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { prepareAdapterDirectory, readAdapterDirectory } from "../apps/mcp-server/src/adapter-directory.ts";
import { openUpdateJournal } from "../apps/mcp-server/src/adapter-update-journal.ts";
import {
  recoverInstalledAdapter,
  updateInstalledAdapter,
} from "../apps/mcp-server/src/adapter-update-transaction.ts";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function makeTempRoot(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `newton-update-transaction-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function makeArtifacts(root, worker) {
  const artifacts = path.join(root, "artifacts");
  await fs.mkdir(artifacts);
  const manifest = {
    manifest_version: 3,
    name: "Newton Browser Adapter",
    version: "1.0.0",
    background: { service_worker: "worker.js", type: "module" },
    permissions: ["debugger", "tabs", "nativeMessaging", "webNavigation"],
  };
  await fs.writeFile(path.join(artifacts, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  await fs.writeFile(path.join(artifacts, "worker.js"), worker);
  await fs.writeFile(path.join(artifacts, "setup.html"), "<!doctype html><title>Newton</title>\n");
  return artifacts;
}

async function makeInstalled(t, name, oldCode = "old-worker\n") {
  const root = await makeTempRoot(t, name);
  const artifacts = await makeArtifacts(root, oldCode);
  const installed = await prepareAdapterDirectory(path.join(root, "installed"), artifacts);
  return { root, directory: installed.directory, installed, oldCode: Buffer.from(oldCode) };
}

async function makeStage(directory, worker, name = "staged") {
  const stage = path.join(path.dirname(directory), name);
  await fs.mkdir(stage);
  await fs.copyFile(path.join(directory, "manifest.json"), path.join(stage, "manifest.json"));
  await fs.copyFile(path.join(directory, "setup.html"), path.join(stage, "setup.html"));
  await fs.writeFile(path.join(stage, "worker.js"), worker);
  return stage;
}

function controlFactory(calls, bootstrap, recordBinding = false) {
  return async (options) => {
    calls.push(recordBinding
      ? ["connect", options.recovering, options.bindingRequired]
      : ["connect", options.recovering]);
    return {
      async quiesce() { calls.push("quiesce"); },
      async reload() { calls.push("reload"); },
      async waitBootstrap(target) {
        calls.push(["waitBootstrap", target]);
        return bootstrap(target, options);
      },
      async smoke() { calls.push("smoke"); },
      async finish() { calls.push("finish"); },
      close() { calls.push("close"); },
    };
  };
}

test("successful update preserves extension identity and valid installed metadata", async (t) => {
  const fixture = await makeInstalled(t, "success");
  const newCode = Buffer.from("new-worker-success\n");
  const stage = await makeStage(fixture.directory, newCode);
  const beforeManifest = await fs.readFile(path.join(fixture.directory, "manifest.json"));
  const calls = [];
  const result = await updateInstalledAdapter(
    fixture.directory,
    stage,
    controlFactory(calls, (target) => ({ digest: target, epoch: "success-epoch", protocolMajor: 1 })),
  );

  assert.deepEqual(result, { state: "updated", digest: digest(newCode) });
  const installed = await readAdapterDirectory(fixture.directory);
  assert.equal(installed.installationId, fixture.installed.installationId);
  assert.equal(installed.extensionId, fixture.installed.extensionId);
  assert.deepEqual(await fs.readFile(path.join(fixture.directory, "manifest.json")), beforeManifest);
  assert.deepEqual(await fs.readFile(path.join(fixture.directory, "worker.js")), newCode);
  assert.ok(calls.includes("smoke"));
});

test("wrong bootstrap digest rolls the worker back to the previous build", async (t) => {
  const fixture = await makeInstalled(t, "rollback");
  const newCode = Buffer.from("new-worker-rollback\n");
  const stage = await makeStage(fixture.directory, newCode);
  const previous = digest(fixture.oldCode);
  const next = digest(newCode);
  let firstBootstrap = true;
  const calls = [];
  const result = await updateInstalledAdapter(
    fixture.directory,
    stage,
    controlFactory(calls, (target) => {
      if (firstBootstrap && target === next) {
        firstBootstrap = false;
        return { digest: previous, epoch: "wrong-target", protocolMajor: 1 };
      }
      return { digest: target, epoch: "rollback-epoch", protocolMajor: 1 };
    }),
  );

  assert.deepEqual(result, { state: "rolled_back", digest: previous });
  const installed = await readAdapterDirectory(fixture.directory);
  assert.equal(installed.files["worker.js"], previous);
  assert.deepEqual(await fs.readFile(path.join(fixture.directory, "worker.js")), fixture.oldCode);
  assert.ok(calls.filter((call) => Array.isArray(call) && call[0] === "waitBootstrap").length >= 2);
});

test("failed update and rollback retain recovery evidence, then recoverInstalledAdapter rolls back", async (t) => {
  const fixture = await makeInstalled(t, "recovery");
  const newCode = Buffer.from("new-worker-recovery\n");
  const stage = await makeStage(fixture.directory, newCode);
  let updateWaits = 0;
  const failedCalls = [];
  await assert.rejects(
    updateInstalledAdapter(
      fixture.directory,
      stage,
      controlFactory(failedCalls, () => {
        updateWaits += 1;
        return { digest: "f".repeat(64), epoch: `bad-${updateWaits}`, protocolMajor: 1 };
      }),
    ),
    /adapter_bootstrap_recovery_required/,
  );

  const recoveryCalls = [];
  const recovered = await recoverInstalledAdapter(
    fixture.directory,
    controlFactory(recoveryCalls, (target) => ({ digest: target, epoch: "recovery-epoch", protocolMajor: 1 }), true),
  );
  assert.deepEqual(recovered, { state: "rolled_back", digest: digest(fixture.oldCode) });
  assert.deepEqual(await fs.readFile(path.join(fixture.directory, "worker.js")), fixture.oldCode);
  assert.deepEqual(recoveryCalls[0], ["connect", true, true]);
  assert.ok(recoveryCalls.includes("quiesce"));
  assert.ok(recoveryCalls.includes("smoke"));
  assert.ok(failedCalls.some((call) => Array.isArray(call) && call[0] === "waitBootstrap"));
});

test("an unfinished journal blocks a second update", async (t) => {
  const fixture = await makeInstalled(t, "unfinished");
  const newCode = Buffer.from("new-worker-unfinished\n");
  const stage = await makeStage(fixture.directory, newCode);
  const journal = await openUpdateJournal(fixture.directory);
  const record = await journal.begin(fixture.installed.installationId, fixture.oldCode, newCode);
  await journal.close();

  const calls = [];
  await assert.rejects(
    updateInstalledAdapter(
      fixture.directory,
      stage,
      controlFactory(calls, (target) => ({ digest: target, epoch: "unused", protocolMajor: 1 })),
    ),
    /adapter_update_recovery_required/,
  );
  assert.ok(record.ticket);
  assert.deepEqual(calls, []);
});

test("committed recovery never reloads, replays bootstrap, or runs smoke", async (t) => {
  const fixture = await makeInstalled(t, "committed");
  const newCode = Buffer.from("new-worker-committed\n");
  const stage = await makeStage(fixture.directory, newCode);
  await updateInstalledAdapter(
    fixture.directory,
    stage,
    controlFactory([], (target) => ({ digest: target, epoch: "commit-epoch", protocolMajor: 1 })),
  );

  const calls = [];
  const result = await recoverInstalledAdapter(
    fixture.directory,
    controlFactory(calls, () => { throw new Error("bootstrap_replay_forbidden"); }),
  );
  assert.deepEqual(result, { state: "already_committed", digest: digest(newCode) });
  assert.deepEqual(calls, [["connect", true], "finish", "close"]);
});

test("prior committed cleanup failure preserves the exact journal ticket", async (t) => {
  const fixture = await makeInstalled(t, "prior-cleanup-failure");
  const firstCode = Buffer.from("new-worker-prior\n");
  const firstStage = await makeStage(fixture.directory, firstCode);
  await updateInstalledAdapter(
    fixture.directory,
    firstStage,
    controlFactory([], (target) => ({ digest: target, epoch: "prior-epoch", protocolMajor: 1 })),
  );

  const beforeJournal = await openUpdateJournal(fixture.directory);
  const before = beforeJournal.read();
  await beforeJournal.close();
  const secondStage = await makeStage(fixture.directory, Buffer.from("new-worker-second\n"), "staged-second");
  const cleanupCalls = [];
  const failingCleanup = async (options) => ({
    async quiesce() { cleanupCalls.push("quiesce"); },
    async reload() { cleanupCalls.push("reload"); },
    async waitBootstrap(target) { cleanupCalls.push(["waitBootstrap", target]); return { digest: target, epoch: "unused", protocolMajor: 1 }; },
    async smoke() { cleanupCalls.push("smoke"); },
    async finish() {
      cleanupCalls.push(["finish", options.recovering, options.ticket]);
      throw new Error("marker_cleanup_failed");
    },
    close() { cleanupCalls.push("close"); },
  });

  await assert.rejects(
    updateInstalledAdapter(fixture.directory, secondStage, failingCleanup),
    /marker_cleanup_failed/,
  );
  const afterJournal = await openUpdateJournal(fixture.directory);
  try {
    const after = afterJournal.read();
    assert.equal(after.phase, "committed");
    assert.equal(after.ticket, before.ticket);
    assert.deepEqual(cleanupCalls, [["finish", true, before.ticket], "close"]);
  } finally {
    await afterJournal.close();
  }
});

test("recovery rejects unknown changed worker bytes", async (t) => {
  const fixture = await makeInstalled(t, "unknown-worker");
  const nextCode = Buffer.from("new-worker-known\n");
  const journal = await openUpdateJournal(fixture.directory);
  const record = await journal.begin(fixture.installed.installationId, fixture.oldCode, nextCode);
  await journal.transition("publishing", record.next);
  await journal.close();
  await fs.writeFile(path.join(fixture.directory, "worker.js"), "unknown-worker\n");

  const calls = [];
  await assert.rejects(
    recoverInstalledAdapter(
      fixture.directory,
      controlFactory(calls, (target) => ({ digest: target, epoch: "unused", protocolMajor: 1 })),
    ),
    /adapter_installation_changed/,
  );
  assert.deepEqual(calls, []);
});
