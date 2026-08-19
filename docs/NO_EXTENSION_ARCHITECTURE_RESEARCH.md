# No-extension architecture

Status: implemented current architecture, updated 2026-08-19.

## Conclusion

Newton does not need a Chrome extension. The MCP host owns a dedicated Chrome or Edge
process, opens a private inherited CDP pipe, creates one blank root target through
browser-level CDP, and passes a one-shot transport bootstrap to the TypeScript driver.
This removes extension refresh/store/version parity, service-worker lifecycle, pairing,
relay, current-tab ownership, and duplicate MCP/extension contracts.

## Runtime shape

```text
Codex or another MCP client
  -> stateless MCP 2026-07-28 over stdio
    -> direct browser host
      -> owned runtime + guardian
        -> isolated Newton identity lease
        -> Chrome/Edge process
          -> inherited private CDP pipe
            -> one Newton-owned target and its frame/worker graph
```

There is no TCP debugging port, MCP listener, installed daemon, extension, proxy, hosted
service, telemetry path, or database.

## Networking decision

The earlier proposal put a deny-by-default exact-origin proxy in front of every browser.
Real-site and operator-login evidence invalidated that product decision. Modern sites use
regional authentication redirects, cross-origin APIs, fonts, images, frames, workers,
popups, and browser services. Denying those destinations produced inert controls, broken
CSS/icon rendering, sign-out loops, `ERR_BLOCKED_BY_CLIENT`, and connection error `-111`.

The current product therefore uses ordinary Chromium networking. The required session
`origin` is an initial URL and optional identity-binding key, not an allowlist. Newton does
not intercept Fetch, patch page networking APIs, or disable browser services. A deployment
that needs destination isolation must enforce it outside Newton.

## Profile model

Newton never attaches to or writes the operator's active profile. Each session owns an
isolated identity and exclusive lease. With explicit authorization, a closed stable
Chrome/Edge profile may be opaque-copied through a narrow allowlist into a new identity.
Source files are not parsed or modified, and password/autofill/history/download/extension/
session/service-worker/cache data is excluded.

This preserves the useful part of agent-browser's profile-copy idea without broad copying,
plaintext state export, unauthenticated debugging ports, or direct reuse of a live profile.

## Agent efficiency

The public surface remains ten tools with compact accessibility observations, stable refs,
flat actions, diff results, one canonical outcome envelope, bounded console/network reads,
and dedicated screenshot image content. Sessions serialize their own commands while
independent sessions run concurrently.

## Safety retained without page breakage

- isolated process/profile ownership and guardian cleanup;
- private CDP transport and exact target/session registry;
- stale-ref and pre-input actionability checks;
- automatic credential/payment/sensitive-identifier input blocking;
- truthful uncertainty after potentially committed input;
- no arbitrary JavaScript tool;
- page content treated as untrusted data;
- non-mutating observation and trusted post-capture raster masking.

## Explicit non-goals

- attaching to the operator's currently running Chrome;
- extension or browser-store distribution;
- provider-specific network allowlists;
- legacy MCP or socket compatibility;
- broad profile/state export or merge-back;
- page modifications that make automation appear easier at the cost of site fidelity.
