import test from "node:test";
import assert from "node:assert/strict";
import { ENGINE_COMMAND_SCHEMA, explainArguments } from "../src/index.ts";

const act = { type: "object", properties: { sessionId: { type: "string" }, command: ENGINE_COMMAND_SCHEMA }, required: ["sessionId", "command"], additionalProperties: false };

test("argument errors name the field a model got wrong and what it expects", () => {
  const command = (action: unknown, extra: Record<string, unknown> = {}) => ({ sessionId: "s", command: { commandId: 1, action, ...extra } });
  assert.deepEqual(explainArguments(act, command({ kind: "resize", viewport: { width: 1280, height: 900 } })),
    { field: "arguments.command.action.viewport", expected: "not allowed here; allowed: kind, width, height" });
  assert.deepEqual(explainArguments(act, command({ kind: "fill", target: { ref: "e1" }, value: "x" })),
    { field: "arguments.command.action.target.kind", expected: "required" });
  assert.deepEqual(explainArguments(act, command({ kind: "press", key: "Enter" })),
    { field: "arguments.command.action.key", expected: "not allowed here; allowed: kind, target, keys, text" });
  assert.deepEqual(explainArguments(act, command({ kind: "tap" }))?.field, "arguments.command.action.kind");
  assert.deepEqual(explainArguments(act, { sessionId: "s", command: { action: { kind: "back" } } }),
    { field: "arguments.command.commandId", expected: "required" });
  assert.deepEqual(explainArguments(act, command({ kind: "back" }, { timeoutMs: 0 })),
    { field: "arguments.command.timeoutMs", expected: "number >= 1" });
  assert.equal(explainArguments(act, command({ kind: "fill", target: { kind: "ref", ref: "e1" }, value: "x" })), undefined);
});
