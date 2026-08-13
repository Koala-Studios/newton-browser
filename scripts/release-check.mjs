import { spawnSync } from "node:child_process";
const whitespace = spawnSync("git", ["diff", "--check"], { cwd: process.cwd(), stdio: "inherit", windowsHide: true });
if (whitespace.error) throw whitespace.error;
if (whitespace.status !== 0) throw new Error(`release whitespace check failed (${whitespace.status})`);
// `build` runs before `typecheck`/`test`: @newton-browser/core resolves its types and
// runtime entry from dist, so tsc and the by-name package imports in the test suite
// need the workspace built first.
const stages = ["build", "lint", "typecheck", "test", "eval:agent-cost", "pack:check"];
for (const command of stages) {
  const executable = process.env.npm_execpath ? process.execPath : "pnpm";
  const args = process.env.npm_execpath ? [process.env.npm_execpath, command] : [command];
  const result = spawnSync(executable, args, { cwd: process.cwd(), stdio: "inherit", windowsHide: true, timeout: 600_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`release stage ${command} failed (${result.status})`);
}
process.stdout.write(`${JSON.stringify({ ok: true, architecture: "owned_process_private_cdp", stages: stages.length })}\n`);
