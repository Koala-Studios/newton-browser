# Plan 04 — Preventive Origin Containment

- **Status:** Complete through the owner-approved isolated-browser Plan 04B architecture;
  the MV3 limitation below remains historical rationale
- **Depends on:** Plan 03 target/frame/session registry
- **Primary outcome:** Newton prevents controlled targets and mutating requests from crossing the session grant, rather than discovering the violation only after an effect may have occurred.

## Why this is a must-do

Post-action origin checks cannot undo a navigation, form submission, popup, worker bootstrap, WebSocket connection, or beacon. An agent needs a truthful distinction between an operation that was prevented and one whose outcome is uncertain. This is a safety and reliability requirement, not merely a better error message.

Newton will not claim to be a complete browser-network sandbox. In the approved
owned-browser architecture, its launch-time proxy and CDP controls require every upstream
destination, including subresources, to match an explicit session origin grant.

## Historical MV3 platform blocker

Chrome for Testing 151 rejected `Target.attachToBrowserTarget` through
`chrome.debugger`, so an ordinary extension cannot use browser-target-only
`Target.autoAttachRelated`. A disposable tab-root `Target.setAutoAttach` probe
was then accepted by Chrome but did not pause a `window.open(..., "noopener")`
popup: the action completed and the exact denied destination document reached
the fixture server once. The bounded receipt is
[`aip04-root-autoattach-probe.json`](../../test/evidence/aip04-root-autoattach-probe.json).

The probe met its mandatory rollback criterion and was not promoted. The owner selected
the dedicated Newton-owned browser/profile path. The direct runtime's launch-time policy
proxy now supplies the zero-first-destination boundary and browser/CDP controls remain
defense in depth. The extension-only boundary still cannot truthfully guarantee general
popup prevention and remains migration-only.

The two authored alternatives preserve the decision history:

- [Plan 04A](04a-extension-popup-boundary.md) retains the extension-only and
  existing-profile architecture, narrows the popup guarantee, preflights directly
  identifiable declarative `_blank` actions, and reports script-popup outcomes honestly.
- [Plan 04B](04b-isolated-browser-strict-containment.md) preserves the strict first-request
  guarantee by adding a Newton-owned isolated Chromium backend with browser-level CDP.

## Enforceable boundary

For a session grant containing the normalized primary origin and explicit allowed origins:

- Prevent top-level and controlled-frame navigation to an ungranted origin, including HTTP redirects.
- Pause newly created subframe and worker targets inside the attached target tree until
  their initial URL is reconciled with the grant. General top-level popups are included
  only if the owner approves Plan 04B; Plan 04A deliberately narrows that guarantee.
- Prevent mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`) and beacon-like requests to ungranted origins.
- Prevent ungranted WebSocket and EventSource connection attempts when observable through the installed CDP interception path.
- Require ordinary `GET`/`HEAD` third-party subresources such as CDNs, fonts, images, and analytics to be explicitly granted.
- Never return response bodies from an ungranted origin.
- Treat WebRTC and traffic outside the attached target tree as outside this guarantee. Documentation must not describe Newton as total browser network isolation.

## Files

### Add

- `packages/driver/src/origin-containment.ts` — grant compiler, request/target decision engine, and CDP Fetch lifecycle.
- `packages/driver/test/origin-containment.test.js` — table-driven policy and redirect tests.
- `test/fixtures/origin-containment/` — two-origin fixture with redirect, form, beacon, socket, popup, iframe, and worker endpoints.
- `scripts/smoke/origin-containment-live.mjs` — real-Chromium prevention proof.

### Edit

- `packages/core/src/protocol.ts` — preventive decision and outcome types.
- `packages/core/src/host-policy.ts` — shared normalized grant evaluation without URL string-prefix comparisons.
- `packages/core/src/risk.ts` — classify mutating requests and target creation risk.
- `packages/driver/src/driver.ts` — install containment on every attached target and route Fetch events.
- `packages/driver/src/controller.ts` — require containment readiness before a command can execute.
- `packages/driver/src/target-registry.ts` — hold paused targets until grant reconciliation completes.
- `apps/extension/src/service-worker.js` — preflight explicit navigation requests and current-tab attachment.
- `apps/mcp-server/src/bridge.ts` — preserve preventive decisions and uncertain outcomes.
- `apps/mcp-server/src/mcp-server.ts` — expose the structured result without implying an effect was rolled back.
- `README.md`, `docs/SECURITY.md`, `docs/PRIVACY.md`, and `docs/DECISIONS.md` — state the exact guarantee and exclusions.
- `test/evidence/security-audit.md` — record deterministic zero-request evidence.

### Delete

- None.

## Design

### 1. Compile the grant once

The compiler accepts only normalized HTTP(S) origins. It rejects paths, credentials, wildcard hosts, opaque origins, and non-default-port equivalence mistakes.

```js
export function compileOriginGrant(primaryOrigin, allowedOrigins = []) {
  const origins = new Set(
    [primaryOrigin, ...allowedOrigins].map(normalizeHttpOrigin),
  );

  return Object.freeze({
    contains(url) {
      return origins.has(normalizeHttpOrigin(url));
    },
    origins: Object.freeze([...origins]),
  });
}
```

All driver, extension, and MCP checks must consume the same normalization vectors from `packages/core`; implementations must not independently compare strings.

### 2. Pause before target execution

Set target auto-attach before beginning the session:

```js
await cdp.send("Target.setAutoAttach", {
  autoAttach: true,
  flatten: true,
  waitForDebuggerOnStart: true,
});
```

For each attached target:

1. Register the target and its parent.
2. Install Fetch interception and relevant Network/Runtime listeners.
3. Reconcile its URL and initiator against the session grant.
4. Close an owned, newly created ungranted target or detach from an unowned target.
5. Call `Runtime.runIfWaitingForDebugger` only after containment is active and the target is allowed.

For an existing current tab, fail closed by detaching and returning `prevented`; never close, reload, or navigate the user’s tab as cleanup.

### 3. Decide requests before continuation

```js
function decidePausedRequest({ request, resourceType, isNavigationRequest }, grant) {
  const granted = grant.contains(request.url);
  const method = request.method.toUpperCase();
  const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  const connection = resourceType === "WebSocket" || resourceType === "EventSource";

  if (granted) return { action: "continue", reason: "granted_origin" };
  if (isNavigationRequest) return { action: "fail", reason: "ungranted_navigation" };
  if (mutating) return { action: "fail", reason: "ungranted_mutation" };
  if (connection) return { action: "fail", reason: "ungranted_connection" };
  return { action: "fail", reason: "unsupported_ungranted_request" };
}
```

Redirect responses are re-evaluated at every paused request. A redirect inherits no trust from its original granted URL.

### 4. Return honest outcomes

The shared command outcome from Plan 01 is used consistently:

- `prevented`: Newton blocked the request/target before it was released.
- `completed`: the requested browser operation completed inside the grant.
- `outcome_unknown`: interruption occurred after release and Newton cannot prove whether the effect happened.
- `effect_detected` is a status/decision code paired with `outcome_unknown` when
  observation proves some effect occurred but cannot prove the requested command completed.

Do not call a post-action origin mismatch `prevented`.

## Implementation slices

1. Add common origin normalization vectors and the pure decision engine.
2. Install target pausing and containment during owned-tab session startup.
3. Add redirect, subframe, popup, and worker reconciliation.
4. Add preflight checks for explicit navigation and current-tab attachment.
5. Preserve decisions through bridge/MCP envelopes.
6. Add live two-origin evidence and update the security/privacy contract.

Each slice must include its tests and may not broaden timeouts to pass.

## Required tests

- Explicit ungranted navigation is rejected before `Page.navigate`.
- Granted URL redirecting to an ungranted origin produces zero requests to the destination application endpoint.
- Cross-origin form, fetch mutation, and beacon produce zero application requests.
- Ungranted popup and worker code do not execute.
- Ungranted controlled iframe is not resumed.
- Ungranted CDN image/stylesheet requests make zero destination connections; explicitly granted resources continue normally.
- Current-tab containment failure leaves the tab URL and contents untouched.
- Allowed-origin redirects and frames continue normally.
- A detach after release returns `outcome_unknown`, never `prevented`.

The fixture server must count received requests so prevention is proven by server-side evidence, not inferred only from a browser error.

## Exit criteria

- The exact guarantee and WebRTC/out-of-tree exclusions are documented.
- Every controlled target is paused until containment is installed.
- Deterministic tests prove zero unintended application requests for all blocked paths.
- Existing-origin and explicit allowed-origin workflows remain functional.
- `pnpm test`, security smoke tests, and packed-artifact smoke tests pass.

## Rollback

Rollback means reverting the entire preventive path and its public outcome contract together. Do not retain a partial mode that advertises prevention while relying on post-action reconciliation.
