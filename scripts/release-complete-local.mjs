import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sourceDigest = candidateDigest();
run("release:deterministic", process.env);
const artifactHashes = new Set();
const families = process.platform === "win32" ? ["chrome", "edge"] : ["chrome"];
for (const family of families) {
  const env = { ...process.env, NEWTON_BROWSER_QA_BROWSER: family };
  run("eval:direct-live", env);
  const packed = run("smoke:packed-direct", env, true);
  const receipt = lastJsonReceipt(packed.stdout);
  if (receipt?.ok !== true || receipt?.browserFamily !== family || typeof receipt?.packedArtifactSha256 !== "string") {
    throw new Error(`packed direct receipt invalid for ${family}`);
  }
  artifactHashes.add(receipt.packedArtifactSha256);
}
if (artifactHashes.size !== 1) throw new Error("packed artifact hash diverged across browser families");
const finalSourceDigest = candidateDigest();
if (finalSourceDigest !== sourceDigest) throw new Error("release candidate changed during verification");
process.stdout.write(`${JSON.stringify({ ok: true, deterministic: true, platform: process.platform, sourceDigest, sourceUnchanged: true, directLive: families, packedDirect: families, artifactSha256: [...artifactHashes][0], realSiteEvidenceRequiredSeparately: true, crossPlatformReceiptRequiredSeparately: true })}\n`);

function run(command, env, capture = false) {
  const executable = process.env.npm_execpath ? process.execPath : "pnpm";
  const args = process.env.npm_execpath ? [process.env.npm_execpath, command] : [command];
  const result = spawnSync(executable, args, {
    cwd: process.cwd(),
    env,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: capture ? "utf8" : undefined,
    windowsHide: true,
    timeout: 1_800_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`complete release stage ${command} failed (${result.status})`);
  if (capture && result.stdout) process.stdout.write(result.stdout);
  return result;
}

function lastJsonReceipt(stdout) {
  for (const line of String(stdout ?? "").trim().split(/\r?\n/u).reverse()) {
    try { return JSON.parse(line); } catch {}
  }
  return null;
}

function candidateDigest() {
  const listing = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: process.cwd(), encoding: "buffer", windowsHide: true,
  });
  if (listing.error) throw listing.error;
  if (listing.status !== 0 || !Buffer.isBuffer(listing.stdout)) throw new Error("release candidate inventory failed");
  const files = listing.stdout.toString("utf8").split("\0").filter(Boolean).sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  for (const relative of files) {
    if (relative.includes("\0") || path.isAbsolute(relative)) throw new Error("release candidate inventory invalid");
    const absolute = path.resolve(relative);
    const back = path.relative(process.cwd(), absolute);
    if (back.startsWith("..") || path.isAbsolute(back)) throw new Error("release candidate inventory escaped workspace");
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      hash.update(`${relative.replaceAll("\\", "/")}\0deleted\0`);
      continue;
    }
    hash.update(`${relative.replaceAll("\\", "/")}\0${stat.mode}\0${stat.size}\0`);
    if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(absolute));
    else if (stat.isFile()) hash.update(fs.readFileSync(absolute));
    else throw new Error("release candidate contains unsupported path type");
    hash.update("\0");
  }
  return hash.digest("hex");
}
