import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildDeterministicPackageTarball } from "./deterministic-pack.mjs";

const root = process.cwd();
const TEMP_PREFIX = "newton-browser pack check with spaces ";
const OWNER_MARKER = ".newton-browser-pack-check-owner";
const ownedTempRoots = new Map();

export function createPackCheckTempRoot() {
  const temporaryDirectory = fs.realpathSync.native(os.tmpdir());
  const created = fs.mkdtempSync(path.join(temporaryDirectory, TEMP_PREFIX));
  const resolved = fs.realpathSync.native(created);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(resolved) !== temporaryDirectory) throw new Error("invalid pack-check temporary root");
  const nonce = randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(resolved, OWNER_MARKER), nonce, { encoding: "utf8", flag: "wx", mode: 0o600 });
  ownedTempRoots.set(path.resolve(created), { resolved, temporaryDirectory, nonce, dev: stat.dev, ino: stat.ino });
  return created;
}

export function isolatedPackCheckEnvironment(tempRoot, source = process.env) {
  const resolvedRoot = validatePackCheckTempRoot(tempRoot);
  const directories = {
    HOME: path.join(resolvedRoot, "home"),
    USERPROFILE: path.join(resolvedRoot, "profile"),
    LOCALAPPDATA: path.join(resolvedRoot, "local"),
    APPDATA: path.join(resolvedRoot, "roaming"),
    XDG_CONFIG_HOME: path.join(resolvedRoot, "xdg-config"),
    NEWTON_BROWSER_CONFIG_DIR: path.join(resolvedRoot, "newton-config"),
  };
  for (const directory of Object.values(directories)) {
    assertOwnedBy(resolvedRoot, directory);
    fs.mkdirSync(directory, { recursive: true });
  }
  return { ...source, ...directories };
}

export function cleanupPackCheckTempRoot(tempRoot) {
  const key = path.resolve(tempRoot);
  const resolved = validatePackCheckTempRoot(key);
  fs.rmSync(resolved, { recursive: true, force: true });
  ownedTempRoots.delete(key);
}

export function packCheck() {
  const version = JSON.parse(fs.readFileSync("apps/mcp-server/package.json", "utf8")).version;
  const artifacts = path.join(root, "artifacts");
  const tarball = path.join(artifacts, `newton-browser-${version}.tgz`);
  fs.mkdirSync(artifacts, { recursive: true });
  fs.rmSync(tarball, { force: true });

  // Build core first: the mcp bundle resolves @newton-browser/core through its package
  // exports (dist), which do not exist on a clean checkout until core is built.
  run("pnpm", ["build:core"]);
  run("pnpm", ["build:mcp"]);
  const packed = buildDeterministicPackageTarball({
    packageRoot: path.join(root, "apps", "mcp-server"),
    licensePath: path.join(root, "LICENSE"),
    tarball,
  });
  if (!fs.existsSync(tarball)) throw new Error(`missing packed artifact: ${tarball}`);
  const listing = run("tar", ["-tf", tarball], { capture: true }).stdout.trim().split(/\r?\n/);
  for (const required of ["package/dist/index.js", "package/dist/browser-guardian.js", "package/package.json", "package/README.md"]) {
    if (!listing.includes(required)) throw new Error(`packed artifact missing ${required}`);
  }
  for (const file of listing) {
    if (/\.(?:ts|map)$/u.test(file) || /node_modules|packages\/core|src\//u.test(file)) throw new Error(`packed artifact leaks workspace source: ${file}`);
  }

  const temp = createPackCheckTempRoot();
  try {
    const isolatedEnv = isolatedPackCheckEnvironment(temp);
    fs.writeFileSync(path.join(temp, "package.json"), '{"name":"packed-check","private":true}');
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--offline", tarball], { cwd: temp, env: isolatedEnv });
    const entry = path.join(temp, "node_modules", "newton-browser", "dist", "index.js");
    const versionResult = run(process.execPath, [entry, "--version"], { cwd: temp, capture: true, env: isolatedEnv }).stdout.trim();
    if (versionResult !== version) throw new Error(`packed version mismatch: ${versionResult}`);
    const linkedPackage = path.join(temp, "linked-newton-browser");
    fs.symlinkSync(path.dirname(path.dirname(entry)), linkedPackage, process.platform === "win32" ? "junction" : "dir");
    const linkedVersion = run(process.execPath, [path.join(linkedPackage, "dist", "index.js"), "--version"], { cwd: temp, capture: true, env: isolatedEnv }).stdout.trim();
    if (linkedVersion !== version) throw new Error(`symlinked packed version mismatch: ${linkedVersion}`);
    const help = run(process.execPath, [entry, "--help"], { cwd: temp, capture: true, env: isolatedEnv }).stdout;
    if (!help.includes("setup --browser") || !help.includes("identity login <identity-id>") || !help.includes("doctor --live")) {
      throw new Error("packed direct setup help is incomplete");
    }
    const doctorResult = run(process.execPath, [entry, "doctor"], { cwd: temp, capture: true, env: isolatedEnv }).stdout.trim();
    const doctor = JSON.parse(doctorResult);
    if (doctor?.checks?.node?.ok !== true || doctor?.version !== version
      || doctor?.architecture !== "owned_process_private_cdp") {
      throw new Error("packed doctor report is invalid");
    }
    const config = run(process.execPath, [entry, "install", "generic"], { cwd: temp, capture: true, env: isolatedEnv }).stdout;
    if (!config.includes(JSON.stringify(fs.realpathSync(process.execPath)))
      || !config.includes(JSON.stringify(fs.realpathSync(entry))) || config.includes("npx")) {
      throw new Error("packed generic installer does not pin the exact local runtime and entrypoint");
    }
    run(process.execPath, [path.join(root, "scripts", "smoke", "packed-mcp-catalog.mjs"), "--entry", entry], { cwd: root, env: isolatedEnv });
  } finally {
    cleanupPackCheckTempRoot(temp);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, tarball, files: listing.length, bytes: packed.bytes, sha256: packed.sha256, deterministicArchive: true, installPathWithSpaces: true, symlinkedEntrypoint: true, isolatedConfig: true })}\n`);
}

function validatePackCheckTempRoot(tempRoot) {
  const key = path.resolve(tempRoot);
  const ownership = ownedTempRoots.get(key);
  if (!ownership) throw new Error("invalid pack-check temporary root");
  const temporaryDirectory = fs.realpathSync.native(os.tmpdir());
  const stat = fs.lstatSync(key);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid pack-check temporary root");
  const resolved = fs.realpathSync.native(key);
  const marker = path.join(resolved, OWNER_MARKER);
  const markerStat = fs.lstatSync(marker);
  const validIdentity = temporaryDirectory === ownership.temporaryDirectory
    && resolved === ownership.resolved
    && path.dirname(resolved) === temporaryDirectory
    && path.basename(resolved).startsWith(TEMP_PREFIX)
    && stat.dev === ownership.dev
    && stat.ino === ownership.ino
    && markerStat.isFile()
    && !markerStat.isSymbolicLink()
    && fs.readFileSync(marker, "utf8") === ownership.nonce;
  if (!validIdentity) {
    throw new Error("invalid pack-check temporary root");
  }
  return resolved;
}

function assertOwnedBy(rootDirectory, candidate) {
  const relative = path.relative(rootDirectory, path.resolve(candidate));
  if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) || relative === "..") throw new Error("pack-check path escapes temporary root");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) packCheck();

function run(command, args, { cwd = root, capture = false, env = process.env } = {}) {
  const manager = packageManagerCommand(command, args);
  const result = spawnSync(manager.command, manager.args, { cwd, env: cleanPackageManagerEnv(env), encoding: "utf8", stdio: capture ? "pipe" : "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${result.stderr ?? ""}`);
  return result;
}

function packageManagerCommand(command, args) {
  if (command === "pnpm" && process.env.npm_execpath) return { command: process.execPath, args: [process.env.npm_execpath, ...args] };
  if (command === "npm") return { command: process.execPath, args: [nodeCli("npm-cli.js"), ...args] };
  return { command, args };
}

// Resolve Node's bundled npm CLI cross-platform. On Windows npm sits beside
// node.exe (node_modules/npm); on Linux/macOS node is in bin/ and npm is in
// ../lib/node_modules/npm. Check both and fall back to the first candidate.
function nodeCli(name) {
  const bin = path.dirname(process.execPath);
  const candidates = [
    path.join(bin, "node_modules", "npm", "bin", name),
    path.join(bin, "..", "lib", "node_modules", "npm", "bin", name),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function cleanPackageManagerEnv(input) {
  const env = { ...input };
  delete env.npm_config_verify_deps_before_run;
  env.npm_config_update_notifier = "false";
  return env;
}
