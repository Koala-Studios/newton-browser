# Plan 01: Per-Session Command Pump, Fencing, and Idempotency

- Status: approval required
- Classification: core execution foundation
- Dependencies: none
- Primary owners: core protocol, MCP bridge, extension controller

## 1. Objective

Guarantee FIFO, non-overlapping command execution inside one session while retaining
parallel execution across different sessions. Make duplicate calls and timeouts safe by
adding session epochs, monotonic sequences, bounded queues, request fingerprints, and
explicit execution outcomes.

Non-goals: global serialization, generic multi-action batching, automatic mutation
retry, persistent result storage, or changing the safety floor.

## 2. Current architecture and defects

- `packages/driver/src/controller.js:startSubscription` invokes `runCommand` directly
  for every subscription callback.
- `packages/driver/src/driver.js` has one mutable `activeActionSignals` window.
- `apps/mcp-server/src/bridge.ts` bounds global pending calls and commands waiting for a
  subscriber, but it can send multiple subscribed-session commands concurrently.
- `ActInput.idempotencyKey` exists in `packages/core/src/protocol.ts` but is not exposed
  by MCP or forwarded through the relay.
- A host timeout deletes its pending entry and returns `command_timeout`; it cannot say
  whether the extension had already dispatched the mutation.

## 3. Contract decisions

Add these public outcome values:

```ts
export type BrowserCommandOutcome =
  | "not_started"
  | "completed"
  | "prevented"
  | "outcome_unknown";
```

Every relay command/result carries `sessionEpoch` and `sequence`. Mutating MCP calls may
carry an `idempotencyKey` of 8-128 URL-safe characters. Reuse of a key with a different
normalized action hash returns `idempotency_conflict`. Results are cached in memory only,
per session, for ten minutes or 256 entries, whichever expires first.

Timeout rules are exact:

- still queued and never sent: `outcome: "not_started"`, safe to retry;
- sent to the extension but no terminal result: `outcome: "outcome_unknown"`, never
  automatically retried;
- blocked before dispatch: `outcome: "prevented"`;
- terminal extension result: `outcome: "completed"`.

## 4. File manifest

| Operation | File | Purpose |
| --- | --- | --- |
| add | `packages/driver/src/session-command-pump.js` | FIFO queue, close barrier, byte/item bounds |
| add | `packages/driver/test/session-command-pump.test.js` | isolated ordering/fairness/finalize tests |
| edit | `packages/core/src/protocol.ts` | public outcomes and act-result fields |
| edit | `packages/core/src/transport.ts` | epoch/sequence/idempotency relay types |
| edit | `packages/core/src/action-schema.ts` | validate the idempotency key at the public boundary |
| edit | `packages/driver/src/controller.js` | one pump per `SessionController`; enqueue subscription callbacks |
| edit | `apps/mcp-server/src/bridge.ts` | one in-flight dispatch per session, result ledger, late-result tombstones |
| edit | `apps/mcp-server/src/mcp-server.ts` | expose/forward `idempotencyKey`; map outcomes |
| edit | `packages/driver/test/controller.test.ts` | same-session and cross-session concurrency regressions |
| edit | `apps/mcp-server/test/host.test.ts` | duplicate, conflict, timeout, late-result tests |
| edit | `scripts/smoke/multi-client.mjs` | prove cross-session concurrency remains intact |
| edit | `scripts/smoke/stress.mjs` | report per-session queue/in-flight violations |
| edit | `docs/DECISIONS.md` | command-ordering and retry contract |
| edit | `test/evidence/bugs.md` | deterministic overlap/timeout defects |
| edit | `test/evidence/qa-ledger.md` | packed/live evidence |
| delete | none | — |

## 5. Implementation

### Slice 1 — Pure pump

Implement a dependency-free queue whose executor is supplied by the controller:

```js
export class SessionCommandPump {
  constructor({ maxItems = 32, maxBytes = 1024 * 1024 } = {}) {
    this.queue = [];
    this.queuedBytes = 0;
    this.running = false;
    this.closed = false;
  }

  enqueue(item, bytes, execute) {
    if (this.closed) throw new Error("session_finalizing");
    if (this.queue.length >= this.maxItems || this.queuedBytes + bytes > this.maxBytes) {
      throw new Error("session_queue_full");
    }
    return new Promise((resolve) => {
      this.queue.push({ item, bytes, execute, resolve });
      this.queuedBytes += bytes;
      void this.drain();
    });
  }
}
```

The real implementation must initialize bounds, use `try/finally`, settle every queued
promise, and expose `closeAfterCurrent()` for finalization. No command executes after the
finalize barrier.

### Slice 2 — Controller integration

Add `epoch`, `nextSequence`, `pump`, and lifecycle state to `SessionController`.
`startSubscription` validates the incoming epoch/sequence and enqueues the command.
`activeActionSignals` remains command-local because the pump proves only one executor is
active. Different `SessionController` instances retain independent pumps.

### Slice 3 — Host dispatch queue

Replace direct `sendCommand` for subscribed sessions with per-session dispatch state:

```ts
type SessionDispatchState = {
  epoch: number;
  nextSequence: number;
  inFlight: string | null;
  queue: BridgeCommand[];
  queuedBytes: number;
};
```

Send the next command only after a terminal result or a proven pre-dispatch cancellation.
When the caller times out after send, retain a bounded tombstone so a late result is
classified and optionally stored in the idempotency ledger instead of being attached to a
new request.

### Slice 4 — Idempotency ledger

Normalize and hash `{sessionId, action}` at the MCP host. The ledger stores no raw input
values beyond the already-bounded terminal result. Clear it on session stop. A duplicate
in-flight key joins the original promise; a duplicate terminal key returns the cached
result; a different hash fails before dispatch.

### Slice 5 — Public results and metrics

Return `sessionEpoch`, `sequence`, `outcome`, `retrySafe`, and `lateResultDiscarded` where
applicable. Add queue length/bytes and late-result counters to full diagnostic status,
never to compact status by default.

## 6. Verification

Required focused tests:

1. Two simultaneous clicks in one session execute strictly FIFO with no overlapping
   `mousePressed`/`mouseReleased` sequence.
2. A blocked first command cannot stall the second.
3. Two sessions make progress concurrently while one session waits.
4. Same idempotency key and payload dispatch once; same key/different payload dispatches
   zero times and returns `idempotency_conflict`.
5. Timeout before send is `not_started`; timeout after send is `outcome_unknown`.
6. A late old-epoch result cannot resolve a new command.
7. Finalize races have one documented order and leave no queued work.
8. Queue item and byte caps fail deterministically without affecting other sessions.

Commands:

```text
pnpm build:core
node --test packages/driver/test/session-command-pump.test.js packages/driver/test/controller.test.ts
node --test apps/mcp-server/test/host.test.ts
pnpm smoke:multi-client
pnpm lint
pnpm typecheck
pnpm test
git diff --check
```

## 7. Exit criteria and rollback

The plan exits only when the stress harness reports zero same-session overlap and
cross-session progress is unchanged. Rollback removes the pump integration and new public
fields together; never retain idempotency claims without the ledger and fencing behavior.

Implementation is not started until conversational approval. This plan does not authorize
publishing, store submission, credential entry, destructive actions, or live external
effects.
