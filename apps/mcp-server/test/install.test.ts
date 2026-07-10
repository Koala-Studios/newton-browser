import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { clientConfigTarget, planClientInstall, runInstall, serverInvocation } from "../src/install.ts";

const ENV = { NEWTON_BROWSER_PACKAGE_SPEC: "newton-browser@9.9.9", HOME: "/home/tester", USERPROFILE: "/home/tester" };

test("serverInvocation honors an explicit package spec", () => {
  const invocation = serverInvocation(ENV);
  assert.deepEqual(invocation, { command: "npx", args: ["--yes", "--package", "newton-browser@9.9.9", "newton-browser"] });
});

test("clientConfigTarget resolves per-client, per-OS paths", () => {
  assert.deepEqual(clientConfigTarget("codex", ENV, "linux"), {
    kind: "file",
    format: "toml",
    path: path.join("/home/tester", ".codex", "config.toml"),
  });
  const win = clientConfigTarget("claude-desktop", { ...ENV, APPDATA: "C:/Users/t/AppData/Roaming" }, "win32");
  assert.equal(win.kind, "file");
  assert.ok(win.kind === "file" && win.path.includes(path.join("Claude", "claude_desktop_config.json")));
  const mac = clientConfigTarget("claude-desktop", ENV, "darwin");
  assert.ok(mac.kind === "file" && mac.path.includes(path.join("Library", "Application Support", "Claude")));
  const linux = clientConfigTarget("claude-desktop", ENV, "linux");
  assert.ok(linux.kind === "file" && linux.path.includes(path.join(".config", "Claude")));
  const code = clientConfigTarget("claude-code", ENV, "linux");
  assert.ok(code.kind === "manual" && code.command.startsWith("claude mcp add-json newton-browser"));
  assert.equal(clientConfigTarget("generic", ENV, "linux").kind, "manual");
});

test("codex install appends a table to an existing config", () => {
  const existing = "[mcp_servers.other]\ncommand = \"node\"\n";
  const plan = planClientInstall({ client: "codex", existing, env: ENV, platform: "linux" });
  assert.equal(plan.action, "create");
  assert.ok(plan.nextContent?.includes("[mcp_servers.other]"));
  assert.ok(plan.nextContent?.includes("[mcp_servers.newton-browser]"));
  assert.ok(plan.nextContent?.includes("--package"));
});

test("codex install into an empty file has no leading blank line", () => {
  const plan = planClientInstall({ client: "codex", existing: undefined, env: ENV, platform: "linux" });
  assert.equal(plan.action, "create");
  assert.ok(plan.nextContent?.startsWith("[mcp_servers.newton-browser]"));
});

test("codex install refuses to overwrite without --force, replaces with it", () => {
  const existing = "[mcp_servers.newton-browser]\ncommand = \"old\"\nargs = []\n\n[other]\nx = 1\n";
  const conflict = planClientInstall({ client: "codex", existing, env: ENV, platform: "linux" });
  assert.equal(conflict.action, "conflict");
  assert.equal(conflict.entryExists, true);
  const forced = planClientInstall({ client: "codex", existing, env: ENV, platform: "linux", force: true });
  assert.equal(forced.action, "update");
  assert.ok(forced.nextContent?.includes("[other]"));
  assert.ok(forced.nextContent?.includes("--package"));
  assert.ok(!forced.nextContent?.includes("command = \"old\""));
});

test("claude-desktop install merges into mcpServers without dropping siblings", () => {
  const existing = JSON.stringify({ mcpServers: { keep: { command: "x" } }, otherTop: true });
  const plan = planClientInstall({ client: "claude-desktop", existing, env: ENV, platform: "linux" });
  assert.equal(plan.action, "create");
  const parsed = JSON.parse(plan.nextContent!);
  assert.equal(parsed.otherTop, true);
  assert.deepEqual(parsed.mcpServers.keep, { command: "x" });
  assert.equal(parsed.mcpServers["newton-browser"].command, "npx");
});

test("claude-desktop install conflicts on an existing entry unless forced", () => {
  const existing = JSON.stringify({ mcpServers: { "newton-browser": { command: "stale" } } });
  assert.equal(planClientInstall({ client: "claude-desktop", existing, env: ENV, platform: "linux" }).action, "conflict");
  const forced = planClientInstall({ client: "claude-desktop", existing, env: ENV, platform: "linux", force: true });
  assert.equal(forced.action, "update");
  assert.equal(JSON.parse(forced.nextContent!).mcpServers["newton-browser"].command, "npx");
});

test("unparseable JSON is reported, not clobbered", () => {
  const plan = planClientInstall({ client: "claude-desktop", existing: "{ not json", env: ENV, platform: "linux" });
  assert.equal(plan.action, "conflict");
  assert.match(plan.message, /client_config_unparseable/);
});

test("runInstall writes a backup and the merged file, dry run writes nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "newton-install-"));
  const env = { ...ENV, HOME: dir, USERPROFILE: dir };
  const target = path.join(dir, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "[mcp_servers.other]\ncommand = \"node\"\n", "utf8");

  const dry = runInstall({ client: "codex", env, platform: "linux", dryRun: true });
  assert.equal(dry.wrote, false);
  assert.equal(fs.readFileSync(target, "utf8").includes("newton-browser"), false);

  const applied = runInstall({ client: "codex", env, platform: "linux" });
  assert.equal(applied.wrote, true);
  assert.ok(applied.backupPath && fs.existsSync(applied.backupPath));
  assert.ok(fs.readFileSync(target, "utf8").includes("[mcp_servers.newton-browser]"));
  assert.ok(fs.readFileSync(applied.backupPath!, "utf8").includes("[mcp_servers.other]"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("manual clients never write and surface a command", () => {
  const result = runInstall({ client: "claude-code", env: ENV, platform: "linux" });
  assert.equal(result.wrote, false);
  assert.equal(result.action, "manual");
  assert.ok(result.manualCommand?.includes("claude mcp add-json"));
});
