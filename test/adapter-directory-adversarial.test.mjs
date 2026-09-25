import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  prepareAdapterDirectory,
  readAdapterDirectory,
} from "../apps/mcp-server/src/adapter-directory.ts";

const NAMES = ["manifest.json", "worker.js", "setup.html"];
const PERMISSIONS = ["debugger", "tabs", "nativeMessaging", "webNavigation"];

function digest(data) {
  return createHash("sha256").update(data).digest("hex");
}

function extensionId(key) {
  return [...createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
    .join("");
}

async function makeTempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "newton-adapter-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function makeArtifacts(root, { worker = "self.postMessage('ready');\n", manifestPatch = {}, manifestRaw } = {}) {
  const artifacts = path.join(root, "artifacts");
  await fs.mkdir(artifacts);
  const manifest = {
    manifest_version: 3,
    name: "Newton Browser Adapter",
    version: "1.0.0",
    background: { service_worker: "worker.js", type: "module" },
    permissions: PERMISSIONS,
    ...manifestPatch,
  };
  await fs.writeFile(path.join(artifacts, "manifest.json"), manifestRaw ?? `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(artifacts, "worker.js"), worker, { mode: 0o600 });
  await fs.writeFile(path.join(artifacts, "setup.html"), "<!doctype html><title>Newton</title>\n", { mode: 0o600 });
  return artifacts;
}

async function makeInstalled(root, { worker = "self.postMessage('ready');\n" } = {}) {
  const directory = path.join(root, "installed");
  await fs.mkdir(directory);
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
  const key = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const manifest = {
    manifest_version: 3,
    name: "Newton Browser Adapter",
    version: "1.0.0",
    background: { service_worker: "worker.js" },
    permissions: PERMISSIONS,
    key,
  };
  const files = {
    "manifest.json": Buffer.from(`${JSON.stringify(manifest)}\n`),
    "worker.js": Buffer.from(worker),
    "setup.html": Buffer.from("<!doctype html><title>Newton</title>\n"),
  };
  const record = {
    version: 1,
    installationId: randomUUID(),
    extensionId: extensionId(key),
    files: Object.fromEntries(NAMES.map((name) => [name, digest(files[name])])),
  };
  for (const name of NAMES) await fs.writeFile(path.join(directory, name), files[name], { mode: 0o600 });
  await fs.writeFile(path.join(directory, "installation.json"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return { directory, record, files, manifest };
}

async function rewriteRecord(directory, record) {
  await fs.writeFile(path.join(directory, "installation.json"), `${JSON.stringify(record)}\n`);
}

test("repeated and concurrent setup of an existing identity preserves key and worker bytes", async (t) => {
  const root = await makeTempRoot(t);
  const artifacts = await makeArtifacts(root, { worker: "const worker = 'source-v1';\n" });
  const fixture = await makeInstalled(root, { worker: "const worker = 'installed-v1';\n" });

  const first = await prepareAdapterDirectory(fixture.directory, artifacts);
  const before = await fs.readFile(path.join(fixture.directory, "worker.js"));
  const results = await Promise.all([
    prepareAdapterDirectory(fixture.directory, artifacts),
    prepareAdapterDirectory(fixture.directory, artifacts),
  ]);

  assert.equal(first.installationId, fixture.record.installationId);
  assert.equal(first.extensionId, fixture.record.extensionId);
  assert.deepEqual(results.map((result) => result.installationId), [first.installationId, first.installationId]);
  assert.deepEqual(await fs.readFile(path.join(fixture.directory, "worker.js")), before);
});

test("concurrent first setup materializes one stable identity from a missing destination", async (t) => {
  const root = await makeTempRoot(t);
  const artifacts = await makeArtifacts(root);
  const destination = path.join(root, "new-identity");

  const results = await Promise.allSettled([
    prepareAdapterDirectory(destination, artifacts),
    prepareAdapterDirectory(destination, artifacts),
  ]);

  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"]);
  assert.equal(results[0].value.installationId, results[1].value.installationId);
  assert.equal(results[0].value.extensionId, results[1].value.extensionId);
  assert.deepEqual(await fs.readFile(path.join(destination, "worker.js")), await fs.readFile(path.join(artifacts, "worker.js")));
});

test("rejects malformed, partial, foreign, and tampered installation roots", async (t) => {
  const root = await makeTempRoot(t);
  const fixture = await makeInstalled(root);

  await fs.writeFile(path.join(fixture.directory, "installation.json"), "not-json");
  await assert.rejects(readAdapterDirectory(fixture.directory), /adapter_installation_invalid/);

  const partial = path.join(root, "partial");
  await fs.mkdir(partial);
  await fs.writeFile(path.join(partial, "installation.json"), JSON.stringify(fixture.record));
  await assert.rejects(readAdapterDirectory(partial));

  await rewriteRecord(fixture.directory, { ...fixture.record, extensionId: "b".repeat(32) });
  await assert.rejects(readAdapterDirectory(fixture.directory), /adapter_installation_changed/);

  await rewriteRecord(fixture.directory, fixture.record);
  await fs.writeFile(path.join(fixture.directory, "worker.js"), "tampered\n");
  await assert.rejects(readAdapterDirectory(fixture.directory), /adapter_installation_changed/);
});

test("rejects symlinked roots and symlinked artifact members", async (t) => {
  const root = await makeTempRoot(t);
  const fixture = await makeInstalled(root);
  const linkedRoot = path.join(root, "linked-root");
  await fs.symlink(fixture.directory, linkedRoot, "junction");
  await assert.rejects(readAdapterDirectory(linkedRoot), /adapter_path_invalid/);

  const outside = path.join(root, "outside-worker.js");
  await fs.writeFile(outside, "outside\n");
  await fs.unlink(path.join(fixture.directory, "worker.js"));
  await fs.symlink(outside, path.join(fixture.directory, "worker.js"), "file");
  await assert.rejects(readAdapterDirectory(fixture.directory), /adapter_file_invalid/);
});

test("rejects altered and expanded source manifest capabilities", async (t) => {
  const root = await makeTempRoot(t);
  const cases = [
    ["altered permissions", { permissions: ["debugger", "tabs"] }],
    ["host permissions", { host_permissions: ["https://example.test/*"] }],
    ["content scripts", { content_scripts: [{ matches: ["https://example.test/*"], js: ["worker.js"] }] }],
    ["web accessible resources", { web_accessible_resources: [{ resources: ["setup.html"], matches: ["https://example.test/*"] }] }],
  ];

  for (const [label, manifestPatch] of cases) {
    const caseRoot = path.join(root, label.replaceAll(" ", "-"));
    await fs.mkdir(caseRoot);
    const artifacts = await makeArtifacts(caseRoot, { manifestPatch });
    await assert.rejects(
      prepareAdapterDirectory(path.join(caseRoot, "identity"), artifacts),
      /adapter_artifact_invalid/,
      label,
    );
  }
});

test("rejects malformed and null source or installed metadata", async (t) => {
  const root = await makeTempRoot(t);

  const malformedRoot = path.join(root, "malformed-source");
  await fs.mkdir(malformedRoot);
  const malformedArtifacts = await makeArtifacts(malformedRoot, { manifestRaw: "{" });
  await assert.rejects(prepareAdapterDirectory(path.join(malformedRoot, "identity"), malformedArtifacts));

  const nullRoot = path.join(root, "null-source");
  await fs.mkdir(nullRoot);
  const nullArtifacts = await makeArtifacts(nullRoot, { manifestRaw: "null\n" });
  await assert.rejects(prepareAdapterDirectory(path.join(nullRoot, "identity"), nullArtifacts));

  const fixture = await makeInstalled(root);
  await fs.writeFile(path.join(fixture.directory, "installation.json"), "null\n");
  await assert.rejects(readAdapterDirectory(fixture.directory));
});

test("invalid source artifacts fail without leaving a staging directory or destination", async (t) => {
  const root = await makeTempRoot(t);
  const artifacts = path.join(root, "invalid-artifacts");
  await fs.mkdir(artifacts);
  await fs.writeFile(path.join(artifacts, "manifest.json"), JSON.stringify({ manifest_version: 3 }));
  await fs.writeFile(path.join(artifacts, "worker.js"), "worker\n");
  const destination = path.join(root, "new-identity");

  await assert.rejects(prepareAdapterDirectory(destination, artifacts));
  const entries = await fs.readdir(root);
  assert.equal(entries.some((entry) => entry.startsWith(".newton-adapter-stage-")), false);
  await assert.rejects(fs.lstat(destination), (error) => error.code === "ENOENT");
});
