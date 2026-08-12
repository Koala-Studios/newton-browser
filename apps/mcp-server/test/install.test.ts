import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { clientConfigTarget, planClientInstall, runInstall, serverInvocation } from "../src/install.ts";

const ENV = { HOME: "/home/tester", USERPROFILE: "/home/tester" };
const INVOCATION = Object.freeze({
  command: path.resolve("fixtures", "node"),
  args: [path.resolve("fixtures", "newton-browser", "index.js")],
});

test("serverInvocation pins one exact local Node entrypoint", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "newton-invocation-"));
  const command = path.join(directory, process.platform === "win32" ? "node.exe" : "node");
  const entry = path.join(directory, "index.js");
  fs.writeFileSync(command, "runtime");
  fs.writeFileSync(entry, "entry");
  if (process.platform !== "win32") fs.chmodSync(command, 0o700);
  try {
    assert.deepEqual(serverInvocation({ execPath: command, entryPath: entry }), {
      command: fs.realpathSync.native(command),
      args: [fs.realpathSync.native(entry)],
    });
    assert.throws(() => serverInvocation({ execPath: "node", entryPath: entry }), /server_invocation_unavailable/u);
    assert.throws(() => serverInvocation({ execPath: command, entryPath: "index.js" }), /server_invocation_unavailable/u);
    const linkedEntry = path.join(directory, "linked-index.js");
    try {
      fs.symlinkSync(entry, linkedEntry, "file");
      assert.throws(() => serverInvocation({ execPath: command, entryPath: linkedEntry }), /server_invocation_unavailable/u);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("clientConfigTarget edits only Codex and renders generic configuration", () => {
  assert.deepEqual(clientConfigTarget("codex", ENV, "linux", INVOCATION), {
    kind: "file",
    format: "toml",
    path: path.join("/home/tester", ".codex", "config.toml"),
  });
  const generic = clientConfigTarget("generic", ENV, "linux", INVOCATION);
  assert.equal(generic.kind, "manual");
  assert.match(generic.command, new RegExp(escapeRegex(serializedString(INVOCATION.command))));
  assert.match(generic.command, new RegExp(escapeRegex(serializedString(INVOCATION.args[0]))));
  assert.throws(
    () => clientConfigTarget("retired-client" as never, ENV, "linux", INVOCATION),
    /unsupported_install_client/u,
  );
});

test("Codex install appends, conflicts, and force-replaces one exact local table", () => {
  const existing = "[mcp_servers.other]\ncommand = \"node\"\n";
  const created = planClientInstall({ client: "codex", existing, env: ENV, platform: "linux", invocation: INVOCATION });
  assert.equal(created.action, "create");
  assert.match(created.nextContent ?? "", /\[mcp_servers\.newton-browser\]/u);
  assert.match(created.nextContent ?? "", new RegExp(escapeRegex(serializedString(INVOCATION.command))));
  assert.equal((created.nextContent ?? "").includes("npx"), false);
  assert.equal((created.nextContent ?? "").includes("--package"), false);

  const conflict = planClientInstall({ client: "codex", existing: created.nextContent, env: ENV, platform: "linux", invocation: INVOCATION });
  assert.equal(conflict.action, "conflict");
  const forced = planClientInstall({
    client: "codex",
    existing: `${created.nextContent}[other]\nx = 1\n`,
    env: ENV,
    platform: "linux",
    invocation: { command: INVOCATION.command, args: [path.resolve("fixtures", "replacement.js")] },
    force: true,
  });
  assert.equal(forced.action, "update");
  assert.match(forced.nextContent ?? "", /replacement\.js/u);
  assert.match(forced.nextContent ?? "", /\[other\]/u);
});

test("runInstall writes a backup, while dry-run and generic mode do not write", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "newton-install-"));
  const env = { ...ENV, HOME: directory, USERPROFILE: directory };
  const target = path.join(directory, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "[mcp_servers.other]\ncommand = \"node\"\n", "utf8");

  const dry = runInstall({ client: "codex", env, platform: "linux", dryRun: true, invocation: INVOCATION });
  assert.equal(dry.wrote, false);
  assert.equal(fs.readFileSync(target, "utf8").includes("newton-browser"), false);

  const applied = runInstall({ client: "codex", env, platform: "linux", invocation: INVOCATION });
  assert.equal(applied.wrote, true);
  assert.ok(applied.backupPath && fs.existsSync(applied.backupPath));
  assert.match(fs.readFileSync(target, "utf8"), /\[mcp_servers\.newton-browser\]/u);

  const generic = runInstall({ client: "generic", env, platform: "linux", invocation: INVOCATION });
  assert.equal(generic.wrote, false);
  assert.equal(generic.action, "manual");
  assert.match(generic.manualCommand ?? "", new RegExp(escapeRegex(serializedString(INVOCATION.command))));
  fs.rmSync(directory, { recursive: true, force: true });
});

test("runInstall refuses linked config targets", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "newton-install-link-"));
  const env = { ...ENV, HOME: directory, USERPROFILE: directory };
  const targetDirectory = path.join(directory, ".codex");
  const outside = path.join(directory, "outside.toml");
  const target = path.join(targetDirectory, "config.toml");
  fs.mkdirSync(targetDirectory, { recursive: true });
  fs.writeFileSync(outside, "preserve");
  try {
    try { fs.symlinkSync(outside, target, "file"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(String((error as NodeJS.ErrnoException).code))) {
        context.skip("file links unavailable");
        return;
      }
      throw error;
    }
    assert.throws(() => runInstall({ client: "codex", env, platform: "linux", invocation: INVOCATION }), /unsafe_client_config_path/u);
    assert.equal(fs.readFileSync(outside, "utf8"), "preserve");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function serializedString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
