import assert from "node:assert/strict";
import test from "node:test";

import { stressTimeoutMs } from "../../scripts/smoke/stress-timing.mjs";

test("stress child timeout includes warmup, measurement, and shutdown headroom", () => {
  assert.equal(stressTimeoutMs({}), 360_000);
  assert.equal(stressTimeoutMs({
    NEWTON_BROWSER_STRESS_MS: "500000",
    NEWTON_BROWSER_STRESS_WARMUP_MS: "45000",
  }), 575_000);
  assert.equal(stressTimeoutMs({
    NEWTON_BROWSER_STRESS_MS: "200",
    NEWTON_BROWSER_STRESS_WARMUP_MS: "200",
  }), 120_000);
});
