import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("stress RSS accounting starts after an exercised warmup phase", () => {
  const result = spawnSync(process.execPath, ["--expose-gc", "scripts/smoke/stress.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NEWTON_BROWSER_STRESS_WARMUP_MS: "200",
      NEWTON_BROWSER_STRESS_MS: "200",
      NEWTON_BROWSER_STRESS_RSS_LIMIT_MB: "1024",
    },
    timeout: 15_000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(summary.rss.baseline, "post_warmup");
  assert.ok(summary.warmupOperations > 0);
  assert.ok(summary.operations > 0);
});
