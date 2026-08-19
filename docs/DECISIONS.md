# Architecture decisions

This file records the current architecture only. Extension, relay, daemon, proxy,
origin-grant, and transition-era decisions remain in Git history, not as supported
alternatives.

## 1. One direct runtime

Newton owns one isolated Chrome or Edge process per session. It does not attach to the
operator's ordinary browser or use an extension, relay, pairing plane, daemon, browser
store, continuity socket, current-tab control, or tab handoff.

## 2. Stateless modern MCP only

The public control plane is MCP `2026-07-28` over newline-delimited stdio JSON. Every
request carries protocol version and client capabilities. Newton implements
`server/discover`, `tools/list`, `tools/call`, and cancellation. It has no initialization
handshake, session header, legacy framing, or fallback.

## 3. Private browser transport

Chromium launches blank-first with inherited CDP pipes and `--no-startup-window`. Newton
creates the exact root target through browser-level CDP and gives the driver a one-shot
private bootstrap. A TCP debugging endpoint is never used.

## 4. Normal Chromium networking

The session `origin` is the initial HTTP(S) URL and may select an operator-owned identity.
It is not a network boundary. Redirects, subresources, frames, workers, popups, regional
domains, authentication endpoints, and browser dependencies use Chromium's ordinary
network stack.

Newton has no policy proxy, destination allowlist, CDP Fetch interception, request denial,
or page API patching. It does not disable background networking, component updates,
extensions, sync, or default apps. If a deployment requires destination-level network
isolation, it must provide that outside Newton with an OS, browser, or network boundary.

## 5. Isolated identity ownership

Each session leases one Newton-owned identity. A guardian owns the exact browser tree and
cleanup facts. Host or browser loss triggers process-first cleanup; uncertain cleanup is
retained and retryable.

With explicit operator authorization, Newton may opaque-copy a narrow allowlist from a
closed stable profile. It never parses or exports profile data, excludes passwords,
autofill, history, downloads, extensions, sessions, service workers, and caches, and never
modifies or merges back into the source.

## 6. No page modification for observation

Observation is read-only CDP/DOM/accessibility work. Newton does not install persistent
mutation observers, emulate focus, inject UI, freeze scripts or animations, or otherwise
change the page to make automation easier. Trusted input uses Chromium's input protocol.
Sensitive screenshot regions are measured before capture and masked afterward in trusted
Node code.

## 7. Compact public browser contract

The public surface is ten tools: status, session start/list/stop/stop-all, observe, act,
screenshot, console, and network. Targeted actions use flat fields. Refs come from a fresh
observation. One idempotency key represents one logical effect. Same-session work is FIFO;
different sessions progress concurrently.

The action floor still blocks automatic entry of credentials, payment data, and sensitive
identifiers. Commit and external-effect metadata describe risk; they do not authorize an
action. `browser.session.stop` is the only finalization path.

## 8. Truthful outcomes

The outer result supplies authoritative status, outcome, retry classification, decision,
and bounded errors. Page-derived payloads carry untrusted-data provenance. A command that
may have crossed a commit boundary reports uncertainty and must not be retried
automatically.

## 9. No compatibility surface

Deleted extension, socket, legacy MCP, proxy, origin-grant, Fetch-containment,
page-effects, synthetic-tab, ownership, finalize, and result-alias branches must not be
reintroduced. Unsupported fields and clients fail clearly.

## 10. Completion and release

Implementation is complete only after one frozen tree passes typecheck, deterministic and
packed tests, live Chrome and Edge workflows, real public-site rendering/action QA,
process/profile cleanup evidence, and three consecutive unchanged-tree release gates.
Publishing, remotes, public distribution, and license changes require separate approval.
