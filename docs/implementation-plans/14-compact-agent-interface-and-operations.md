# Plan 14 — Compact Agent Interface and Operations

Status: complete; compact catalog, workflow budgets, and production-site QA passed

Depends on: Plan 13

## Outcome

No-extension operation remains at least as simple and token-efficient as Newton 0.4.5:
one MCP package, the existing 11 tools, automatic owned-browser startup, compact default
observations, stable refs, and no agent-visible CDP/process/proxy mechanics.

## Files

Edit:

- `apps/mcp-server/src/agent-output.ts`
- `apps/mcp-server/src/mcp-server.ts`
- `apps/mcp-server/src/config.ts`
- CLI entry/help and `README.md`
- `scripts/measure-agent-cost.mjs`
- `scripts/evals/**` only for direct-runtime fixtures/receipts

## Agent contract

- Keep the 11-tool public catalog unless measured task evidence justifies a change.
- `browser.session.start` accepts origin, allowed origins, browser preference, and an
  operator-created identity ID; it does not expose executable paths, CDP endpoints, proxy
  switches, profile paths, or raw browser lifecycle state.
- Default observation remains compact, scoped, geometry-free, provenance-marked, and
  bounded. Ref IDs remain short, deterministic within an epoch, and stale after mutation.
- Action results remain one normalized envelope with verified/prevented/unknown outcome and
  retry truth. Runtime diagnostics appear only in full status/doctor as counts and closed
  categories.
- CLI setup handles browser discovery and identity administration. Agents do not manage
  extensions, Chrome stores, developer mode, ports, profiles, or pairing secrets.

## Stable operator workflow

The direct runtime is the sole production path and is configured through stable local
commands, never through a second action protocol:

```text
newton-browser setup --browser chrome [--identity <opaque-id>]
newton-browser identity login <opaque-id> --origin https://example.com
```

- `setup` creates one persistent Newton identity or explicitly selects an existing
  created/imported identity, writes only the exact
  direct-runtime/browser/opaque-identity fields to the existing bounded local config, and
  prints a content-free MCP configuration summary. Re-running is idempotent unless the
  requested browser conflicts with the selected identity.
- `identity login` is the Plan-12 contained operator workflow; it does not accept arbitrary
  Chromium arguments, unrestricted browsing, credentials, source profiles, or page-derived
  configuration.
- MCP operation uses direct stdio. Explicit Unix-socket continuity uses the same direct host
  and the configured orphan-expiry policy.
- `doctor --live` may launch one disposable identity only when the operator explicitly
  requests the live check. Ordinary `--doctor` remains configuration-only and must distinguish
  `configured`, `runtime_verified`, and `cleanup_confirmed` without claiming an unlaunched
  browser is ready.
- Windows Chrome/Edge and Linux Chrome remain mandatory release platforms. Unsupported
  features remain explicit; there is no extension fallback.

## Measured gates

- Public catalog plus server instructions <= 3,000 `o200k_base` tokens.
- Representative compact workflow <= 2,100 tokens and catalog remains below current
  Newton’s measured 2,818 unless a documented capability requires the difference.
- Compare success, commands, retries, observation bytes/tokens, wall time, and cleanup for
  representative Newton and agent-browser tasks. Optimize successful task cost, not merely
  number of tool definitions.
- `--doctor` reports browser availability and identity/config health without launching effects;
  the explicit live doctor reports proxy/CDP/process capability and cleanup as bounded facts.
  Neither exposes paths, secrets, IDs, origins, targets, sessions, or raw browser output.

## Exit gates

A fresh agent can start, observe, act, and finalize without extension instructions or
browser refresh. Existing Newton task corpus and new identity/runtime tasks pass within
budgets. Documentation has one primary path and no obsolete setup mixed into it.
