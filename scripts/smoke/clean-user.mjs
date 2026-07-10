import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const version = JSON.parse(fs.readFileSync("apps/mcp-server/package.json", "utf8")).version;
const tarball = path.resolve(`artifacts/newton-browser-${version}.tgz`);
const extensionZip = path.resolve(`artifacts/newton-browser-extension-${version}.zip`);
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-clean-user-"));
const install = path.join(isolated, "Local App", "mcp");
const env = {
  ...process.env,
  HOME: path.join(isolated, "home"),
  USERPROFILE: path.join(isolated, "profile"),
  LOCALAPPDATA: path.join(isolated, "local"),
  APPDATA: path.join(isolated, "roaming"),
  XDG_CONFIG_HOME: path.join(isolated, "config"),
  npm_config_cache: path.join(isolated, "npm-cache"),
  NEWTON_BROWSER_CONFIG_DIR: path.join(isolated, "bridge-config"),
};

try {
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(path.join(install, "package.json"), '{"name":"clean-user-proof","private":true}');
  run(process.execPath, [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), "install", "--ignore-scripts", tarball], install, cleanPackageManagerEnv(env), false);
  const entry = path.join(install, "node_modules", "newton-browser", "dist", "index.js");
  if (run(process.execPath, [entry, "--version"], isolated, env, true).stdout.trim() !== version) throw new Error("clean-user version mismatch");
  const doctor = JSON.parse(run(process.execPath, [entry, "--doctor"], isolated, env, true).stdout);
  if (!doctor.ok || doctor.ready !== false || doctor.authMode !== "local_trust" || doctor.pairingState !== "not_required" || "pairingSecret" in doctor) throw new Error("clean-user zero-touch doctor failed");
  if (!doctor.checks?.node?.ok || !doctor.checks?.config?.ok || !doctor.checks?.loopback?.ok || !doctor.checks?.protocol?.ok || doctor.checks?.transportAuth?.mode !== "local_trust" || doctor.checks?.extension?.state !== "no_running_host") throw new Error("clean-user doctor checks are incomplete");
  if (!fs.existsSync(path.join(env.NEWTON_BROWSER_CONFIG_DIR, "pairing.json"))) throw new Error("clean-user diagnostic credential missing");
  const extract = path.join(isolated, "extension");
  run("tar", ["-xf", extensionZip, "-C", mkdir(extract)], isolated, env, false);
  if (!fs.existsSync(path.join(extract, "manifest.json"))) throw new Error("clean-user extension extraction failed");
  run(process.execPath, [path.join(root, "scripts", "smoke", "packed-stdio.mjs"), "--entry", entry, "--config-dir", env.NEWTON_BROWSER_CONFIG_DIR, "--port", "18651"], isolated, env, false);
  process.stdout.write(`${JSON.stringify({ ok: true, isolatedProfile: true, sourceCheckoutCwd: false, globalInstall: false, zeroTouch: true, artifacts: 2 })}\n`);
} finally {
  fs.rmSync(isolated, { recursive: true, force: true });
}

function mkdir(directory) { fs.mkdirSync(directory, { recursive: true }); return directory; }
function cleanPackageManagerEnv(input) { const output = { ...input, npm_config_update_notifier: "false" }; delete output.npm_config_verify_deps_before_run; return output; }
function run(command, args, cwd, environment, capture) {
  const result = spawnSync(command, args, { cwd, env: environment, encoding: "utf8", stdio: capture ? "pipe" : "inherit", windowsHide: true, timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ""}`);
  return result;
}
