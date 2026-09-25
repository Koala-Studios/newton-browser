import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { handleUtilityCommand } from "../apps/mcp-server/src/cli.ts";
import { acquireInstallationLock } from "../apps/mcp-server/src/installation-lock.ts";
import { openUpdateJournal } from "../apps/mcp-server/src/adapter-update-journal.ts";

const connection = `existing_${"a".repeat(24)}`;
const instance = "cli-test-epoch";
const tab = "1";

async function makeTempRoot(t, name) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), `newton-adapter-cli-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function invoke(args, configRoot) {
  const previousConfig = process.env.NEWTON_BROWSER_CONFIG_DIR;
  const previousWrite = process.stdout.write;
  let output = "";
  process.env.NEWTON_BROWSER_CONFIG_DIR = configRoot;
  process.stdout.write = (chunk) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    return true;
  };
  try {
    const handled = await handleUtilityCommand(args);
    return { handled, output: output.trim() ? JSON.parse(output.trim()) : undefined };
  } finally {
    process.stdout.write = previousWrite;
    if (previousConfig === undefined) delete process.env.NEWTON_BROWSER_CONFIG_DIR;
    else process.env.NEWTON_BROWSER_CONFIG_DIR = previousConfig;
  }
}

test("rejects missing, invalid, duplicate, and unknown update/recover flags before config mutation", async (t) => {
  const root = await makeTempRoot(t, "invalid-flags");
  const cases = [
    ["update missing flags", ["adapter", "update"], /adapter_invalid_arguments/],
    ["recover missing flags", ["adapter", "recover"], /adapter_invalid_arguments/],
    ["update invalid connection", ["adapter", "update", "--connection", "bad", "--instance", instance, "--tab", tab], /adapter_invalid_arguments/],
    ["recover invalid tab", ["adapter", "recover", "--connection", connection, "--instance", instance, "--tab", "0"], /adapter_invalid_arguments/],
    ["update duplicate connection", ["adapter", "update", "--connection", connection, "--connection", connection, "--instance", instance, "--tab", tab], /utility_invalid_arguments/],
    ["recover duplicate tab", ["adapter", "recover", "--connection", connection, "--instance", instance, "--tab", tab, "--tab", tab], /utility_invalid_arguments/],
    ["update unknown flag", ["adapter", "update", "--connection", connection, "--instance", instance, "--tab", tab, "--unknown"], /utility_invalid_arguments/],
    ["recover unknown flag", ["adapter", "recover", "--connection", connection, "--instance", instance, "--tab", tab, "--unknown"], /utility_invalid_arguments/],
  ];

  for (const [label, args, expected] of cases) {
    const before = await fs.readdir(root);
    await assert.rejects(invoke(args, root), expected, label);
    assert.deepEqual(await fs.readdir(root), before, label);
  }
});

test("status reports updating while another owner holds the installation lock", async (t) => {
  const root = await makeTempRoot(t, "updating");
  const directory = path.join(root, "tab-adapter");
  await fs.mkdir(directory);
  const lock = await acquireInstallationLock(directory);
  try {
    const result = await invoke(["adapter", "status"], root);
    assert.deepEqual(result, { handled: true, output: { state: "updating", directory } });
  } finally {
    await lock.release();
  }
});

test("status reports recovery_required for an unfinished valid journal", async (t) => {
  const root = await makeTempRoot(t, "recovery-required");
  const directory = path.join(root, "tab-adapter");
  await fs.mkdir(directory);
  const journal = await openUpdateJournal(directory);
  await journal.begin(randomUUID(), Buffer.from("old"), Buffer.from("new"));
  await journal.close();

  const result = await invoke(["adapter", "status"], root);
  assert.deepEqual(result, { handled: true, output: { state: "recovery_required", phase: "prepared", directory } });
});

test("status reports not_installed without creating an installation directory", async (t) => {
  const root = await makeTempRoot(t, "not-installed");
  const result = await invoke(["adapter", "status"], root);
  assert.deepEqual(result, { handled: true, output: { state: "not_installed" } });
  await assert.rejects(fs.lstat(path.join(root, "tab-adapter")), (error) => error.code === "ENOENT");
});
