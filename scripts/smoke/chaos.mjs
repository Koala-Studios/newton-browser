import { spawnSync } from "node:child_process";

for (let attempt = 1; attempt <= 3; attempt += 1) {
  const result = spawnSync(process.execPath, ["--test", "--test-isolation=none", "apps/mcp-server/test/host.test.ts", "apps/extension/test/extension.test.ts", "packages/driver/test/controller.test.ts"], {
    cwd: process.cwd(), stdio: "inherit", windowsHide: true, timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`chaos repetition ${attempt} failed (${result.status})`);
}
process.stdout.write(`${JSON.stringify({ ok: true, repetitions: 3, coverage: ["disconnect", "reconnect", "fragmentation", "malformed", "bounds", "finalize", "multi-host"] })}\n`);
