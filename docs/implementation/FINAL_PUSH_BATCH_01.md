# Final push batch 01 — feedback and bounded reading

Implementation candidate, 2026-09-08. Not yet validated. Production owner: Astra.

Changed production files:
- `packages/core/src/command-contract.ts`
- `packages/driver/src/page-directory.ts`
- `packages/driver/src/page-executor.ts`
- `packages/driver/src/document-reader.ts`
- `packages/driver/src/ax-snapshot.ts`

Changes under review:
1. Current-generation lifecycle metadata survives missing AX metadata; stale-target errors are no longer swallowed during observations.
2. Empty root control evidence checks native readyState and refreshes once after a known DOMContentLoaded transition, within the existing deadline. No wait on pages already returning controls.
3. Incomplete output distinguishes missing evidence from rendered/work/output omissions, including local validation and candidate caps.
4. Expanded fields return bounded AX controls/owns-linked options (up to four roots, eight expansion calls/256 nodes each, 33 output controls total) within the same receipt/ref publication.
5. Text waits use match-only streaming projection rather than an 8192-character returned prefix. Character/node budgets are shared across frames, hidden frame families are excluded, exhaustion is search_incomplete and heading formatting is not searchable page text.
6. Native select acquisition rejects oversized option sets/strings explicitly, before focus/input, and returns only option indices for keyboard traversal.

QA owner: existing Luna task only. Findings: `test/evidence/final-push-batch-01-findings.md`. No messages to parent. Testing files: `test/engine-regressions/final-push-batch-01.test.mjs`, `test/engine-regressions/precise-edit-native-probe.test.mjs`. No production edits. Generated build outputs and owned run evidence are allowed. Do not change existing expected results merely to pass.

Required independent oracles:
- Text after 8192 characters; across adjacent nodes; beyond total work cap; hidden iframe and nested iframe; outside-main dialog; Unicode; no match from generated heading markers; loading frame and cancellation.
- Local combobox options from native AX relationships, ordinary fill no whole-page read, duplicate refs avoided, exact final byte budget, old public refs remain valid.
- Navigation loading/ready/AX failure independently, correct metadata generations, same-URL reload, known input not replayed, MDN search to destination (public tools). Record remaining empty feedback with raw bounded error cause.
- Oversized select yields no focus/input; normal trusted select still works.
- Build/typecheck and full source suite once after focused new tests. Save original failures; distinguish real regression from an obsolete mock shape.
- Native precise-edit feasibility probe in fixture only: test Input.imeSetComposition replacementStart/replacementEnd and Input.insertText commit on input/textarea/contenteditable, replacement/deletion/Unicode, cancellation semantics, native events and surrounding text. This probe must not introduce production support or page mutation shortcuts. Protocol reference: https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-imeSetComposition .

All temporary resources must have exact ownership cleanup. Do not run pack/release or extension registration for this batch. No sleeps/timeouts to make tests pass. Report command, root cause, oracle, files and unproven cases in the findings file; write a final complete status only after results are saved. Do not send a task message.
