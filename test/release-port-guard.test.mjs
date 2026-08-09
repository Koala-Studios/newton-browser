import assert from "node:assert/strict";
import test from "node:test";

import { NEWTON_HOST_PORTS, newlyOccupiedPorts } from "../scripts/release-port-guard.mjs";

test("release port guard preserves pre-existing local MCP hosts", () => {
  const before = new Set([17_321, 17_322, 17_330]);
  const after = new Set([17_321, 17_322, 17_330]);
  assert.deepEqual(newlyOccupiedPorts(before, after), []);
});

test("release port guard detects only listeners created during the run", () => {
  const before = new Set([17_321, 17_322]);
  const after = new Set([17_321, 17_322, 17_325, 17_323]);
  assert.deepEqual(newlyOccupiedPorts(before, after), [17_323, 17_325]);
  assert.deepEqual(NEWTON_HOST_PORTS, Array.from({ length: 20 }, (_, index) => 17_321 + index));
});
