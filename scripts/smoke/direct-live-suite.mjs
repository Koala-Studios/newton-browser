import { spawn } from "node:child_process";
import path from "node:path";

const family = process.env.NEWTON_BROWSER_QA_BROWSER === "edge" ? "edge" : "chrome";
const env = {
  ...process.env,
  NEWTON_BROWSER_QA_BROWSER: family,
};
const stages = [
  ["direct_runtime", "scripts/smoke/direct-runtime-live.mjs"],
  ["direct_setup", "scripts/smoke/direct-setup-live.mjs", "--browser", family],
  ["direct_concurrency", "scripts/smoke/direct-concurrency-live.mjs"],
  ["direct_hard_crash", "scripts/smoke/direct-hard-crash-live.mjs"],
  ["direct_frame_target_churn", "scripts/smoke/frame-target-churn-live.mjs"],
  ["direct_origin_containment", "scripts/smoke/origin-containment-live.mjs"],
  ["direct_input", "scripts/smoke/input-reliability-live.mjs"],
  ["direct_dialog_renderer", "scripts/smoke/dialog-renderer-live.mjs"],
];

const failures = [];
for (const [stage, script, ...args] of stages) {
  const result = await run(process.execPath, [path.resolve(script), ...args], env);
  if (result.code !== 0) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      browserFamily: family,
      stage,
      step: `${stage}_${result.diagnostic}`,
    })}\n`);
    failures.push(stage);
    continue;
  }
  process.stdout.write(`${JSON.stringify({ browserFamily: family, stage, step: stage, status: "pass" })}\n`);
}

process.stdout.write(`${JSON.stringify({
  ok: failures.length === 0,
  browserFamily: family,
  stages: stages.length,
  failedStages: failures,
})}\n`);
if (failures.length > 0) process.exitCode = 1;

function run(command, args, childEnv) {
  return new Promise((resolve, reject) => {
    let stderrTail = "";
    let stdoutTail = "";
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      stdoutTail = `${stdoutTail}${chunk}`.slice(-64 * 1024);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      stderrTail = `${stderrTail}${chunk}`.slice(-64 * 1024);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      code: code ?? 1,
      diagnostic: safeChildDiagnostic(stderrTail, stdoutTail, signal),
    }));
  });
}

function safeChildDiagnostic(stderr, stdout, signal) {
  for (const line of stdout.split(/\r?\n/u).reverse()) {
    try {
      const value = JSON.parse(line);
      const code = value?.errorCode;
      if (typeof code === "string" && (/^packed_(?:direct|install)_[a-z0-9_]{1,60}$/u.test(code)
        || [
          "direct_browser_unavailable",
          "direct_cleanup_uncertain",
          "direct_runtime_temp_cleanup_refused",
          "direct_setup_cleanup_refused",
          "direct_hard_crash_temp_cleanup_failed",
        ].includes(code))) return code;
    } catch {}
  }
  if (stderr.includes("OwnedBrowserRuntimeError")) return "owned_browser_runtime_failed";
  if (stderr.includes("ChromiumLaunchError")) return "browser_launch_failed";
  if (stderr.includes("ConfiguredDirectHostError")) return "configured_runtime_start_failed";
  if (stderr.includes("ProcessCleanupError")) return "browser_cleanup_uncertain";
  for (const code of [
    "configured_browser_unavailable",
    "configured_runtime_start_failed",
    "configured_runtime_start_uncertain",
    "direct_cleanup_uncertain",
    "direct_driver_start_failed",
    "direct_runtime_temp_cleanup_refused",
    "direct_setup_cleanup_refused",
    "direct_hard_crash_temp_cleanup_failed",
    "owned_browser_runtime_failed",
  ]) {
    if (stderr.includes(code)) return code;
  }
  if (signal === "SIGKILL") return "signal_kill";
  if (signal === "SIGTERM") return "signal_term";
  if (signal) return "signal_other";
  return "failed";
}
