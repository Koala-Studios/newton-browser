import test from "node:test";
import assert from "node:assert/strict";
import { parseEngineCommand } from "@newton-browser/core";
import { normalizeToolArguments } from "../src/argument-normalization.ts";
import { withNormalized } from "../src/engine-mcp.ts";

const act = (command: unknown, extra: Record<string, unknown> = {}) => normalizeToolArguments("browser.act", { sessionId: "s1", command, ...extra });
const parsed = (result: ReturnType<typeof act>) => parseEngineCommand((result.args as { command: unknown }).command);

// Each shape below was written by Claude, Codex or a Newton worker in the 2026-10-05 runs.
test("near-miss shapes agents wrote become the exact command, and each rewrite is listed", () => {
  const wait = act({ commandId: 1, action: { kind: "wait_for", target: { kind: "semantic", role: "button", name: "Remove" }, state: "visible" } }, { timeoutMs: "20000" });
  assert.deepEqual(parsed(wait).action, { kind: "wait_for", waitFor: { target: { kind: "semantic", role: "button", name: "Remove", exact: true }, state: "visible" } });
  assert.equal(parsed(wait).timeoutMs, 20000);
  // The wait itself is already exact: GPT models write it this way, so it is the documented form.
  assert.deepEqual(wait.normalized, ["timeoutMs → command.timeoutMs", "command.timeoutMs \"20000\" → number"]);

  // Claude wrote the condition nested, as 0.7.8 documented it.
  const nestedWait = act({ commandId: 1, action: { kind: "wait_for", waitFor: { target: { kind: "ref", ref: "e4" }, state: "hidden" } } });
  assert.deepEqual(parsed(nestedWait).action, { kind: "wait_for", waitFor: { target: { kind: "ref", ref: "e4" }, state: "hidden" } });
  assert.deepEqual(nestedWait.normalized, ["action.waitFor.{target,state} → action"]);

  const stateAsKind = act({ commandId: 1, action: { kind: "wait_for", waitFor: { kind: "visible", target: { kind: "ref", ref: "e4" } } } });
  assert.deepEqual(parsed(stateAsKind).action, { kind: "wait_for", waitFor: { target: { kind: "ref", ref: "e4" }, state: "visible" } });

  const flat = act({ commandId: 1, action: { kind: "wait_for", waitFor: { ref: "e1", state: "enabled" } } });
  assert.deepEqual(parsed(flat).action, { kind: "wait_for", waitFor: { target: { kind: "ref", ref: "e1" }, state: "enabled" } });

  const label = act({ commandId: 2, action: { kind: "select", target: { kind: "ref", ref: "e6" }, label: "Two" } });
  assert.deepEqual(parsed(label).action, { kind: "select", target: { kind: "ref", ref: "e6" }, value: "Two" });
  const nested = act({ commandId: 2, action: { kind: "select", target: { kind: "ref", ref: "e6" }, value: { label: "Two" } } });
  assert.equal((parsed(nested).action as { value: string }).value, "Two");

  const textForValue = act({ commandId: 6, action: { kind: "type", target: { kind: "ref", ref: "e1" }, text: "hello" } });
  assert.deepEqual(parsed(textForValue).action, { kind: "type", target: { kind: "ref", ref: "e1" }, value: "hello" });
  assert.deepEqual(parsed(act({ commandId: 7, action: { kind: "press", text: "hi" } })).action, { kind: "press", text: "hi" }, "press keeps its own text");

  // Claude, 0.7.10 run: a wait after navigating, on the action and then on the command.
  const navigateWait = act({ commandId: 7, action: { kind: "navigate", url: "https://example.org/", waitFor: { text: "Remove/add", timeoutMs: 4000 } } });
  assert.deepEqual(parsed(navigateWait).action, { kind: "sequence", steps: [{ kind: "navigate", url: "https://example.org/" }, { kind: "wait_for", waitFor: { text: "Remove/add", timeoutMs: 4000 } }] });
  const commandWait = act({ commandId: 7, action: { kind: "navigate", url: "https://example.org/" }, waitFor: { text: "Remove/add" } });
  assert.equal(parsed(commandWait).action.kind, "sequence");
  assert.deepEqual(commandWait.normalized, ["command.waitFor → action.waitFor", "action.waitFor → a following wait_for step"]);
  const clickWait = act({ commandId: 8, action: { kind: "click", target: { kind: "ref", ref: "e2" } }, waitFor: { url: "**/done" } });
  assert.deepEqual(parsed(clickWait).action, { kind: "click", target: { kind: "ref", ref: "e2" }, waitFor: { url: "**/done" } }, "a click keeps its own after-wait");
  const stepWait = act({ commandId: 9, action: { kind: "sequence", steps: [{ kind: "fill", target: "e1", value: "x", waitFor: { text: "Saved" } }] } });
  assert.deepEqual(parsed(stepWait).action, { kind: "sequence", steps: [{ kind: "fill", target: { kind: "ref", ref: "e1" }, value: "x" }, { kind: "wait_for", waitFor: { text: "Saved" } }] });

  const typeForKind = act({ commandId: 1, action: { type: "fill", target: "e1", value: "qa test" } });
  assert.deepEqual(parsed(typeForKind).action, { kind: "fill", target: { kind: "ref", ref: "e1" }, value: "qa test" });

  const unwrapped = normalizeToolArguments("browser.act", { sessionId: "s1", commandId: 3, action: { kind: "click", target: { ref: "e9" } } });
  assert.deepEqual(parseEngineCommand((unwrapped.args as { command: unknown }).command).action, { kind: "click", target: { kind: "ref", ref: "e9" } });

  const steps = act({ commandId: 4, action: { kind: "sequence", steps: [{ kind: "select", target: { kind: "ref", ref: "e6" }, label: "One" }, { kind: "wait_for", text: "Done" }] } });
  assert.deepEqual(parsed(steps).action, { kind: "sequence", steps: [{ kind: "select", target: { kind: "ref", ref: "e6" }, value: "One" }, { kind: "wait_for", waitFor: { text: "Done" } }] });

  const scope = normalizeToolArguments("browser.document.read", { sessionId: "s1", scope: { selector: "#content" }, maxBytes: "8192" });
  assert.deepEqual(scope.args, { sessionId: "s1", scope: { kind: "selector", selector: "#content" }, maxBytes: 8192 });
});

test("exact input is untouched, and conflicting or ambiguous input is left for the strict parser to refuse", () => {
  const exact = { sessionId: "s1", command: { commandId: 1, action: { kind: "wait_for", target: { kind: "ref", ref: "e1" }, state: "visible" } } };
  assert.deepEqual(act(exact.command), { args: exact, normalized: [] });
  const afterClick = { sessionId: "s1", command: { commandId: 2, action: { kind: "click", target: { kind: "ref", ref: "e2" }, waitFor: { url: "**/done" } } } };
  assert.deepEqual(act(afterClick.command), { args: afterClick, normalized: [] });
  // A nested kind that is neither a state nor a target kind is not merged over the action's own kind.
  assert.throws(() => parsed(act({ commandId: 1, action: { kind: "wait_for", waitFor: { kind: "tap", target: { kind: "ref", ref: "e1" } } } })), /invalid_arguments|unsupported/u);

  // Two different values for the same field: neither wins.
  const conflict = act({ commandId: 1, action: { kind: "wait_for", state: "visible", waitFor: { state: "hidden", target: { kind: "ref", ref: "e1" } } } });
  assert.throws(() => parsed(conflict), /invalid_arguments/u);
  const both = act({ commandId: 1, action: { kind: "select", target: { kind: "ref", ref: "e6" }, label: "Two", value: "One" } });
  assert.throws(() => parsed(both), /invalid_arguments/u);
  const command = act({ commandId: 1, timeoutMs: 5000, action: { kind: "click", target: { kind: "ref", ref: "e1" } } }, { timeoutMs: 9000 });
  assert.equal((command.args as { timeoutMs?: number }).timeoutMs, 9000, "a field given in both places stays where it was, so the strict check refuses it");

  // A target with two ways to find the element, or a string that is not a ref, is not guessed.
  const twoWays = act({ commandId: 1, action: { kind: "click", target: { ref: "e1", selector: "#a" } } });
  assert.throws(() => parsed(twoWays), /invalid_arguments/u);
  const notRef = act({ commandId: 1, action: { kind: "click", target: "#submit" } });
  assert.throws(() => parsed(notRef), /invalid_arguments/u);
  // An unknown kind name in `type` stays unknown.
  assert.throws(() => parsed(act({ commandId: 1, action: { type: "tap", target: { kind: "ref", ref: "e1" } } })), /invalid_arguments|unsupported/u);
});

test("the rewrites reach the agent inside the tool result", () => {
  const result = { content: [{ type: "text", text: JSON.stringify({ reason: "completed" }) }] };
  assert.deepEqual(JSON.parse((withNormalized(result, ["action.label → action.value"]) as typeof result).content[0]!.text), { reason: "completed", normalized: ["action.label → action.value"] });
  assert.equal(withNormalized(result, []), result);
});

// Written in the 2026-10-05 twelve-task runs.
test("press key, drag source and drag-and-drop spellings become the exact command", () => {
  const key = act({ commandId: 1, action: { kind: "press", target: { kind: "ref", ref: "e1" }, key: "Tab" } });
  assert.deepEqual(parsed(key).action, { kind: "press", target: { kind: "ref", ref: "e1" }, keys: ["Tab"] });
  assert.deepEqual(key.normalized, ["action.key → action.keys", "action.keys \"Tab\" → [\"Tab\"]"]);
  const chord = act({ commandId: 1, action: { kind: "press", keys: "Control+a" } });
  assert.deepEqual(parsed(chord).action, { kind: "press", keys: ["Control", "a"] });
  const plus = act({ commandId: 1, action: { kind: "press", keys: "+" } });
  assert.deepEqual(parsed(plus).action, { kind: "press", keys: ["+"] });

  const codex = act({ commandId: 2, action: { kind: "drag", source: { kind: "selector", selector: "#column-a" }, target: { kind: "selector", selector: "#column-b" } } });
  assert.deepEqual(parsed(codex).action, { kind: "drag", target: { kind: "selector", selector: "#column-a" }, to: { kind: "selector", selector: "#column-b" } });
  assert.deepEqual(codex.normalized, ["action.target → action.to", "action.source → action.target"]);
  const fromTo = act({ commandId: 2, action: { kind: "drag_and_drop", from: "e3", to: "e4" } });
  assert.deepEqual(parsed(fromTo).action, { kind: "drag", target: { kind: "ref", ref: "e3" }, to: { kind: "ref", ref: "e4" } });
  const exact = act({ commandId: 2, action: { kind: "drag", target: { kind: "ref", ref: "e3" }, to: { kind: "ref", ref: "e4" } } });
  assert.deepEqual(exact.normalized, []);
  // Three ends are not one drag: the strict check refuses it.
  const three = act({ commandId: 2, action: { kind: "drag", source: { kind: "ref", ref: "e2" }, target: { kind: "ref", ref: "e3" }, to: { kind: "ref", ref: "e4" } } });
  assert.throws(() => parsed(three), /invalid_arguments|unsupported/u);
});
