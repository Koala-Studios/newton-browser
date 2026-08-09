import { spawnSync } from "node:child_process";
import { newlyOccupiedPorts, probeOccupiedPorts } from "./release-port-guard.mjs";

// Other active local MCP clients may legitimately own Newton's bounded default
// ports before this release begins. Preserve that baseline and reject only a
// listener created and leaked by one of the stages below.
const baselineOccupied = await probeOccupiedPorts();

// `build` runs before `typecheck`/`test`: @newton-browser/core resolves its types and
// runtime entry from dist, so tsc and the by-name package imports in the test suite
// need the workspace built first.
const stages = ["build", "lint", "typecheck", "test", "eval", "eval:agent-cost", "extension:artifact", "pack:check", "smoke:quick", "smoke:matrix", "smoke:chaos", "smoke:multi-client", "smoke:clean-user"];
for (const command of stages) {
  const executable = process.env.npm_execpath ? process.execPath : "pnpm";
  const args = process.env.npm_execpath ? [process.env.npm_execpath, command] : [command];
  const timeout = command === "smoke:chaos" ? 420_000 : 300_000;
  const result = spawnSync(executable, args, { cwd: process.cwd(), stdio: "inherit", windowsHide: true, timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`release stage ${command} failed (${result.status})`);
}
const occupiedAfter = await probeOccupiedPorts();
const unexpected = newlyOccupiedPorts(baselineOccupied, occupiedAfter);
if (unexpected.length) throw new Error(`new orphan Newton Browser host ports remain: ${unexpected.join(", ")}`);
process.stdout.write(`${JSON.stringify({ ok: true, stages: stages.length, preexistingHostPorts: baselineOccupied.size, orphanHostPorts: 0 })}\n`);
