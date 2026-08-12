# Plan 13 — Direct Driver and Host Collapse

Status: complete; integrated source, packed, Windows, and Linux QA passed

Depends on: Plans 10–12

## Outcome

The existing strict TypeScript driver runs inside the MCP host against an injected CDP
connection. Extension tabs, `chrome.debugger`, relay ownership, pairing, and MV3 worker
lifecycle have been removed from the product. Per-session FIFO, cross-session concurrency,
idempotency, outcome truth, composite refs, renderer handling, and cleanup remain.

## Files

Final driver paths:

- `packages/driver/src/types.ts`
- `packages/driver/src/driver.ts`
- `packages/driver/src/direct-debugger-port.ts`
- `packages/driver/src/direct-page-effects-port.ts`
- `packages/driver/src/direct-session-runtime.ts`

Final host integration paths:

- `apps/mcp-server/src/browser-runtime/direct-browser-host.ts`
- `apps/mcp-server/src/browser-runtime/configured-direct-host.ts`
- `apps/mcp-server/src/browser-runtime/default-direct-host.ts`
- `apps/mcp-server/src/mcp-server.ts`
- `packages/core/src/protocol.ts`
- direct-runtime integration tests under `apps/mcp-server/test/browser-runtime/`

Deleted by Plan 15 after parity evidence:

- `apps/extension/**`
- `packages/driver/src/controller.ts`
- `apps/mcp-server/src/bridge.ts`
- legacy local transport and extension artifact scripts

## Refactor contract

```ts
interface DriverTransport {
  send<T>(method: string, params?: object, sessionId?: string): Promise<T>;
  onEvent(listener: (event: DriverProtocolEvent) => void): () => void;
  close(): Promise<void>;
}

interface SessionRuntime {
  readonly sessionId: string;
  readonly epoch: number;
  execute(command: BrowserActionCommand): Promise<BrowserActionResult>;
  finalize(disposition: CleanupDisposition): Promise<void>;
}
```

- Driver code depends on `DriverTransport`, never `chrome.debugger` or extension globals.
- One session owns process + proxy + identity lease + CDP + controller + command pump.
- Same-session work stays FIFO; different sessions never share a mutex or browser process.
- Startup transaction order is proxy -> identity lease -> browser -> CDP -> containment ->
  initial granted navigation -> initial observation -> publication.
- Rollback is the reverse and preserves uncertainty. Publication is the commit point.
- `session.stop` is acknowledged only after process/proxy/leases are cleaned or retained by
  explicit disposition. Host continuity retains runtime ownership in one process; it does
  not introduce a daemon.
- Overlay/screenshot behavior that depended on extension APIs is replaced through CDP or
  explicitly deferred without weakening masking guarantees.

## Implementation sequence

1. Extract transport interfaces while legacy adapter tests still pass.
2. Add a direct-CDP adapter and run the same driver contract suite against both adapters.
3. Create `SessionRuntime` and inject existing command pump/controller semantics.
4. Select direct runtime privately, then make it default after live parity.
5. Remove bridge concepts that exist only for extension ownership, but retain stdio/Unix
   continuity and MCP framing.
6. Delete legacy adapter only in Plan 15.

## Required regressions

Startup/rollback at every await; process/proxy/CDP loss; detach during action; queued and
sent timeout distinction; idempotent retry; finalize conflicts; two sessions executing
concurrently; origin/proxy isolation; frame/OOPIF action routing; dialog/renderer recovery;
masked screenshots; host reconnect and shutdown with exact residue checks.

## Exit gates

The packed MCP controls owned Chrome/Edge without an installed extension. The full driver
contract passes against direct CDP. Multi-session stress shows zero same-session overlap
and real cross-session progress. No legacy relay is opened in direct mode.
