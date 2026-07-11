import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const version = JSON.parse(fs.readFileSync("apps/mcp-server/package.json", "utf8")).version;
const entry = path.resolve("apps/mcp-server/dist/index.js");
const zip = path.resolve(`artifacts/newton-browser-extension-${version}.zip`);
const checksumFile = `${zip}.sha256`;
const tarball = path.resolve(`artifacts/newton-browser-${version}.tgz`);
if (!fs.existsSync(entry) || !fs.existsSync(zip) || !fs.existsSync(checksumFile) || !fs.existsSync(tarball)) throw new Error("build and extension artifacts are required before matrix smoke");

const currentVersion = run(process.execPath, ["--version"]).stdout.trim();
const node24Version = run("npx", ["--yes", "node@24", "--version"]).stdout.trim();
if (!/^v24\./.test(node24Version)) throw new Error(`Node 24 probe failed: ${node24Version}`);
if (run("npx", ["--yes", "node@24", entry, "--version"]).stdout.trim() !== version) throw new Error("packed executable is not Node 24 compatible");
// Note: `npx --package <local-tarball> <bin>` is deliberately not exercised here. That
// npx mode installs from a local file path and, on the Linux CI runner, exits 0 with no
// stdout regardless of the forwarded args — a platform quirk of local-tarball npx, not a
// defect in the packed bin. Tarball install-and-run is authoritatively gated by
// `pnpm pack:check` (npm-installs the tarball and runs its bin via node, across Node
// 20/22/24). The user-facing registry path (`npx -y newton-browser`) is validated once
// the package is published. Node 24 compatibility of the built entry is covered above.

for (const target of ["codex", "claude-desktop", "claude-code", "generic"]) {
  const output = run(process.execPath, [entry, "--print-config", target]).stdout;
  if (!output.includes(`newton-browser@${version}`)) throw new Error(`${target} config is not version-pinned`);
  if (target === "codex" && !output.includes("[mcp_servers.newton-browser]")) throw new Error("Codex output must be TOML");
  if (target !== "codex") JSON.parse(output);
}

const doctorRoot = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-doctor-"));
try {
  const output = run(process.execPath, [entry, "--doctor"], { env: { ...process.env, NEWTON_BROWSER_CONFIG_DIR: doctorRoot } }).stdout;
  const doctor = JSON.parse(output);
  if (!doctor.ok || doctor.ready !== false || doctor.authMode !== "local_trust" || doctor.pairingState !== "not_required" || "pairingSecret" in doctor) throw new Error("zero-touch doctor output is incomplete");
  if (!doctor.checks?.node?.ok || !doctor.checks?.config?.ok || !doctor.checks?.loopback?.ok || !doctor.checks?.protocol?.ok || doctor.checks?.transportAuth?.mode !== "local_trust") throw new Error("doctor checks are incomplete");
  if (doctor.checks?.extension?.state !== "no_running_host" || doctor.nextAction !== "start_or_restart_mcp_client_then_check_browser_status") throw new Error("doctor setup guidance is not actionable");
  fs.writeFileSync(path.join(doctorRoot, "config.json"), '{"transportAuth":"paired"}\n');
  const hardened = JSON.parse(run(process.execPath, [entry, "--doctor"], { env: { ...process.env, NEWTON_BROWSER_CONFIG_DIR: doctorRoot } }).stdout);
  if (hardened.authMode !== "paired" || hardened.pairingState !== "configured" || typeof hardened.pairingSecret !== "string" || hardened.pairingSecret.length !== 43) throw new Error("hardened pairing doctor output is incomplete");
} finally {
  fs.rmSync(doctorRoot, { recursive: true, force: true });
}

const expected = fs.readFileSync(checksumFile, "utf8").trim().split(/\s+/)[0];
const actual = createHash("sha256").update(fs.readFileSync(zip)).digest("hex");
if (expected !== actual) throw new Error("extension checksum mismatch");
run(process.execPath, ["scripts/build-extension-artifact.mjs"]);
const rebuilt = createHash("sha256").update(fs.readFileSync(zip)).digest("hex");
if (rebuilt !== actual) throw new Error("extension artifact is not deterministic");
// List the extension ZIP with a small cross-platform reader. `tar -tf` reads ZIPs with
// bsdtar (Windows/macOS) but GNU tar (Linux) rejects them ("not a tar archive"), so
// parse the ZIP central directory in Node instead.
const archive = zipEntryNames(zip);
for (const file of ["manifest.json", "dist/src/service-worker.js", "dist/src/vendor/newton-browser-driver/driver.js"]) if (!archive.includes(file)) throw new Error(`extension archive missing ${file}`);
for (const example of ["codex.toml", "claude-desktop.json", "claude-code.json", "generic.json"]) {
  if (!fs.readFileSync(path.join("examples", "mcp", example), "utf8").includes(`newton-browser-${version}.tgz`)) throw new Error(`${example} is not artifact-version-pinned`);
}

const browsers = process.platform === "win32" ? {
  chrome: fileVersion("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"),
  edge: fileVersion("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"),
} : { chrome: "not-probed", edge: "not-probed" };
process.stdout.write(`${JSON.stringify({ ok: true, node: currentVersion, node24: node24Version, clients: ["codex", "claude-desktop", "claude-code", "generic"], browsers })}\n`);

// List the filenames in a ZIP by parsing its central directory. Cross-platform and
// dependency-free, unlike shelling out to `tar`/`unzip` (which vary by OS).
function zipEntryNames(zipPath) {
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error(`not a zip archive: ${zipPath}`);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const nameLen = buf.readUInt16LE(off + 28);
    names.push(buf.toString("utf8", off + 46, off + 46 + nameLen));
    off += 46 + nameLen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
  }
  return names;
}

// Resolve node's bundled npx CLI cross-platform (beside node.exe on Windows;
// ../lib/node_modules/npm on Linux/macOS).
function nodeCli(name) {
  const bin = path.dirname(process.execPath);
  const candidates = [path.join(bin, "node_modules", "npm", "bin", name), path.join(bin, "..", "lib", "node_modules", "npm", "bin", name)];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function fileVersion(file) {
  if (!fs.existsSync(file)) return "not-installed";
  return run("powershell.exe", ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${file.replaceAll("'", "''")}').VersionInfo.FileVersion`]).stdout.trim();
}

function run(command, args, { env = process.env } = {}) {
  const executable = command === "npx" ? process.execPath : command;
  const commandArgs = command === "npx" ? [nodeCli("npx-cli.js"), ...args] : args;
  const result = spawnSync(executable, commandArgs, { cwd: root, env, encoding: "utf8", stdio: "pipe", windowsHide: true, timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr}`);
  return result;
}
