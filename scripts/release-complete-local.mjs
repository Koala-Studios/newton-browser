import { spawnSync } from "node:child_process";

run("release:deterministic", process.env);
const families = process.platform === "win32" ? ["chrome", "edge"] : ["chrome"];
for (const family of families) {
  const env = { ...process.env, NEWTON_BROWSER_QA_OWNER: family };
  run("eval:direct-live", env);
  run("eval:real-sites", env);
}
process.stdout.write(`${JSON.stringify({ ok: true, deterministic: true, platform: process.platform, directLive: families, realSites: families, crossPlatformReceiptRequiredSeparately: true })}\n`);

function run(command, env) {
  const executable = process.env.npm_execpath ? process.execPath : "pnpm";
  const args = process.env.npm_execpath ? [process.env.npm_execpath, command] : [command];
  const result = spawnSync(executable, args, { cwd: process.cwd(), env, stdio: "inherit", windowsHide: true, timeout: 1_800_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`complete release stage ${command} failed (${result.status})`);
}
