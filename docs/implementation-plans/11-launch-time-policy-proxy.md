# Plan 11 — Launch-Time Preventive Policy Proxy

Status: complete

Depends on: Plan 10 launch contract, Plan 04 containment semantics

> Completed implementation record. The original bridge integration point below was
> replaced by the owned runtime and direct host before the extension/relay deletion.

## Outcome

Every owned browser session receives a dedicated deny-by-default loopback proxy. The
proxy is listening and has the exact normalized origin grant before Chrome starts, so a
top-level popup or navigation cannot issue its first ungranted TCP request. CDP target and
Fetch interception remain defense-in-depth and observability, not the sole network gate.

## Files

Add:

- `apps/mcp-server/src/browser-runtime/policy-proxy.ts`
- `apps/mcp-server/test/browser-runtime/policy-proxy.test.ts`

Integrate later in:

- `apps/mcp-server/src/browser-runtime/chromium-process.ts`
- `packages/driver/src/origin-containment.ts`
- `packages/driver/src/driver.ts`
- `apps/mcp-server/src/browser-runtime/owned-browser-runtime.ts`
- `apps/mcp-server/src/browser-runtime/direct-browser-host.ts`

## Policy contract

```ts
type GrantedOrigin = `${"http" | "https"}://${string}`;
type ProxyDecision =
  | { kind: "allow"; origin: GrantedOrigin }
  | { kind: "deny"; reason: ProxyDenyReason };

interface PolicyProxyReceipt {
  allowedConnections: number;
  deniedConnections: number;
  deniedByReason: Readonly<Record<ProxyDenyReason, number>>;
  activeConnections: number;
}
```

- Grants compare canonical scheme, ASCII host, and effective port. No suffix, same-site,
  redirect, DNS, IP, or inherited-origin inference.
- HTTP absolute-form requests, CONNECT authorities, and WebSocket upgrades are validated
  before an upstream socket exists.
- CONNECT exposes no trustworthy resource class. Third-party HTTPS dependencies require
  explicit exact-origin grants; passive-resource exceptions apply only to visible HTTP
  request metadata.
- Reject ambiguous/multiple Host, userinfo, invalid/alternate ports, obs-fold, conflicting
  length/transfer framing, proxy authorization, unsupported schemes, and malformed lines.
- Proxy state stores only bounded counts and closed reason codes. It never logs or exposes
  URLs, paths, query strings, headers, bodies, IP addresses, or page content.
- Proxy startup precedes browser spawn. Proxy loss immediately makes the session
  containment-unavailable, fences actions, and stops the browser.
- Loopback, browser internal traffic, DNS resolution, QUIC, WebRTC, extensions, service
  workers, direct sockets, and proxy bypass flags receive explicit handling. Chrome launch
  disables QUIC and bypasses no destination; any unavoidable Chromium control exception
  is exact, documented, and not agent-configurable.

## Implementation sequence

1. Build a pure parser/decision layer and adversarial tests.
2. Add a capped loopback server that decides before dialing upstream.
3. Implement HTTP forwarding and CONNECT tunneling with bounded buffers/backpressure and
   half-close/error cleanup. Upgrade follows the HTTP grant, not a separate permissive path.
4. Wire launch flags (`--proxy-server`, empty bypass list, QUIC disable) only after the
   listener is ready; remove flags on teardown by terminating the owned process.
5. Keep proxy receipts aggregate-only. Never infer which command caused a request from a
   temporal overlap window.
6. Let exact CDP main-document and related-target tickets author `prevented` outcomes;
   compare aggregate proxy and destination counters in live tests without rewriting an
   unrelated action result.

## Required regressions

- denied HTTP, HTTPS CONNECT, WS/WSS, redirect, popup, form, iframe, worker, fetch, beacon,
  EventSource and mixed framing create zero destination connections;
- explicit allowed origin succeeds and a changed scheme/host/port fails;
- IPv4/IPv6 literals, IDNA, trailing dots, credentials, default/nondefault ports, duplicate
  Host and request smuggling forms;
- upstream/downstream abort, cap exhaustion, proxy crash, browser crash, stop with active
  tunnel, and repeated cleanup;
- concurrent session proxies cannot reuse ports, grants, counters, or connections.

## Exit gates

Server-side destination counters prove zero application requests for every denied class
on Windows Chrome/Edge and Linux Chrome. Allowed exact origins continue. A proxy crash
cannot leave a browser running or a session actionable. No raw request data appears in
logs, receipts, MCP output, or evidence.
