# Pointer action regression findings

## Astra review correction

The double-click fixture did not register a `dblclick` listener, so the missing log was
a fixture defect. Astra added the listener and actual `isTrusted` checks; repeated native
clicks pass. The iframe click itself landed, but the text wait inspected only the root
document. Text predicates now use the shared bounded reader in each controlled frame.
Independent rerun: all three pointer tests pass (plus the dialog lifecycle regression).
The original run below remains historical evidence, not the current implementation state.

## Run

- Command: `node --experimental-strip-types --test test/engine-regressions/pointer-actions.test.mjs`
- Result: 1 passed, 2 failed, 0 skipped, 0 cancelled.
- Duration: 4403.2734 ms.
- Fixture: deterministic local HTTP fixture with owned browser, guardian, and profile cleanup.
- Scope: `ownedEngineConnection` plus `PageExecutor` and `SessionEngine`; no production page scripts, builds, installs, profile reads, or external writes.

## Passing contract coverage

- Hover produced the trusted `pointerenter` fixture effect through the public `hover` action and wait condition.
- Right-button click produced `contextmenu:2` without a left-click effect.
- A covered target refused before pointer down and produced no `covered:click` effect.

## Findings

1. Double-click contract failed in `pointer-actions.test.mjs:94`: receipt was `reason: timed_out`, `errorCode: timed_out`, `dispatch: acknowledged`, `postcondition: { state: unknown, kind: value }`; the fixture did not observe `dblclick:2`. The separate `click:0:2` detail assertion did not fail, so click detail reached the fixture but the `dblclick` effect did not.
2. Iframe-offset targeting failed in `pointer-actions.test.mjs:131`: receipt was `reason: timed_out`, `errorCode: timed_out`, `dispatch: acknowledged`, `postcondition: { state: unknown, kind: value }`; the child fixture did not observe `frame:clicked` within the bounded wait. No successful cross-frame pointer effect is claimed.
