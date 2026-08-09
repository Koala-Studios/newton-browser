import { runInputReliabilityLive } from "../../test/fixtures/input-reliability/live-harness.mjs";

await runInputReliabilityLive("input-reliability-live", async ({ mcp, sessionId, resultOf, statusOf, assert, log }) => {
  const act = (action) => mcp("browser.act", { sessionId, action });
  const focus = await act({ kind: "click", name: "Keyboard target", exact: true });
  assert(focus.ok !== false, "keyboard target did not receive focus", focus);

  const typed = await act({ kind: "type", label: "Keyboard target", value: "héllo 世界\n" });
  assert(typed.ok !== false, "IME-compatible text dispatch failed", typed);

  for (const keys of [
    ["Enter"], ["Tab"], ["ArrowLeft"], ["ArrowRight"], ["ArrowUp"], ["ArrowDown"],
    ["Escape"], ["Backspace"], ["Delete"], ["F12"], ["Control", "Shift", "P"],
  ]) {
    const refocused = await act({ kind: "click", name: "Keyboard target", exact: true });
    assert(refocused.ok !== false, `keyboard target refocus failed: ${keys.join("+")}`, refocused);
    const pressed = await act({ kind: "press", keys });
    assert(pressed.ok !== false, `key dispatch failed: ${keys.join("+")}`, pressed);
  }

  const observation = resultOf(await mcp("browser.observe", { sessionId, format: "json", query: "Key event log", maxNodes: 80 }));
  const keyLog = (observation.nodes ?? observation.added ?? []).find((node) => node.name === "Key event log")?.value ?? "";
  for (const expected of ["Enter", "Tab", "ArrowLeft", "Escape", "Backspace", "Delete", "F12", "Control", "Shift", "P"]) {
    assert(String(keyLog).includes(`\"key\":\"${expected}\"`), `DOM key log missing ${expected}`, { keyLog });
  }
  assert(String(keyLog).includes('"type":"keyup"'), "key lifecycle did not include keyup", { keyLog });
  log("complete_key_descriptors", { actionStatus: statusOf(typed), keyLogBytes: String(keyLog).length });

  const dialog = await act({ kind: "click", name: "Dialog on mousedown", exact: true });
  assert(statusOf(dialog) === "dialog_blocked", "mousedown dialog did not retain dialog_blocked", dialog);
  const dismissed = await act({ kind: "dialog_dismiss" });
  assert(dismissed.ok !== false, "dialog cleanup failed", dismissed);
  const pointerObservation = resultOf(await mcp("browser.observe", { sessionId, format: "json", query: "Pointer event log", maxNodes: 40 }));
  const pointerLog = (pointerObservation.nodes ?? pointerObservation.added ?? []).find((node) => node.name === "Pointer event log")?.value ?? "";
  assert(String(pointerLog).includes("mousedown"), "pointer log missed the released effect boundary", { pointerLog });
  log("balanced_cleanup_after_dialog", { pointerLogBytes: String(pointerLog).length });

  const asynchronous = await act({ kind: "click", name: "Set asynchronous value", exact: true });
  assert(asynchronous.ok !== false, "asynchronous value action failed", asynchronous);
  const settled = await act({ kind: "wait_for", waitFor: { text: "settled-without-delay" } });
  assert(settled.ok !== false, "state-driven text settlement failed", settled);
  log("state_driven_settlement");
}, {
  mainPort: Number(process.env.NEWTON_BROWSER_INPUT_FIXTURE_PORT ?? 18321),
  crossPort: Number(process.env.NEWTON_BROWSER_INPUT_CROSS_PORT ?? 18322),
});
