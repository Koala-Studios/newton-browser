import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { clientConfigTarget, planClientInstall, runInstall, serverInvocation, verifyCodexCandidate } from "../src/install.ts";

const ENV = { HOME: "/home/tester", USERPROFILE: "/home/tester" };
const INVOCATION = Object.freeze({
  command: path.resolve("fixtures", "node"),
  args: [path.resolve("fixtures", "newton-browser", "index.js")],
  version: "9.8.7",
});
const VERIFIED = () => ({ compatible: true as const, protocolVersion: "2026-07-28" as const, version: INVOCATION.version, requiredToolCount: 10 });

test("serverInvocation pins one exact local Node entrypoint", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "newton-invocation-"));
  const command = path.join(directory, process.platform === "win32" ? "node.exe" : "node");
  const entryDirectory = path.join(directory, "dist");
  const entry = path.join(entryDirectory, "index.js");
  fs.mkdirSync(entryDirectory);
  fs.writeFileSync(command, "runtime");
  fs.writeFileSync(entry, "entry");
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ version: "1.2.3" }));
  if (process.platform !== "win32") fs.chmodSync(command, 0o700);
  try {
    assert.deepEqual(serverInvocation({ execPath: command, entryPath: entry }), {
      command: fs.realpathSync.native(command),
      args: [fs.realpathSync.native(entry)],
      version: "1.2.3",
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
  assert.match(generic.command, /NEWTON_BROWSER_EXPECTED_VERSION/u);
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
  assert.match(created.nextContent ?? "", /NEWTON_BROWSER_EXPECTED_VERSION = "9\.8\.7"/u);
  assert.match(created.nextContent ?? "", /CODEX_MCP_PROTOCOL_VERSION = "2026-07-28"/u);
  assert.match(created.nextContent ?? "", /\[features\]\nmcp_2026_07_28 = true/u);

  const conflict = planClientInstall({ client: "codex", existing: created.nextContent, env: ENV, platform: "linux", invocation: INVOCATION });
  assert.equal(conflict.action, "conflict");
  const forced = planClientInstall({
    client: "codex",
    existing: `${created.nextContent}[other]\nx = 1\n`,
    env: ENV,
    platform: "linux",
    invocation: { command: INVOCATION.command, args: [path.resolve("fixtures", "replacement.js")], version: "9.8.8" },
    force: true,
  });
  assert.equal(forced.action, "update");
  assert.match(forced.nextContent ?? "", /replacement\.js/u);
  assert.match(forced.nextContent ?? "", /\[other\]/u);

  const disabledFeature = planClientInstall({
    client: "codex",
    existing: "[features]\nmcp_2026_07_28 = false\n\n[mcp_servers.other]\ncommand = \"node\"\n",
    env: ENV,
    platform: "linux",
    invocation: INVOCATION,
  });
  assert.match(disabledFeature.nextContent ?? "", /\[features\]\nmcp_2026_07_28 = true/u);
  assert.equal((disabledFeature.nextContent ?? "").match(/mcp_2026_07_28\s*=/gu)?.length, 1);
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

  const applied = runInstall({ client: "codex", env, platform: "linux", invocation: INVOCATION, verifyCandidate: VERIFIED });
  assert.equal(applied.wrote, true);
  assert.equal(applied.compatibilityVerified, true);
  assert.equal(applied.candidateVersion, "9.8.7");
  assert.ok(applied.backupPath && fs.existsSync(applied.backupPath));
  assert.match(fs.readFileSync(target, "utf8"), /\[mcp_servers\.newton-browser\]/u);

  const generic = runInstall({ client: "generic", env, platform: "linux", invocation: INVOCATION });
  assert.equal(generic.wrote, false);
  assert.equal(generic.action, "manual");
  assert.match(generic.manualCommand ?? "", new RegExp(escapeRegex(serializedString(INVOCATION.command))));
  fs.rmSync(directory, { recursive: true, force: true });
});

test("Codex candidate must complete modern discovery, report its exact version, and expose every required browser tool", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "newton-codex-probe-"));
  try {
    const server = path.join(directory, "server.cjs");
    const toolNames = [
      "browser.status", "browser.session.start", "browser.observe", "browser.act",
      "browser.screenshot", "browser.console", "browser.network", "browser.sessions.list",
      "browser.session.stop", "browser.stop_all",
    ];
    fs.writeFileSync(server, [
      "const readline=require('node:readline');",
      "if(process.env.CODEX_MCP_PROTOCOL_VERSION!=='2026-07-28'||!process.env.NEWTON_BROWSER_CONFIG_DIR)process.exit(2);",
      "const rl=readline.createInterface({input:process.stdin});",
      "rl.on('line',(line)=>{",
      "const request=JSON.parse(line);",
      "const meta=request.params&&request.params._meta;",
      "if(!meta||meta['io.modelcontextprotocol/protocolVersion']!=='2026-07-28')process.exit(3);",
      `if(request.id===1)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{supportedVersions:['2026-07-28'],_meta:{'io.modelcontextprotocol/serverInfo':{name:'newton-browser',version:'9.8.7'}}}})+'\\n');`,
      `if(request.id===2)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:2,result:{tools:${JSON.stringify(toolNames.map((name) => ({ name })))}}})+'\\n');`,
      "});",
    ].join("\n"));
    const invocation = { command: process.execPath, args: [server], version: "9.8.7" };
    assert.deepEqual(verifyCodexCandidate(invocation), {
      compatible: true,
      protocolVersion: "2026-07-28",
      version: "9.8.7",
      requiredToolCount: 10,
    });
    fs.writeFileSync(server, [
      "const readline=require('node:readline');",
      "const rl=readline.createInterface({input:process.stdin});",
      "rl.on('line',(line)=>{const request=JSON.parse(line);",
      "if(request.id===1)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{supportedVersions:['2026-07-28'],_meta:{'io.modelcontextprotocol/serverInfo':{name:'newton-browser',version:'old'}}}})+'\\n');",
      "if(request.id===2)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:2,result:{tools:[]}})+'\\n');});",
    ].join("\n"));
    assert.throws(() => verifyCodexCandidate(invocation), /codex_mcp_candidate_incompatible/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
