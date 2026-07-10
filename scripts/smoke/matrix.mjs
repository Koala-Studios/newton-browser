import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const version = JSON.parse(fs.readFileSync("apps/mcp-server/package.json", "utf8")).version;
const entry = path.resolve("apps/mcp-server/dist/index.js");
const zip = path.resolve(`artifacts/browser-bridge-extension-${version}.zip`);
const checksumFile = `${zip}.sha256`;
const tarball = path.resolve(`artifacts/browser-bridge-mcp-${version}.tgz`);
if (!fs.existsSync(entry) || !fs.existsSync(zip) || !fs.existsSync(checksumFile) || !fs.existsSync(tarball)) throw new Error("build and extension artifacts are required before matrix smoke");

const currentVersion = run(process.execPath, ["--version"]).stdout.trim();
const node24Version = run("npx", ["--yes", "node@24", "--version"]).stdout.trim();
if (!/^v24\./.test(node24Version)) throw new Error(`Node 24 probe failed: ${node24Version}`);
if (run("npx", ["--yes", "node@24", entry, "--version"]).stdout.trim() !== version) throw new Error("packed executable is not Node 24 compatible");
if (run("npx", ["--yes", "--package", tarball, "browser-bridge-mcp", "--version"]).stdout.trim() !== version) throw new Error("private tarball config command failed");

for (const target of ["codex", "claude-desktop", "claude-code", "generic"]) {
  const output = run(process.execPath, [entry, "--print-config", target]).stdout;
  if (!output.includes(`browser-bridge-mcp@${version}`)) throw new Error(`${target} config is not version-pinned`);
  if (target === "codex" && !output.includes("[mcp_servers.browser-bridge]")) throw new Error("Codex output must be TOML");
  if (target !== "codex") JSON.parse(output);
}

const doctorRoot = fs.mkdtempSync(path.join(os.tmpdir(), "browser-bridge-doctor-"));
try {
  const output = run(process.execPath, [entry, "--doctor"], { env: { ...process.env, BROWSER_BRIDGE_CONFIG_DIR: doctorRoot } }).stdout;
  const doctor = JSON.parse(output);
  if (!doctor.ok || doctor.pairingState !== "configured" || typeof doctor.pairingSecret !== "string" || doctor.pairingSecret.length < 43) throw new Error("doctor output is incomplete");
} finally {
  fs.rmSync(doctorRoot, { recursive: true, force: true });
}

const expected = fs.readFileSync(checksumFile, "utf8").trim().split(/\s+/)[0];
const actual = createHash("sha256").update(fs.readFileSync(zip)).digest("hex");
if (expected !== actual) throw new Error("extension checksum mismatch");
run(process.execPath, ["scripts/build-extension-artifact.mjs"]);
const rebuilt = createHash("sha256").update(fs.readFileSync(zip)).digest("hex");
if (rebuilt !== actual) throw new Error("extension artifact is not deterministic");
const archive = run("tar", ["-tf", zip]).stdout;
for (const file of ["manifest.json", "dist/src/service-worker.js", "dist/src/vendor/browser-bridge-driver/driver.js"]) if (!archive.includes(file)) throw new Error(`extension archive missing ${file}`);
for (const example of ["codex.toml", "claude-desktop.json", "claude-code.json", "generic.json"]) {
  if (!fs.readFileSync(path.join("examples", "mcp", example), "utf8").includes(`browser-bridge-mcp-${version}.tgz`)) throw new Error(`${example} is not artifact-version-pinned`);
}

const browsers = process.platform === "win32" ? {
  chrome: fileVersion("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"),
  edge: fileVersion("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"),
} : { chrome: "not-probed", edge: "not-probed" };
process.stdout.write(`${JSON.stringify({ ok: true, node: currentVersion, node24: node24Version, clients: ["codex", "claude-desktop", "claude-code", "generic"], browsers })}\n`);

function fileVersion(file) {
  if (!fs.existsSync(file)) return "not-installed";
  return run("powershell.exe", ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${file.replaceAll("'", "''")}').VersionInfo.FileVersion`]).stdout.trim();
}

function run(command, args, { env = process.env } = {}) {
  const useShell = process.platform === "win32" && command === "npx";
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", stdio: "pipe", windowsHide: true, timeout: 120_000, shell: useShell });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr}`);
  return result;
}
