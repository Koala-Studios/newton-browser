import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const version = JSON.parse(fs.readFileSync("apps/mcp-server/package.json", "utf8")).version;
const artifacts = path.join(root, "artifacts");
const tarball = path.join(artifacts, `browser-bridge-mcp-${version}.tgz`);
fs.mkdirSync(artifacts, { recursive: true });
fs.rmSync(tarball, { force: true });

run("pnpm", ["build:mcp"]);
run("pnpm", ["pack", "--pack-destination", artifacts], { cwd: path.join(root, "apps", "mcp-server") });
if (!fs.existsSync(tarball)) throw new Error(`missing packed artifact: ${tarball}`);
const listing = run("tar", ["-tf", tarball], { capture: true }).stdout.trim().split(/\r?\n/);
for (const required of ["package/dist/index.js", "package/package.json", "package/README.md"]) {
  if (!listing.includes(required)) throw new Error(`packed artifact missing ${required}`);
}
for (const file of listing) {
  if (/\.(?:ts|map\.ts)$/.test(file) || /node_modules|packages\/core|src\//.test(file)) throw new Error(`packed artifact leaks workspace source: ${file}`);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "browser-bridge pack check with spaces "));
try {
  fs.writeFileSync(path.join(temp, "package.json"), '{"name":"packed-check","private":true}');
  run("npm", ["install", "--ignore-scripts", tarball], { cwd: temp });
  const entry = path.join(temp, "node_modules", "browser-bridge-mcp", "dist", "index.js");
  const versionResult = run(process.execPath, [entry, "--version"], { cwd: temp, capture: true }).stdout.trim();
  if (versionResult !== version) throw new Error(`packed version mismatch: ${versionResult}`);
  const config = run(process.execPath, [entry, "--print-config", "codex"], { cwd: temp, capture: true }).stdout;
  if (!config.includes("[mcp_servers.browser-bridge]") || !config.includes(`browser-bridge-mcp@${version}`)) throw new Error("packed Codex config is not version-pinned");
  run(process.execPath, [path.join(root, "scripts", "smoke", "packed-stdio.mjs"), "--entry", entry, "--config-dir", path.join(temp, "config"), "--port", "18631"], { cwd: root });
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify({ ok: true, tarball, files: listing.length, installPathWithSpaces: true })}\n`);

function run(command, args, { cwd = root, capture = false } = {}) {
  const manager = packageManagerCommand(command, args);
  const result = spawnSync(manager.command, manager.args, { cwd, env: cleanPackageManagerEnv(), encoding: "utf8", stdio: capture ? "pipe" : "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${result.stderr ?? ""}`);
  return result;
}

function packageManagerCommand(command, args) {
  if (command === "pnpm" && process.env.npm_execpath) return { command: process.execPath, args: [process.env.npm_execpath, ...args] };
  if (command === "npm") return { command: process.execPath, args: [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), ...args] };
  return { command, args };
}

function cleanPackageManagerEnv() {
  const env = { ...process.env };
  delete env.npm_config_verify_deps_before_run;
  env.npm_config_update_notifier = "false";
  return env;
}
