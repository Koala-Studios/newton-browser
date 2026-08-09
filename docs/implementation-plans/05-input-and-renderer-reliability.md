# Plan 05 — Input and Renderer Reliability

- **Status:** Approved; deterministic implementation and live harness complete, live Chrome/Edge evidence pending
- **Depends on:** Plans 01 and 03
- **Primary outcome:** Actions behave like deliberate user input, recover from browser lifecycle events, and report dialogs, discards, detachments, and renderer failures precisely.

## Why this is a must-do

Agent cost is dominated by repairs when clicks, typing, focus, dialogs, or renderer state behave unexpectedly. More compact output does not help if an agent must repeat actions or re-observe the page. This plan reduces false retries and prevents stuck or duplicated input.

## Files

### Add

- `packages/driver/src/input-dispatcher.ts` — printable text, special keys, chords, pointer sequences, and dialog races.
- `packages/driver/src/renderer-liveness.ts` — explicit liveness state machine and recovery classification.
- `packages/driver/test/input-dispatcher.test.js`.
- `packages/driver/test/renderer-liveness.test.js`.
- `test/fixtures/input-reliability/` — dialog, key-event, discard, slow-renderer, and OOPIF pages.
- `scripts/smoke/input-reliability-live.mjs`.

### Edit

- `packages/driver/src/driver.ts` — delegate input and liveness handling.
- `packages/driver/src/controller.ts` — connect command outcomes to liveness and dialog state.
- `packages/driver/src/chrome-tabs-port.ts` — tab discard and ownership lifecycle signals.
- `apps/extension/src/service-worker.js` — mark owned tabs non-discardable and surface discard/detach events.
- `apps/mcp-server/src/bridge.ts` and `apps/mcp-server/src/mcp-server.ts` — retain typed failure categories.
- Existing driver unit, fixture, and live-browser smoke tests.
- `README.md`, `docs/TROUBLESHOOTING.md`, and `test/evidence/qa-ledger.md`.

### Delete

- Fixed-delay debugger reattach/retry branches after their state-driven replacements are covered.
- Duplicated inline key/pointer dispatch helpers superseded by `input-dispatcher.js`.

## Design

### 1. Route every input through one dispatcher

The dispatcher owns balanced pointer/key lifecycles. A command cancellation must release any button or modifier that Newton pressed.

```js
await dispatcher.run(command, async (input) => {
  await input.pointerMove(point);
  await input.mouseDown("left");
  await input.mouseUp("left");
});
```

The dispatcher tracks pressed buttons and modifiers in a `finally` cleanup. Cleanup failures are diagnostic details and do not overwrite an already uncertain effect outcome.

When hit testing proves another element intercepts a click, return bounded blocker
evidence (`role`, redacted accessible name, tag, frame provenance, and attempted point).
Keep Newton's existing multi-point/descendant hit testing; do not fall back to a blind
coordinate click.

### 2. Use the correct text path

- Printable text: focus the target, select/clear if requested, then use `Input.insertText`.
- Enter, Tab, arrows, Escape, Backspace, Delete, function keys, and chords: send complete `rawKeyDown`/`keyDown`, optional `char`, and `keyUp` descriptors with `key`, `code`, Windows virtual-key codes, native virtual-key codes when applicable, modifiers, and text fields.
- Do not synthesize a character event for non-printable keys.

```js
await cdp.send("Input.dispatchKeyEvent", keyDownDescriptor(key, modifiers));
try {
  if (descriptor.text) {
    await cdp.send("Input.dispatchKeyEvent", { ...descriptor, type: "char" });
  }
} finally {
  await cdp.send("Input.dispatchKeyEvent", keyUpDescriptor(key, modifiers));
}
```

Invalid CSS selectors must fail synchronously as `invalid_selector`; they must not become a timeout.

### 3. Make dialogs first-class state

Subscribe to `Page.javascriptDialogOpening` before releasing the input event that may trigger it. Race scoped dialog state with the CDP input acknowledgement and renderer liveness:

```js
const dialog = dialogTracker.nextFor(targetKey, commandId);
const result = await Promise.race([
  dispatchInput(),
  dialog.then((event) => ({ status: "dialog_blocked", event })),
  liveness.failureFor(targetKey),
]);
```

The pending command stays correlated with the same target and epoch. An unrelated dialog in another tab or frame cannot complete the race.

### 4. Replace delay-based recovery with state transitions

Renderer states:

`healthy -> dialog_blocked | discarded | debugger_detached | target_gone | unresponsive -> reconciling -> healthy | terminal`

Transitions are driven by CDP detach/attach events, Chrome tab discard status, target destruction, and command acknowledgements. Do not use sleeps as a substitute for a missing transition.

Owned tabs are created or updated with `autoDiscardable: false`. Current-tab mode never activates, reloads, or navigates a tab as an automatic recovery step.

### 5. Settle on observable state, not element counts and sleep

Replace the URL-plus-element-count fingerprint where it is used as completion evidence
with relevant lifecycle/network quiet signals, mutation/document version counters,
target-specific value/state changes, and explicit caller waits. Text/value-only updates
must be observable. Bounds remain mandatory, but a bound is not implemented as an
unconditional pre-action or post-action sleep.

## Typed result categories

- `dialog_blocked` — a scoped JavaScript dialog interrupted completion.
- `discarded` — Chrome discarded the owned tab.
- `debugger_conflict` — another debugger attachment displaced Newton.
- `target_gone` — the intended target no longer exists.
- `renderer_unresponsive` — liveness failed without stronger evidence.
- `invalid_selector` — selector parsing failed before action dispatch.
- `outcome_unknown` — the renderer/transport failed after effect release.

These categories are machine-readable; prose remains optional diagnostic detail.

## Implementation slices

1. Extract input descriptors and add exhaustive unit vectors.
2. Add balanced pointer/modifier cleanup and selector validation.
3. Add target-scoped dialog tracking.
4. Add renderer liveness state and tab discard signals.
5. Remove fixed-delay recovery branches.
6. Add live Chromium tests and troubleshooting guidance.

## Required tests

- Printable Unicode, IME-compatible text, and newline behavior.
- Enter/Tab/arrows/Escape/Delete and common modifier chords expose expected DOM key events.
- Click handlers that open dialogs on `mousedown`, `mouseup`, and `click` return `dialog_blocked` without hanging.
- A dialog in another tab or OOPIF does not steal the command result.
- An intercepted click reports the actual bounded blocker and never dispatches blindly.
- Text/value-only asynchronous changes satisfy state-driven settling.
- Pointer buttons and modifiers are released after errors and cancellation.
- Invalid selectors fail immediately.
- Owned tabs are marked non-discardable; a forced discard has a deterministic category.
- Debugger detach/rebind uses actual events and preserves epoch/sequence rules.
- Current-tab failure never activates or reloads the tab.

## Exit criteria

- No production retry uses a fixed sleep unless a test proves an unavoidable external timing requirement and records the reason.
- All supported keys have complete, tested descriptors.
- Dialog and renderer failure categories survive through MCP unchanged.
- Live smoke covers Chrome and Edge where available.
- The full root test suite and packed-artifact smoke pass.

## Rollback

The extracted dispatcher may be reverted independently only while the old path remains behaviorally intact. Once old inline helpers and delay branches are removed, rollback must restore them and their exact tests in one change.
