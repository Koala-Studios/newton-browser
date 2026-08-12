# Architecture decisions

This file records the current architecture only. Extension-era and transition-era
decisions remain available in Git history, not as supported alternatives.

## 1. One direct runtime

Newton owns one isolated Chrome or Edge process per session. It does not attach to the
operator's ordinary browser or use an extension, relay, pairing plane, daemon, browser
store, continuity socket, current-tab control, or tab handoff.

## 2. Stateless modern MCP only

The public control plane is MCP `2026-07-28` over newline-delimited stdio JSON. Every
request carries protocol version and client capabilities. Newton implements
`server/discover`, `tools/list`, `tools/call`, and cancellation. It does not implement an
initialization handshake, connection-scoped headers, legacy framing, or fallback.
Successful results declare `resultType:"complete"`.

## 3. Private browser transport

Chromium launches blank-first with inherited CDP pipes and `--no-startup-window`. Newton
creates the exact root target through browser-level CDP and gives the driver a one-shot
private bootstrap. A TCP debug endpoint is never used.

## 4. Exact-origin containment before navigation

Each session requires one normalized HTTP(S) origin plus explicit additional origins.
The policy proxy is listening before Chromium starts. Browser-level Target/Fetch control
is defense in depth. Resource type, same-site relationship, page content, redirect, DNS,
and browser state do not widen the grant.

## 5. Isolated identity ownership

Each session leases one Newton-owned identity. A guardian owns the exact browser tree and
cleanup facts. Host or browser loss triggers process-first cleanup; uncertain cleanup is
retained and retryable.

With explicit operator authorization, Newton may opaque-copy a narrow allowlist from a
closed stable profile. It never parses or exports profile data, and excludes passwords,
autofill, history, downloads, extensions, sessions, service workers, and caches. It never
modifies or merges back into the source.

## 6. Compact public browser contract

The public surface is ten tools: status, session start/list/stop/stop-all, observe, act,
screenshot, console, and network. Targeted actions use flat fields. Refs come only from a
fresh observation. One idempotency key represents one logical effect. Same-session work is
FIFO; different sessions progress concurrently.

Resolved element facts are checked inside that FIFO immediately before dispatch, so a
generic ref cannot bypass credential/payment blocking. Newton has no human-approval
protocol: `decision.commitBoundary` reports commit risk, while `decision.class:"blocked"`
is the only non-containment floor rejection.

`browser.session.stop` is the only finalization path. There are no handoff, deliverable,
retained-tab, or detach modes.

## 7. Truthful outcomes

The outer result supplies authoritative status, outcome, retry classification, decision,
and bounded errors. Page-derived payloads additionally carry host-authored untrusted-data
provenance; control acknowledgements do not fabricate it. A command that may have crossed
a commit boundary reports uncertainty and must not be retried automatically.

## 8. Trusted screenshot boundary

Screenshots return MCP image content only. Sensitive zones are resolved and page script is
frozen before capture; PNG pixels are masked in trusted Node code. Any geometry, freeze,
capture, decode, mask, or resume uncertainty fails closed. There is no caller-path file
delivery or legacy inline mode.

## 9. No compatibility surface

Deleted extension, socket, legacy MCP, page-effects, synthetic-tab, ownership, finalize,
and result-alias branches must not be reintroduced. Unsupported clients fail clearly.

## 10. Completion and release

Implementation is complete only after one frozen tree passes typecheck, deterministic and
packed tests, live Chrome and Edge workflows, real public-site QA, cleanup/containment
evidence, and three consecutive unchanged-tree release gates. Publishing, remotes,
public distribution, and changes to the existing MIT license require separate approval.
