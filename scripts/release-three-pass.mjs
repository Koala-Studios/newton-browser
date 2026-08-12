import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const platformReceipt = `release-verification-${process.platform}.json`;
const packageManifest = readJson(path.join(root, "apps", "mcp-server", "package.json"));
const packageVersion = packageManifest.version;
if (typeof packageVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packageVersion)) {
  throw new Error("release_package_version_invalid");
}
assertCleanCandidate();

const passes = [];
for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
  process.stdout.write(`release verification pass ${ordinal}/3\n`);
  const receipt = await runReleasePass();
  if (receipt?.ok !== true || receipt?.sourceUnchanged !== true
    || receipt?.platform !== process.platform
    || typeof receipt?.sourceDigest !== "string" || !/^[a-f0-9]{64}$/u.test(receipt.sourceDigest)
    || typeof receipt?.artifactSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(receipt.artifactSha256)) {
    throw new Error(`release_pass_${ordinal}_receipt_invalid`);
  }
  passes.push(receipt);
}

if (new Set(passes.map((receipt) => receipt.sourceDigest)).size !== 1) {
  throw new Error("release_candidate_changed_between_passes");
}
if (new Set(passes.map((receipt) => receipt.artifactSha256)).size !== 1) {
  throw new Error("release_artifact_changed_between_passes");
}
assertCleanCandidate();

const tarball = path.join(root, "artifacts", `newton-browser-${packageVersion}.tgz`);
const artifactSha256 = createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
if (artifactSha256 !== passes[0].artifactSha256) throw new Error("release_artifact_receipt_mismatch");
const commit = gitValue(["rev-parse", "HEAD"]);
const tree = gitValue(["rev-parse", "HEAD^{tree}"]);
const receipt = Object.freeze({
  platform: process.platform,
  packageVersion,
  commit,
  tree,
  candidateDigest: passes[0].sourceDigest,
  sha256: artifactSha256,
  consecutivePasses: 3,
  sourceUnchanged: true,
});
fs.writeFileSync(path.join(root, platformReceipt), `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify(receipt)}\n`);

function runReleasePass() {
  const command = process.env.npm_execpath ? process.execPath : process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const args = process.env.npm_execpath ? [process.env.npm_execpath, "release:check"] : ["release:check"];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdoutTail = "";
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      stdoutTail = `${stdoutTail}${String(chunk)}`.slice(-1024 * 1024);
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`release_check_failed:${code ?? signal ?? "unknown"}`));
        return;
      }
      for (const line of stdoutTail.trim().split(/\r?\n/u).reverse()) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object" && parsed.ok === true && "sourceDigest" in parsed) {
            resolve(parsed);
            return;
          }
        } catch { /* scan the next bounded line */ }
      }
      reject(new Error("release_check_receipt_missing"));
    });
  });
}

function assertCleanCandidate() {
  const status = gitValue(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") throw new Error("release_candidate_not_clean");
}

function gitValue(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("release_git_inspection_failed");
  return result.stdout.trim();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
