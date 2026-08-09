import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
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
const smokePort = 18651;

try {
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(path.join(install, "package.json"), '{"name":"clean-user-proof","private":true}');
  run(process.execPath, [nodeCli("npm-cli.js"), "install", "--ignore-scripts", tarball], install, cleanPackageManagerEnv(env), false);
  const entry = path.join(install, "node_modules", "newton-browser", "dist", "index.js");
  if (run(process.execPath, [entry, "--version"], isolated, env, true).stdout.trim() !== version) throw new Error("clean-user version mismatch");
  const doctor = JSON.parse(run(process.execPath, [entry, "--doctor"], isolated, env, true).stdout);
  if (!doctor.ok || doctor.ready !== false || doctor.authMode !== "local_trust" || doctor.pairingState !== "not_required" || "pairingSecret" in doctor) throw new Error("clean-user zero-touch doctor failed");
  if (!doctor.checks?.node?.ok || !doctor.checks?.config?.ok || !doctor.checks?.loopback?.ok || !doctor.checks?.protocol?.ok || doctor.checks?.transportAuth?.mode !== "local_trust" || doctor.checks?.extension?.state !== "no_running_host") throw new Error("clean-user doctor checks are incomplete");
  if (!fs.existsSync(path.join(env.NEWTON_BROWSER_CONFIG_DIR, "pairing.json"))) throw new Error("clean-user diagnostic credential missing");
  // Verify the extension artifact is a well-formed ZIP containing the manifest. We list
  // the central directory in Node rather than shelling to `tar -xf` (GNU tar on Linux
  // cannot read ZIPs).
  if (!zipEntryNames(extensionZip).includes("manifest.json")) throw new Error("clean-user extension artifact missing manifest.json");
  run(process.execPath, [path.join(root, "scripts", "smoke", "packed-stdio.mjs"), "--entry", entry, "--config-dir", env.NEWTON_BROWSER_CONFIG_DIR, "--port", String(smokePort)], isolated, env, false);
  await assertPortReusable(smokePort);
  const residue = fs.readdirSync(env.NEWTON_BROWSER_CONFIG_DIR, { recursive: true })
    .map(String)
    .filter((entryName) => /(?:\.tmp$|observer|binding|session)/i.test(entryName));
  if (residue.length > 0) throw new Error(`clean-user runtime residue: ${residue.join(",")}`);
  process.stdout.write(`${JSON.stringify({ ok: true, isolatedProfile: true, sourceCheckoutCwd: false, globalInstall: false, zeroTouch: true, artifacts: 2, portReleased: true, runtimeResidue: 0 })}\n`);
} finally {
  fs.rmSync(isolated, { recursive: true, force: true });
}

function mkdir(directory) { fs.mkdirSync(directory, { recursive: true }); return directory; }
// List the filenames in a ZIP by parsing its central directory (cross-platform,
// dependency-free — GNU tar on Linux cannot read ZIPs).
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
// Resolve node's bundled npm CLI cross-platform (npm sits beside node.exe on Windows,
// under ../lib/node_modules/npm on Linux/macOS).
function nodeCli(name) {
  const bin = path.dirname(process.execPath);
  const candidates = [path.join(bin, "node_modules", "npm", "bin", name), path.join(bin, "..", "lib", "node_modules", "npm", "bin", name)];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}
function cleanPackageManagerEnv(input) { const output = { ...input, npm_config_update_notifier: "false" }; delete output.npm_config_verify_deps_before_run; return output; }
function assertPortReusable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
  });
}
function run(command, args, cwd, environment, capture) {
  const result = spawnSync(command, args, { cwd, env: environment, encoding: "utf8", stdio: capture ? "pipe" : "inherit", windowsHide: true, timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ""}`);
  return result;
}
