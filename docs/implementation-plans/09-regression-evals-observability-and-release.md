# Plan 09 — Regression Evals, Observability, and Release Gates

- **Status:** Approved; deterministic corpus, metrics, and release wiring complete, live/final release evidence pending
- **Depends on:** Added incrementally with every plan; final release gate follows Plan 08
- **Primary outcome:** Newton measures successful agent workflows, detects regressions copied from real browser-automation failure classes, diagnoses its own state, and releases only from reproducible packed artifacts.

## Why this is a must-do

Battle-tested software is defined less by feature count than by the failures it remembers. agent-browser’s mature value is its accumulated regression surface: frames, dialogs, downloads, target churn, keyboard fidelity, output control, and packaging. Newton should borrow those failure classes as tests and observability requirements, not copy every command or architectural choice.

## Files

### Add

- `test/evals/tasks/*.json` — provider-independent tasks, expected semantic steps, and forbidden effects.
- `scripts/evals/replay.mjs` — deterministic replay against fixtures/live Chromium.
- `scripts/evals/token-budget.mjs` — catalog and workflow budget assertions shared with Plan 06.
- `scripts/evals/report.mjs` — machine-readable and Markdown summary without telemetry.
- `test/evals/replay.test.mjs`.
- `scripts/smoke/command-concurrency-live.mjs`.
- `scripts/smoke/frame-target-churn-live.mjs`.
- `scripts/smoke/dialog-renderer-live.mjs`.
- `scripts/smoke/origin-containment-live.mjs` if not already introduced in Plan 04.
- `test/evidence/audit-improvement-program.md` — requirement-to-evidence matrix.
- `test/evidence/upstream-provenance.md` — pinned source/commit/license record for any direct port; behavior-only references are marked as independently reimplemented.

### Edit

- Root `package.json` — add `eval`, `eval:live`, and budget scripts.
- `scripts/release-check.mjs` — run deterministic evals, packed-artifact tests, and critical live gates.
- `.github/workflows/ci.yml` and release workflow files — add the platform/browser matrix without publishing side effects.
- `apps/mcp-server/src/cli.ts` — expand `doctor` with bounded local diagnostics.
- Existing fixture/live smoke runners and package tests.
- `README.md`, `docs/RELEASE.md`, `docs/TROUBLESHOOTING.md`, and `docs/DECISIONS.md`.
- `docs/PROGRESS_LEDGER.md`, `test/evidence/qa-ledger.md`, `test/evidence/bugs.md`, and `test/evidence/completion-audit.md` as results land.

### Delete

- Redundant smoke scripts only after their assertions are represented in a named eval/gate.
- No historical evidence is deleted; superseded entries are linked to their replacement.

## Eval model

Evals exercise Newton, not a model provider. A task fixture declares setup, commands or semantic choices, expected observations/outcomes, and forbidden requests:

```json
{
  "id": "checkout-fill-with-dialog",
  "fixture": "input-reliability/checkout.html",
  "grant": ["http://127.0.0.1:4310"],
  "steps": [
    { "tool": "browser.session.start", "expect": "completed" },
    { "tool": "browser.observe", "expectRef": { "role": "textbox", "name": "Email" } },
    { "tool": "browser.act", "action": "type", "expect": "completed" },
    { "tool": "browser.act", "action": "click", "expect": "dialog_blocked" }
  ],
  "forbid": [
    { "origin": "http://127.0.0.1:4311", "method": "POST" }
  ]
}
```

The replay engine may resolve refs by expected semantics but must not use an LLM, external network, telemetry, or user profile.

Every runner creates isolated temporary home, config, cache, profile, download, and
output roots. A post-run assertion proves the real user profile was not changed. The
runner removes only its validated temporary roots.

## Regression watchlist

Maintain a versioned matrix derived from Newton defects and externally observed failure classes:

- concurrent commands, timeout-before-start, reconnect replay, and duplicate delivery;
- startup/finalization rollback and framing limits;
- OOPIFs, nested frames, popups, workers, target replacement, and stale refs;
- redirect, form, beacon, socket, current-tab, and allowed-origin containment;
- keyboard/chord fidelity, pointer cleanup, dialogs, discarded tabs, debugger conflicts, and unresponsive renderers;
- output escaping, redaction, opaque bodies, truncation, query filters, and token budgets;
- installation, global executable resolution, packed resources, browser selection, and clean-machine startup.
- hermetic home/config/profile handling and zero writes to the real user profile.

Each borrowed class must link to Newton’s own deterministic reproduction and acceptance rule. Do not import another project’s tests or code without checking license/provenance and product fit.

Default to specification-first reimplementation. If source or tests are copied or closely
ported, record the exact upstream commit/file, Apache-2.0 obligations, modifications, and
required notices before integration; obtain legal review before public distribution when
the port is substantial.

## Metrics

Collected locally during test execution only:

- tokens to verified completion;
- MCP calls and repair calls per task;
- command queue wait and execution latency percentiles;
- queue fairness and maximum depth;
- driver/MCP resident-memory deltas over long observer sessions;
- outcome counts (`completed`, `prevented`, `not_started`, `outcome_unknown`);
- target attach/detach and recovery counts.

Reports contain fixture/test identifiers, never browsing content from real user profiles.

## Doctor diagnostics

`newton-browser doctor` full mode adds bounded, local state:

```text
session epoch: 7
command queue: depth=0 running=none oldest_ms=0
renderer: healthy
targets: 3 attached, 0 paused, 0 unreconciled
containment: installed on 3/3 targets
frame limits: header=16384 body=4194304 buffered=0
```

Compact/default doctor remains human-readable. Full output contains no cookies, storage, profile files, credentials, page text, or response bodies.

## Release gates

### Pull requests

- Unit, integration, packed MCP/extension, deterministic eval, catalog/workflow budgets, and `git diff --check`.
- Real-browser critical matrix: Windows Chrome and Edge; Linux Chrome where infrastructure supports it.
- No skipped test marked `critical`.

### Release candidates

- Build and test the exact packed artifacts, not source-tree shortcuts.
- Run `pnpm release:check` three consecutive times with no skipped critical tests.
- Record hashes, browser versions, OS, result counts, and evidence paths.
- Publishing, public remotes, store submission, licenses, or registry mutation still require separate explicit approval.

Budget gates start report-only for one baseline cycle. Once values are stable and recorded, the same thresholds become failing gates; they cannot remain advisory indefinitely.

## Implementation slices

1. Define task/evidence schemas and convert existing fixtures into initial evals.
2. Add missing concurrency, frame, containment, input, and privacy regressions alongside Plans 01–07.
3. Add local metrics and doctor diagnostics.
4. Add deterministic token/catalog budgets.
5. Wire PR matrix and packed-artifact checks.
6. Execute and record three clean release-candidate passes after Plan 08.

## Exit criteria

- Every recommendation in the comparative audit maps to a plan, deterministic test/eval, and evidence entry.
- All critical failure classes have a named owner and regression.
- Token efficiency is measured as successful task cost, not output size alone.
- Doctor can distinguish queue, renderer, target, containment, and framing failures without inspecting private browser data.
- The exact packed artifacts pass the complete release gate three consecutive times.

## Rollback

Individual flaky live gates may be quarantined only with a deterministic repro, root-cause issue, owner, and expiry. Do not delete or silently skip a critical gate to ship. CI infrastructure changes may roll back while local release gates remain mandatory.
