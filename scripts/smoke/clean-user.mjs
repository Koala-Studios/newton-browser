import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const version = JSON.parse(fs.readFileSync("apps/mcp-server/package.json", "utf8")).version;
const tarball = path.resolve(`artifacts/browser-bridge-mcp-${version}.tgz`);
const extensionZip = path.resolve(`artifacts/browser-bridge-extension-${version}.zip`);
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "browser-bridge-clean-user-"));
const install = path.join(isolated, "Local App", "mcp");
const env = {
  ...process.env,
  HOME: path.join(isolated, "home"),
  USERPROFILE: path.join(isolated, "profile"),
  LOCALAPPDATA: path.join(isolated, "local"),
  APPDATA: path.join(isolated, "roaming"),
  XDG_CONFIG_HOME: path.join(isolated, "config"),
  npm_config_cache: path.join(isolated, "npm-cache"),
  BROWSER_BRIDGE_CONFIG_DIR: path.join(isolated, "bridge-config"),
};

try {
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(path.join(install, "package.json"), '{"name":"clean-user-proof","private":true}');
  run("npm", ["install", "--ignore-scripts", tarball], install, env, false);
  const entry = path.join(install, "node_modules", "browser-bridge-mcp", "dist", "index.js");
  if (run(process.execPath, [entry, "--version"], isolated, env, true).stdout.trim() !== version) throw new Error("clean-user version mismatch");
  const doctor = JSON.parse(run(process.execPath, [entry, "--doctor"], isolated, env, true).stdout);
  if (!doctor.ok || doctor.pairingState !== "configured") throw new Error("clean-user doctor failed");
  if (!fs.existsSync(path.join(env.BROWSER_BRIDGE_CONFIG_DIR, "pairing.json"))) throw new Error("clean-user pairing config missing");
  const extract = path.join(isolated, "extension");
  run("tar", ["-xf", extensionZip, "-C", mkdir(extract)], isolated, env, false);
  if (!fs.existsSync(path.join(extract, "manifest.json"))) throw new Error("clean-user extension extraction failed");
  run(process.execPath, [path.join(root, "scripts", "smoke", "packed-stdio.mjs"), "--entry", entry, "--config-dir", env.BROWSER_BRIDGE_CONFIG_DIR, "--port", "18651"], isolated, env, false);
  process.stdout.write(`${JSON.stringify({ ok: true, isolatedProfile: true, sourceCheckoutCwd: false, globalInstall: false, artifacts: 2 })}\n`);
} finally {
  fs.rmSync(isolated, { recursive: true, force: true });
}

function mkdir(directory) { fs.mkdirSync(directory, { recursive: true }); return directory; }
function run(command, args, cwd, environment, capture) {
  const useShell = process.platform === "win32" && command === "npm";
  const result = spawnSync(command, args, { cwd, env: environment, encoding: "utf8", stdio: capture ? "pipe" : "inherit", windowsHide: true, timeout: 120_000, shell: useShell });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ""}`);
  return result;
}
