import { spawn } from "node:child_process";

const attempts = Math.max(1, Number(process.env.BROWSER_BRIDGE_COLD_START_ATTEMPTS ?? 10));
const samples = [];

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const output = await runReadinessProbe();
  const line = output.trim().split(/\r?\n/).filter(Boolean).at(-1);
  const sample = JSON.parse(line);
  if (!sample.ready) throw new Error(`cold start ${attempt} failed: ${line}`);
  samples.push(Number(sample.elapsedMs));
}

const sorted = [...samples].sort((a, b) => a - b);
const percentile = (value) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)];
process.stdout.write(`${JSON.stringify({
  ok: true,
  attempts,
  samplesMs: samples,
  minMs: sorted[0],
  p50Ms: percentile(0.5),
  p95Ms: percentile(0.95),
  maxMs: sorted.at(-1),
})}\n`);

function runReadinessProbe() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/smoke/extension-readiness.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, BROWSER_BRIDGE_EXTENSION_PROBE_MS: "35000" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`cold-start readiness probe timed out: ${stderr}`));
    }, 45_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`cold-start readiness probe exited ${code}: ${stderr}`));
    });
  });
}
