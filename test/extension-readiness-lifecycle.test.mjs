import assert from "node:assert/strict";
import test from "node:test";

import { waitForMcpResponse } from "../scripts/smoke/mcp-response-waiter.mjs";

test("successful MCP response cancels its readiness timeout", async () => {
  const responses = new Map();
  const waiters = new Map();
  const cancelled = [];
  const pending = waitForMcpResponse({
    requestId: "1",
    responses,
    waiters,
    timeoutMs: 30_000,
    diagnostics: () => "",
    scheduleTimeout: () => "timer-1",
    cancelTimeout: (timer) => cancelled.push(timer),
  });
  responses.set("1", { ok: true });
  waiters.get("1")();
  await pending;
  assert.deepEqual(cancelled, ["timer-1"]);
  assert.equal(waiters.size, 0);
});

test("response arriving during waiter registration resolves without a live timer", async () => {
  const responses = new Map();
  const waiters = new Map();
  const cancelled = [];
  await waitForMcpResponse({
    requestId: "2",
    responses,
    waiters,
    timeoutMs: 10_000,
    diagnostics: () => "",
    scheduleTimeout: () => {
      responses.set("2", { ok: true });
      return "timer-2";
    },
    cancelTimeout: (timer) => cancelled.push(timer),
  });
  assert.deepEqual(cancelled, ["timer-2"]);
  assert.equal(waiters.size, 0);
});
