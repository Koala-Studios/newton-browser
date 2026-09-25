import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { acquireInstallationLock } from "../apps/mcp-server/src/installation-lock.ts";

async function makeTempRoot(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `newton-install-lock-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function endpointFor(directory) {
  const canonical = await fs.realpath(directory);
  const key = createHash("sha256")
    .update(process.platform === "win32" ? canonical.toLowerCase() : canonical)
    .digest("hex");
  return process.platform === "win32"
    ? `\\\\.\\pipe\\newton-browser-installation-${key}`
    : `\0newton-browser-installation-${key}`;
}

async function probeEndpoint(endpoint) {
  await new Promise((resolve) => {
    const socket = net.createConnection({ path: endpoint });
    const finish = () => {
      socket.destroy();
      resolve();
    };
    socket.once("error", finish);
    socket.once("close", finish);
  });
}

test("independent directories have independent concurrent owners", async (t) => {
  const parent = await makeTempRoot(t, "independent");
  const firstDirectory = path.join(parent, "first");
  const secondDirectory = path.join(parent, "second");
  await fs.mkdir(firstDirectory);
  await fs.mkdir(secondDirectory);

  const [first, second] = await Promise.all([
    acquireInstallationLock(firstDirectory),
    acquireInstallationLock(secondDirectory),
  ]);
  try {
    assert.equal(first.signal.aborted, false);
    assert.equal(second.signal.aborted, false);
    assert.notEqual(first.directory, second.directory);
  } finally {
    await Promise.all([first.release(), second.release()]);
  }
});

test("same-directory aliases resolve to one ownership key", async (t) => {
  const directory = await makeTempRoot(t, "aliases");
  const alias = path.join(directory, ".");
  const lock = await acquireInstallationLock(directory);
  try {
    assert.equal(lock.directory, await fs.realpath(alias));
    await assert.rejects(acquireInstallationLock(alias), /installation_busy/);
  } finally {
    await lock.release();
  }
  const reused = await acquireInstallationLock(alias);
  await reused.release();
});

test("invalid, file, and symlink roots fail before reserving ownership", async (t) => {
  const parent = await makeTempRoot(t, "invalid");
  const missing = path.join(parent, "missing");
  await assert.rejects(acquireInstallationLock(missing));

  const file = path.join(parent, "file");
  await fs.writeFile(file, "not-a-directory");
  await assert.rejects(acquireInstallationLock(file), /adapter_path_invalid/);

  const target = path.join(parent, "target");
  const link = path.join(parent, "link");
  await fs.mkdir(target);
  await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(acquireInstallationLock(link), /adapter_path_invalid/);
});

test("release is idempotent and concurrent release calls share completion", async (t) => {
  const directory = await makeTempRoot(t, "release");
  const lock = await acquireInstallationLock(directory);
  const releases = await Promise.all([lock.release(), lock.release(), lock.release()]);
  assert.deepEqual(releases, [undefined, undefined, undefined]);
  assert.equal(lock.signal.aborted, true);

  const reused = await acquireInstallationLock(directory);
  await reused.release();
});

test("an unrelated endpoint client cannot release or steal ownership", async (t) => {
  const directory = await makeTempRoot(t, "client");
  const lock = await acquireInstallationLock(directory);
  try {
    const endpoint = await endpointFor(directory);
    await probeEndpoint(endpoint);
    assert.equal(lock.signal.aborted, false);
    await assert.rejects(acquireInstallationLock(directory), /installation_busy/);
  } finally {
    await lock.release();
  }

  const reused = await acquireInstallationLock(directory);
  await reused.release();
});
