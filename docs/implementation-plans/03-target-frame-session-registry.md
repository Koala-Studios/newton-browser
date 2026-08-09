# Plan 03: Target, Frame, and CDP Session Registry

- Status: approval required
- Classification: core browser-target foundation
- Dependencies: Plans 01 and 02

## 1. Objective

Represent every page, frame, popup, and worker target attached to a Newton session and
route CDP commands through the correct flattened child session. Support OOPIF observation
and action without weakening exact-origin grants or allowing reference collisions.

Non-goals: multi-tab sessions, worker DOM observation, cross-origin access without an
explicit grant, or silent stale-ref healing.

## 2. Contract decisions

- Require Chromium 125+ for flattened child-session routing; declare the floor in the
  extension manifest, install docs, doctor, and status.
- Main-document refs become `d<epoch>:e<backendNodeId>`; child-frame refs become
  `d<epoch>:f<ordinal>:e<backendNodeId>`.
- A top-level document commit increments the document epoch and invalidates every prior
  ref. Detached child targets invalidate their refs immediately.
- Cross-origin frames are listed as bounded excluded-frame metadata unless their exact
  origin is in `allowedOrigins`.
- Workers enter the target registry for containment/events only and never enter the
  actionable element tree.

This is a public reference-format change and must ship in a versioned minor release with
updated skills and compatibility notes.

## 3. File manifest

| Operation | File | Purpose |
| --- | --- | --- |
| add | `packages/driver/src/target-registry.js` | target/frame/session graph and ref codec |
| add | `packages/driver/test/target-registry.test.js` | graph, epoch, detach, collision tests |
| edit | `packages/core/src/protocol.ts` | frame provenance, excluded-frame, ref epoch fields |
| edit | `packages/core/src/redaction.ts` | bound/redact new provenance fields |
| edit | `packages/driver/src/driver.js` | flattened-session event handling and routed CDP |
| edit | `packages/driver/src/controller.js` | pass complete debugger source to the driver |
| edit | `packages/driver/src/chrome-tabs-port.js` | preserve `source.sessionId` and browser version facts |
| edit | `apps/extension/src/service-worker.js` | initialize version capability and event routing |
| edit | `apps/extension/manifest.json` | `minimum_chrome_version: "125"` |
| edit | `apps/mcp-server/src/bridge.ts` | browser-version readiness and capability status |
| edit | `apps/mcp-server/src/mcp-server.ts` | status/observation provenance contract |
| edit | `packages/driver/test/driver.test.js` | frame-aware observe/resolve/act tests |
| edit | `apps/extension/test/extension.test.ts` | debugger-source routing tests |
| edit | `test/fixtures/app/index.html` | deterministic OOPIF/granted-frame controls |
| edit | `test/fixtures/app/frame.html` | frame navigation/rerender controls |
| edit | `test/fixtures/server.mjs` | optional third origin for OOPIF matrix |
| edit | `README.md` and `docs/MCP_CLIENTS.md` | new ref lifetime, recovery, and frame provenance contract |
| edit | `docs/INSTALL.md` and `docs/TROUBLESHOOTING.md` | Chromium floor and debugger diagnostics |
| edit | `docs/DECISIONS.md` and evidence ledgers | contract/evidence |
| delete | none | — |

## 4. Registry design

```js
class TargetRegistry {
  constructor() {
    this.documentEpoch = 0;
    this.targets = new Map();       // targetId -> TargetRecord
    this.frames = new Map();        // frameId -> FrameRecord
    this.sessionToTarget = new Map();
    this.refToNode = new Map();     // composite ref -> routed node identity
  }
}

// TargetRecord
// { targetId, sessionId, type, parentTargetId, frameId, origin,
//   state: "waiting"|"active"|"detached", epoch }
```

Never use backend node ID alone as a cross-frame identity.

## 5. Implementation

### Slice 1 — Registry and ref codec

Implement pure add/update/detach/frame-navigation operations and deterministic frame
ordinals. Unit-test out-of-order attach/detach and ID reuse before changing the driver.

### Slice 2 — Routed CDP client

Change the driver helper to accept a route:

```js
cdp(method, params = {}, { sessionId, timeoutMs = CDP_TIMEOUT_MS } = {}) {
  const debuggee = sessionId
    ? { tabId: this.tabId, sessionId }
    : { tabId: this.tabId };
  return sendBounded(debuggee, method, params, timeoutMs);
}
```

Route target events using the `chrome.debugger.onEvent` source session ID. Recursive
auto-attach is installed on each attached child session.

### Slice 3 — Frame-aware observation

Fetch AX trees per eligible page/frame session, attach `{documentEpoch, frameId,
frameOrigin}` provenance, and translate frame-local boxes into top-level viewport
coordinates only when required internally. Do not return geometry by default after Plan
06.

### Slice 4 — Frame-aware target resolution

Decode the composite ref, verify epoch and target liveness, route DOM/focus/hit-test/input
through the recorded session, and return `stale_target` or `frame_detached` rather than
searching for a similar element.

### Slice 5 — Capability/readiness reporting

Fail session readiness with `browser_version_unsupported` when flattened child routing is
unavailable. Never silently downgrade to an incomplete registry while claiming OOPIF
support.

## 6. Verification

Test main frame, same-process iframe, OOPIF, nested OOPIF, popup, dedicated worker,
module worker, detach, navigation epoch, backend-node collision, and unrelated-tab events.
For an ungranted frame, assert zero readable nodes and a bounded excluded-frame record.
For a newly granted origin, assert observation and action route through the exact child
session.

Commands:

```text
node --test packages/driver/test/target-registry.test.js packages/driver/test/driver.test.js
node --test apps/extension/test/extension.test.ts apps/mcp-server/test/host.test.ts
pnpm smoke:real-browser
pnpm smoke:current-tab
pnpm lint
pnpm typecheck
pnpm test
pnpm pack:check
git diff --check
```

Live evidence is required in Chrome and Edge on Windows plus Chrome on Linux before the
version floor and new ref format are considered shipped.

## 7. Exit and rollback

Exit requires correct OOPIF routing and immediate ref invalidation on document/target
loss. Rollback returns the old ref contract and removes every claim of OOPIF support; a
mixed ref format is not acceptable.

Implementation is not started until conversational approval.
