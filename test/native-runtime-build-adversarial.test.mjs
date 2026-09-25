import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureNativeRuntimeBuild, hashNativeFile } from "../apps/mcp-server/src/native-runtime-build.ts";

async function makeTempRoot(t, name = "root") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `newton-native-build-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function makeRuntime(root, bytes = Buffer.from("inert-runtime-v1\n")) {
  const runtime = path.join(root, "runtime.bin");
  await fs.writeFile(runtime, bytes, { mode: 0o600 });
  return runtime;
}

async function statSnapshot(directory) {
  const names = ["native-host.js", "node.exe", "build.json"];
  return Object.fromEntries(await Promise.all(names.map(async (name) => {
    const stat = await fs.stat(path.join(directory, name));
    return [name, { ino: stat.ino, dev: stat.dev, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }];
  })));
}

test("repeated setup does not rewrite verified build files", async (t) => {
  const root = await makeTempRoot(t);
  const runtime = await makeRuntime(root);
  const entry = Buffer.from("inert-native-host-v1\n");

  const first = await ensureNativeRuntimeBuild(root, entry, runtime);
  const before = await statSnapshot(first.directory);
  const second = await ensureNativeRuntimeBuild(root, entry, runtime);
  const after = await statSnapshot(second.directory);

  assert.deepEqual(second, first);
  assert.deepEqual(after, before);
  assert.deepEqual(await fs.readFile(path.join(first.directory, "native-host.js")), entry);
  assert.deepEqual(await fs.readFile(path.join(first.directory, "node.exe")), await fs.readFile(runtime));
});

test("source runtime changes do not mutate an existing verified build", async (t) => {
  const root = await makeTempRoot(t);
  const runtime = await makeRuntime(root, Buffer.from("runtime-before\n"));
  const entry = Buffer.from("entry-stable\n");
  const first = await ensureNativeRuntimeBuild(root, entry, runtime);
  const before = await statSnapshot(first.directory);

  await fs.writeFile(runtime, "runtime-after\n");
  const second = await ensureNativeRuntimeBuild(root, entry, runtime);

  assert.deepEqual(second, first);
  assert.deepEqual(await statSnapshot(second.directory), before);
  assert.deepEqual(await fs.readFile(path.join(second.directory, "node.exe")), Buffer.from("runtime-before\n"));
});

test("changed entry content gets a separate immutable build", async (t) => {
  const root = await makeTempRoot(t);
  const runtime = await makeRuntime(root);
  const first = await ensureNativeRuntimeBuild(root, Buffer.from("entry-one\n"), runtime);
  const second = await ensureNativeRuntimeBuild(root, Buffer.from("entry-two\n"), runtime);

  assert.notEqual(second.digest, first.digest);
  assert.notEqual(second.directory, first.directory);
  assert.deepEqual(await fs.readFile(path.join(first.directory, "native-host.js")), Buffer.from("entry-one\n"));
  assert.deepEqual(await fs.readFile(path.join(second.directory, "native-host.js")), Buffer.from("entry-two\n"));
});

test("concurrent first install converges and removes every losing stage", async (t) => {
  const root = await makeTempRoot(t);
  const runtime = await makeRuntime(root);
  const entry = Buffer.from("concurrent-entry\n");

  const results = await Promise.all([
    ensureNativeRuntimeBuild(root, entry, runtime),
    ensureNativeRuntimeBuild(root, entry, runtime),
    ensureNativeRuntimeBuild(root, entry, runtime),
  ]);

  assert.equal(new Set(results.map((result) => result.digest)).size, 1);
  assert.equal(new Set(results.map((result) => result.directory)).size, 1);
  const names = await fs.readdir(path.join(root, "builds"));
  assert.deepEqual(names.filter((name) => name.startsWith(".stage-")), []);
});

test("partial and tampered existing builds fail closed", async (t) => {
  const cases = [
    ["missing metadata", async (directory) => fs.unlink(path.join(directory, "build.json"))],
    ["missing runtime", async (directory) => fs.unlink(path.join(directory, "node.exe"))],
    ["tampered entry", async (directory) => fs.writeFile(path.join(directory, "native-host.js"), "tampered\n")],
    ["tampered metadata", async (directory) => {
      const metadata = JSON.parse(await fs.readFile(path.join(directory, "build.json"), "utf8"));
      metadata.entryDigest = "a".repeat(64);
      await fs.writeFile(path.join(directory, "build.json"), `${JSON.stringify(metadata)}\n`);
    }],
  ];

  for (const [label, mutate] of cases) {
    const root = await makeTempRoot(t, label.replaceAll(" ", "-"));
    const runtime = await makeRuntime(root);
    const entry = Buffer.from(`entry-${label}\n`);
    const build = await ensureNativeRuntimeBuild(root, entry, runtime);
    await mutate(build.directory);
    await assert.rejects(ensureNativeRuntimeBuild(root, entry, runtime), undefined, label);
  }
});

test("rejects symlinked build paths and build members", async (t) => {
  const root = await makeTempRoot(t, "symlink-path");
  const runtime = await makeRuntime(root);
  const outsideBuilds = path.join(root, "outside-builds");
  await fs.mkdir(outsideBuilds);
  await fs.symlink(outsideBuilds, path.join(root, "builds"), "junction");
  await assert.rejects(
    ensureNativeRuntimeBuild(root, Buffer.from("entry\n"), runtime),
    /native_directory_invalid|EEXIST/,
  );

  const memberRoot = await makeTempRoot(t, "symlink-member");
  const memberRuntime = await makeRuntime(memberRoot);
  const build = await ensureNativeRuntimeBuild(memberRoot, Buffer.from("entry\n"), memberRuntime);
  const outsideEntry = path.join(memberRoot, "outside-entry.js");
  await fs.writeFile(outsideEntry, "outside\n");
  await fs.unlink(path.join(build.directory, "native-host.js"));
  await fs.symlink(outsideEntry, path.join(build.directory, "native-host.js"), "file");
  await assert.rejects(ensureNativeRuntimeBuild(memberRoot, Buffer.from("entry\n"), memberRuntime), /native_file_invalid/);
});

test("enforces direct hash caps and leaves no stage after successful setup", async (t) => {
  const root = await makeTempRoot(t);
  const runtime = await makeRuntime(root, Buffer.from("runtime-too-large-for-cap\n"));

  await assert.rejects(hashNativeFile(runtime, 4), /native_file_invalid/);
  await ensureNativeRuntimeBuild(root, Buffer.from("entry\n"), runtime);
  const builds = await fs.readdir(path.join(root, "builds")).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  assert.deepEqual(builds.filter((name) => name.startsWith(".stage-")), []);
});
