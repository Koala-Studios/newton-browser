# Plan 02: Transactional Session Lifecycle and Bounded Framing

> Historical implementation plan. Its transactional lifecycle and bounded-framing
> requirements remain, but MV3/relay-specific files and restart gates were superseded by
> the direct owned-browser lifecycle in Plans 13-15.

- Status: superseded execution plan; retained as design history
- Classification: core lifecycle and security gate
- Dependencies: Plan 01 command outcome types

## 1. Objective

Make session start, external rebind, finalization, stop, and owner replacement atomic and
idempotent. Bound MCP input framing before allocation can grow without limit. Ensure every
failure has an exact cleanup path and cannot leak a tab, debugger attachment, host session,
binding record, queued command, or paused target.

Non-goals: changing tab ownership defaults, adding a daemon, or hiding failures by retrying
the whole session transaction.

## 2. Contract decisions

Session lifecycle states are:

```ts
type SessionLifecycleState =
  | "creating_host"
  | "creating_tab"
  | "attaching_debugger"
  | "verifying_origin"
  | "publishing_ready"
  | "active"
  | "finalizing"
  | "stopped";
```

Only `active` sessions are published to command routing. Finalize is a Plan 01 pump barrier
and is idempotent for the same disposition. A second, different disposition returns
`finalize_conflict`.

MCP input limits:

- maximum header bytes: 16 KiB;
- maximum JSON-line or declared body bytes: 4 MiB;
- maximum total parser buffer: 4 MiB + 16 KiB;
- negative, duplicate, non-decimal, or over-limit `Content-Length`: typed framing error;
- EOF with a partial frame: `incomplete_frame` on stderr/protocol error, never stdout text.

## 3. File manifest

| Operation | File | Purpose |
| --- | --- | --- |
| add | `packages/driver/src/session-transaction.ts` | rollback stack and lifecycle state helper |
| add | `packages/driver/test/session-transaction.test.js` | reverse cleanup and partial-cleanup tests |
| add | `apps/mcp-server/test/framing.test.ts` | parser cap and malformed-frame matrix |
| edit | `packages/core/src/transport.ts` | lifecycle state and finalize outcome types |
| edit | `packages/driver/src/controller.ts` | transactional start/rebind/finalize/stop |
| edit | `apps/extension/src/service-worker.js` | binding publication/removal only after committed state |
| edit | `apps/mcp-server/src/bridge.ts` | ready-state publication, ownership transaction, pending rejection |
| edit | `apps/mcp-server/src/mcp-server.ts` | bounded parser and typed protocol errors |
| edit | `packages/driver/test/controller.test.ts` | injected failure matrix |
| edit | `apps/extension/test/extension.test.ts` | worker restart/binding cleanup |
| edit | `apps/mcp-server/test/host.test.ts` | owner replacement/finalize races |
| edit | `scripts/smoke/live-worker-restart.mjs` | lifecycle restart proof |
| edit | `scripts/smoke/clean-user.mjs` | no residual bindings/files/ports assertion |
| edit | `docs/DECISIONS.md` | lifecycle and framing limits |
| edit | `test/evidence/bugs.md` | partial-start repro/root cause |
| edit | `test/evidence/qa-ledger.md` | live cleanup evidence |
| delete | none | — |

## 4. Implementation

### Slice 1 — Rollback primitive

```js
export async function runSessionTransaction(work) {
  const rollback = [];
  const defer = (name, fn) => rollback.push({ name, fn });
  try {
    return await work(defer);
  } catch (error) {
    const cleanupErrors = [];
    for (const step of rollback.reverse()) {
      try { await step.fn(); } catch (cleanupError) {
        cleanupErrors.push({ step: step.name, error: String(cleanupError) });
      }
    }
    throw lifecycleError(error, cleanupErrors);
  }
}
```

Cleanup failure is surfaced as bounded diagnostic metadata but does not replace the
primary failure code.

### Slice 2 — Transactional start

For owned tabs, execute and register rollback in this order:

1. create tab/group;
2. create host session;
3. construct controller privately, not in `sessions`;
4. attach debugger;
5. verify live exact origin;
6. attach tab metadata to host;
7. start subscription/pump;
8. publish controller into `sessions` and binding record;
9. announce ready.

Rollback runs the completed steps in reverse. Current-tab rollback never closes or
activates the user tab.

### Slice 3 — Transactional rebind and owner replacement

`bindExternalSession` uses the same helper. Claiming a replacement extension does not
publish it as owner until it proves identity, browser eligibility, binding validity,
debugger attachment, and live origin. The former owner stays valid until commit, then its
subscription is fenced by epoch.

### Slice 4 — Finalize/stop transaction

Finalize closes the Plan 01 queue, waits for or classifies the active command, detaches,
applies tab disposition, stops the host session, removes binding state, and publishes the
terminal result. Repeated calls return the stored terminal result. Cleanup operations are
individually idempotent.

### Slice 5 — Framing caps

Check `buffer.length + chunk.length` before `Buffer.concat`. Reject an oversized header
before looking for the header terminator and reject an excessive declared body before
waiting for the bytes:

```ts
if (this.buffer.length + chunk.length > MAX_MCP_BUFFER_BYTES) {
  return this.fail(new Error("mcp_input_too_large"));
}
if (contentLength > MAX_MCP_BODY_BYTES) {
  throw new Error("mcp_content_length_exceeded");
}
```

Export the parser only for focused tests; do not export it from the public package.

## 5. Verification

Inject failure after every start stage and assert exact cleanup. Include attach failure,
origin failure, relay attach failure, subscription failure, binding persistence failure,
worker restart, owner replacement, and cleanup failure. For framing, feed one byte at a
time, multiple frames per chunk, mixed supported framing modes, oversized lines/headers,
huge declared lengths, duplicate lengths, partial EOF, and recovery in a fresh process.

Required commands:

```text
node --test packages/driver/test/session-transaction.test.js packages/driver/test/controller.test.ts
node --test apps/mcp-server/test/framing.test.ts apps/mcp-server/test/host.test.ts
pnpm smoke:clean-user
pnpm lint
pnpm typecheck
pnpm test
pnpm pack:check
git diff --check
```

Live evidence must prove the public-observable residue boundary after an MV3 worker
restart: no owned tab, session, queued command, listener port, or bounded host/extension
binding summary remains. Debugger attachment, paused-target state, and private extension
binding storage are not observable through the public harness without adding a privileged
diagnostic. Their zero-residue guarantee is therefore proved by deterministic injected
driver/extension regressions. Adding a private live diagnostic requires separate approval;
the plan must not inspect Chrome profile state or expose those internals publicly.

## 6. Exit and rollback

Exit requires atomic publication and zero cleanup residue across the failure matrix.
Rollback must revert the lifecycle state machine and parser limits together with their
public errors; do not leave documentation claiming atomicity after removing enforcement.

Implementation is not started until conversational approval.
