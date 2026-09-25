# Final push batch 02 — released to QA

Scope: immutable platform-neutral native artifacts and Windows/Linux Chrome/Edge setup, owned Linux registration, explicit source refresh/collection semantics, startup observation generation refresh, and pure precise-edit range helper.

Astra reviewed/integrated Spark03, including keeping POSIX ownership checks Linux-only. Production paths in this batch are frozen for the explicit Luna assignment. Source fixes remain candidates until QA and independent review succeed.

Required QA write paths for the later dispatch:
- `test/engine-regressions/final-push-batch-02.test.mjs`
- `test/engine-regressions/precise-edit-native-probe.test.mjs` (complete missing feasibility cases)
- `test/engine-regressions/final-push-batch-01.test.mjs` (replace inadequate MDN oracle)
- `packages/driver/test/build-parity.test.js` (exact added output list only; no weakening)
- `test/evidence/final-push-batch-02-findings.md`
- owned run evidence under `test/evidence/runs/final-push-batch-02/`

No production fixes by QA. No messages to parent; final results in findings file only. Each assertion must justify the stated claim. Unsupported/missing platform/account/browser is a gap, never a passing skip.

Oracles:
1. Startup failures recorded in batch01: use an explicit lifecycle/AX scheduling barrier to reproduce generation change during initial observation; verify same navigation sent once, refreshed refs target correct document, unchanged-generation stale error remains error. Retain simple real fixtures in control-context/pointer-actions as independent integration checks.
2. Public MDN flow THROUGH handleMcpMessage (and later packed stdio acceptance): start home, use returned search ref, fill, get linked options, click returned fetch result, inspect THAT action receipt for correct destination and useful next state. No direct navigation to search endpoint or extra observe used to mask missing feedback. Record actual calls and full bounded failure receipt; do not relabel a title/URL-only check as actionable navigation feedback.
3. Native edit feasibility explicitly tests replacement, empty replacement/deletion, emoji before/in match, textarea line endings, contenteditable repeated text, composition cancellation after composition began, focus movement and compositioncommit effects. Record which commands changed text and trusted events. Cancellation before any composition is not proof of in-progress cancellation. Fixture DOM setup/oracles may be application-owned; production input must be native.
4. Range helper: unique/ambiguous/overlapping matches, context adjacency, occurrence constraints, Unicode boundaries, malformed/oversized input, unchanged prefix/suffix, exact expected result, no candidate retention.
5. Platform helpers and immutable artifacts: existing Windows metadata compatibility; partial/corrupt build refusal; different runtime names; Node SEA minimum; Linux permissions and actual executable launch; concurrent builds winner validation; failed child and owned stage cleanup; no overwrite of live immutable files.
6. Registrations: Windows Chrome/Edge key independence, Linux exact user-local file, current-user root restrictions, symlinks/hardlinks/foreign manifest refusal, failure during publication, owned unregister preserving unrelated registration. Run destructive cases only in explicitly owned disposable roots/registration names.
7. Source CLI: refresh enters normal maintenance/publication rather than garbage collection; collect only retires old generations; EOF/browser close/signal cancel instead of publishing; Enter publishes exact closed maintenance generation; listeners cleaned up; active worker clones untouched.
8. Build/typecheck/full source suite sequentially once after focused tests, no production changes while the candidate is being tested. Preserve original failures and identify concrete reproduction/root cause. Run packed/native scenario only when dispatch explicitly supplies the approved candidate hash/command; do not independently overwrite package artifacts.

Metrics: actual command, browser version/platform/mode, pass/fail/gap, independent application effect, final encoded bytes/tool calls where relevant, exact cleanup. Do not describe direct PageExecutor tests as MCP boundary coverage or locally tokenized tool text as full model tokens.
