# Plan 10 — Owned Browser Runtime and Private CDP

Status: complete

Depends on: Plans 01, 02, 06 contracts

Supersedes: extension relay as the target startup path

> Completed implementation record. The final product uses only inherited private CDP
> pipes; the draft WebSocket adapter and bridge integration were deleted before release.

## Outcome

The MCP host launches and supervises one isolated Chrome or Edge process per browser
session. CDP uses inherited pipes only. A browser is never published as ready until process ownership,
CDP framing, blank profile state, and cleanup registration are established.

## Files

Add:

- `apps/mcp-server/src/browser-runtime/cdp-pipe.ts`
- `apps/mcp-server/src/browser-runtime/browser-discovery.ts`
- `apps/mcp-server/src/browser-runtime/chromium-process.ts`
- `apps/mcp-server/src/browser-runtime/process-supervisor.ts`
- `apps/mcp-server/src/browser-runtime/browser-guardian.ts`
- `apps/mcp-server/src/browser-runtime/owned-browser-runtime.ts`
- matching tests under `apps/mcp-server/test/browser-runtime/`

Final integration paths:

- `apps/mcp-server/src/mcp-server.ts`
- `apps/mcp-server/src/browser-runtime/direct-browser-host.ts`
- `apps/mcp-server/src/browser-runtime/configured-direct-host.ts`
- `apps/mcp-server/package.json`
- root package/build scripts and lockfile

## Contracts

```ts
interface CdpConnection {
  request<T>(method: string, params?: Readonly<Record<string, unknown>>,
    sessionId?: string): Promise<T>;
  subscribe(listener: (event: CdpEvent) => void): () => void;
  close(reason: CdpCloseReason): Promise<void>;
}

interface OwnedBrowserProcess {
  readonly pid: number;
  readonly browser: "chrome" | "edge";
  readonly profileRoot: string;
  readonly cdp: CdpConnection;
  stop(): Promise<BrowserStopReceipt>;
}
```

- CDP request IDs are host-owned safe integers; unknown/duplicate IDs fail closed.
- Input is incrementally framed with explicit byte, pending-request, listener, and event
  queue caps. EOF rejects every unresolved request once.
- Browser stderr is reduced to bounded closed diagnostic categories; page text, command
  payloads, URLs, headers, and profile paths never enter public results.
- Launch uses Chromium's `--no-startup-window`, then creates one exact `about:blank`
  target through browser-level CDP with an exact Newton-owned `--user-data-dir`; it never
  selects a restored/preexisting tab and opens no remote-debugging TCP port. Chromium
  documents the switch in `chrome/common/chrome_switches.cc` as suppressing automatic
  browser-window startup.
- Readiness is an acknowledged CDP state transition, not a delay or log-string poll.
- Stop first fences new commands, closes CDP/browser, waits for process exit, then performs
  identity cleanup according to the session disposition. A partial stop is uncertainty,
  remains retryable internally, and is never reported as clean completion.

## Implementation sequence

1. Implement/test byte framing and request/event correlation with fakes.
2. Implement deterministic executable discovery with explicit-path precedence.
3. Implement launch argument construction separately from spawning; snapshot-test every
   security-relevant switch and reject conflicting caller arguments.
4. Implement process state machine: `created -> spawning -> cdp_ready -> running ->
   stopping -> stopped`, with terminal `failed` carrying a closed phase code.
5. Launch Chromium through a separate local guardian. The guardian owns the detached
   browser process tree and an identity-bound cleanup plan, survives MCP-host disconnect,
   and releases only exact marker/dev/ino/nonce-matched state. Windows uses exact tree
   termination; POSIX uses the dedicated browser process group.
6. Integrate as the sole runtime and remove the former compatibility control plane under
   Plan 15. This step is implemented; final evidence still gates release completion.

## Required regressions

- split/coalesced/malformed/oversized CDP frames; duplicate and unknown response IDs;
- write backpressure, connection loss, unsubscribe, event overflow, and pending cap;
- spawn error, early exit, readiness rejection, stop during startup, repeated stop;
- hostile executable/profile paths and conflicting debug/profile flags;
- no listener, child process, temp profile, or unresolved promise after every failure.

## Exit gates

Focused strict TypeScript and tests pass; packed MCP can launch a disposable blank Chrome
and Edge on Windows and Chrome on Linux without an extension; no debug TCP listener is
observable; forced host termination leaves no process/profile residue in the owned test
root.
