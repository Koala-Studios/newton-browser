import { spawnSync } from "node:child_process";
import {candidateDigest} from "./release-candidate.mjs";



const sourceCandidate = candidateDigest();
const sourceDigest = sourceCandidate.sha256;
run("release:deterministic", process.env);
const artifactHashes = new Set();
const families = process.platform === "win32" ? ["chrome", "edge"] : ["chrome"];
for (const family of families) {
  const env = { ...process.env, NEWTON_BROWSER_QA_BROWSER: family };
  run("eval:real-sites", env);
  const packed = run("smoke:packed-direct", env, true);
  const receipt = lastJsonReceipt(packed.stdout);
  if (receipt?.ok !== true || receipt?.browserFamily !== family || typeof receipt?.packedArtifactSha256 !== "string") {
    throw new Error(`packed direct receipt invalid for ${family}`);
  }
  artifactHashes.add(receipt.packedArtifactSha256);
}
if (artifactHashes.size !== 1) throw new Error("packed artifact hash diverged across browser families");
const finalSourceDigest = candidateDigest().sha256;
if (finalSourceDigest !== sourceDigest) throw new Error("release candidate changed during verification");
process.stdout.write(`${JSON.stringify({ ok: true, deterministic: true, platform: process.platform, sourceDigest, sourceUnchanged: true, packedRealSites: families, packedDirect: families, artifactSha256: [...artifactHashes][0], legacyDirectSuiteExcluded: true, crossPlatformReceiptRequiredSeparately: true })}\n`);

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
