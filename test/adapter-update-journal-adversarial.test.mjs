import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { openUpdateJournal } from "../apps/mcp-server/src/adapter-update-journal.ts";

async function makeTempRoot(t, name) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), `newton-update-journal-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function seedJournal(directory, previous = "old code", next = "new code") {
  const journal = await openUpdateJournal(directory);
  try {
    return await journal.begin(randomUUID(), Buffer.from(previous), Buffer.from(next));
  } finally {
    await journal.close();
  }
}

test("returned journal snapshots are immutable copies", async (t) => {
  const root = await makeTempRoot(t, "snapshots");
  const journal = await openUpdateJournal(root);
  try {
    const returned = await journal.begin(randomUUID(), Buffer.from("old"), Buffer.from("new"));
    const snapshot = journal.read();
    returned.phase = "committed";
    returned.previousCode = "mutated";
    snapshot.phase = "committed";
    snapshot.nextCode = "mutated";

    const reread = journal.read();
    assert.equal(reread.phase, "prepared");
    assert.notEqual(reread.previousCode, "mutated");
    assert.notEqual(reread.nextCode, "mutated");
    await journal.transition("publishing", reread.next);
  } finally {
    await journal.close();
  }
});

test("malformed, oversized, and symlink journal records fail closed and release the lock", async (t) => {
  const cases = [
    ["malformed", async (filename, root) => fs.writeFile(filename, "not-json\n")],
    ["oversized", async (filename, root) => fs.writeFile(filename, Buffer.alloc(3 * 1024 * 1024 + 1, 0x61))],
    ["symlink", async (filename, root) => {
      const outside = path.join(root, "outside-update.json");
      await fs.writeFile(outside, "{}\n");
      await fs.unlink(filename);
      await fs.symlink(outside, filename, "file");
    }],
  ];

  for (const [label, mutate] of cases) {
    const root = await makeTempRoot(t, label);
    await seedJournal(root);
    const filename = path.join(root, "update.json");
    await mutate(filename, root);
    await assert.rejects(openUpdateJournal(root), undefined, label);

    const lease = await (await import("../apps/mcp-server/src/installation-lock.ts")).acquireInstallationLock(root);
    await lease.release();
  }
});

test("a failed journal write retains the prior recovery snapshot and poisons later writes", async (t) => {
  const root = await makeTempRoot(t, "write-failure");
  const journal = await openUpdateJournal(root);
  try {
    const record = await journal.begin(randomUUID(), Buffer.from("old"), Buffer.from("new"));
    const filename = path.join(root, "update.json");
    await fs.unlink(filename);
    await fs.mkdir(filename);

    await assert.rejects(journal.transition("publishing", record.next));
    assert.deepEqual(journal.read(), record);
    await assert.rejects(journal.transition("publishing", record.next), /recovery_required/);
    assert.deepEqual((await fs.readdir(root)).filter((name) => name.startsWith("update-") && name.endsWith(".stage")), []);
  } finally {
    await journal.close();
  }
});

test("root replacement is detected before a pending journal transition writes", async (t) => {
  const parent = await makeTempRoot(t, "root-replacement");
  const root = path.join(parent, "installation");
  const moved = path.join(parent, "moved-installation");
  await fs.mkdir(root);
  const journal = await openUpdateJournal(root);
  try {
    const record = await journal.begin(randomUUID(), Buffer.from("old"), Buffer.from("new"));
    await fs.rename(root, moved);
    await fs.mkdir(root);
    await assert.rejects(journal.transition("publishing", record.next), /adapter_path_changed/);
    assert.equal(journal.read().phase, "prepared");
  } finally {
    await journal.close();
  }
});

test("a child exit leaves the pending journal snapshot for recovery", { timeout: 15000 }, async (t) => {
  const root = await makeTempRoot(t, "child-exit");
  const moduleUrl = pathToFileURL(path.resolve("apps/mcp-server/src/adapter-update-journal.ts")).href;
  const script = `
    import { randomUUID } from "node:crypto";
    import { openUpdateJournal } from ${JSON.stringify(moduleUrl)};
    const journal = await openUpdateJournal(process.env.NEWTON_JOURNAL_DIR);
    await journal.begin(randomUUID(), Buffer.from("old child"), Buffer.from("new child"));
    process.stdout.write("ready\\n", () => process.exit(0));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, NEWTON_JOURNAL_DIR: root },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const exited = once(child, "exit");
  const ready = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("ready")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`child exited before ready: ${code}/${signal}`)));
  });
  await ready;
  const [code, signal] = await exited;
  assert.equal(code, 0);
  assert.equal(signal, null);

  const journal = await openUpdateJournal(root);
  try {
    assert.equal(journal.read().phase, "prepared");
    assert.equal(Buffer.from(journal.read().previousCode, "base64").toString(), "old child");
  } finally {
    await journal.close();
  }
});
