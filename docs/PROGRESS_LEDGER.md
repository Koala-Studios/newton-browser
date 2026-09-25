# Newton Browser progress ledger

Updated 2026-09-25. This is the authoritative current status; dated audit and worker reports are historical evidence, not competing completion claims. The consolidation is a development checkpoint, not a release.

## Source and delivery boundary

The replacement lives in the `421a` worktree, based on `f2ae1ee` (package version remains 0.6.4). The older `C:\DEV\newton-browser` checkout contains an earlier dirty copy and must not overwrite this implementation. The approved architecture is [SESSION_ENGINE_DESIGN.md](SESSION_ENGINE_DESIGN.md); the detailed remaining checklist is [final push.md](../final%20push.md). All implementation and QA are solo. Earlier worker handoff instructions are superseded.

The default MCP path now constructs `EngineHost` and uses `SessionEngine`/`PageExecutor`. Claims that it is still fill-only, accepts only an origin, or has not cut over are obsolete. The old direct host, parser and several CLI/test consumers still survive: default cutover is implemented; legacy retirement is not.

## Implemented and exercised

| Area | Current behavior and evidence boundary |
| --- | --- |
| Shared execution | Per-session serialized actions/reads, bounded sequences, monotonic command IDs, duplicate joining, retained receipts, cancellation and independent session stop. Dispatch, postcondition and optional feedback are distinct. Resource/startup shutdown stress remains open. |
| Owned browsers | Complete HTTP(S) start URL, blank-first private CDP, guardian ownership, isolated headless Chrome/Edge processes and writable identities. Normal Chromium networking remains unrestricted by Newton. |
| Targeting and actions | Frame/document-stamped refs, semantic/selector resolution, shadow-aware focus/hits, native fill/type/clear, click variants/hover, keys, scroll, navigation/history, waits, dialogs, popups and explicit page selection. Native select supports a single native selection; custom/multiple selection is not silently emulated. |
| Precise editing | Strict exact-match `edit`, optional prefix/suffix/occurrence, grapheme-aware bounded native selection, verified offsets, native insertion/deletion and unchanged surrounding text checks. Cancellation after selection leaves text untouched. Tested on actual Chrome inputs, multiline/Unicode and simple inline contenteditable; persisted real rich-editor and adapter/platform parity remain unproven. |
| Feedback and reading | Action-local field/validation feedback, native related combobox options, destination metadata, one generation-aware read refresh, stable public refs, contextual controls, typed links/tables/forms, record deltas and immutable document continuation. Bounded text wait checks outside main/article too. Closed-shadow document coverage and consistently useful compact next-state feedback remain incomplete. |
| Visual/files | Screenshot budgets, trusted native sensitive-region masking, coordinate provenance, owned viewport resize, bounded image/video file upload, full-page and hidden borrowed-tab capture work. Full adversarial visual/cleanup/platform matrix remains open. |
| Shared login | Closed Newton-owned immutable source generation, opaque narrow copies into separate identities, maintenance/publication/recovery, refresh and explicit collection CLI. Worker changes never merge back. Real provider login/revocation and CLI interruption acceptance remain open. |
| Existing browser | Optional thin tab adapter and native messaging use the same engine. Explicit operator selection, per-worker owned tabs, concurrent separate tabs, disconnect/claim cleanup and staged update/rollback have source and historical packed Chrome evidence. Standalone does not depend on the extension. |
| Installation | Immutable runtime/launcher artifacts, Windows Chrome/Edge layout and Linux user-local registration code exist. Windows foundation evidence is broader than current Linux evidence. Actual Linux executable/registration/unregister and full Edge existing-mode acceptance are not established. |
| Release preparation | Streaming tracked/untracked candidate digest includes source and rejects unstable/unsafe paths; exact generated directories are excluded. Existing local release script uses it. The grouped test runner and full release harness still need independent completion. |

## Verification register

- Source checkpoint from 2026-09-08: **841 passed, zero failures/skips**, plus typecheck. See [solo evidence](../test/evidence/astra-solo-foundations-2026-09-08.md).
- Fresh consolidation checks and Git scope are recorded in [CONSOLIDATION_2026-09-25.md](implementation/CONSOLIDATION_2026-09-25.md). Historical counts are not substituted for fresh results.
- Latest historical packed candidate is v53: 13 files, 329700 bytes, SHA-256 `038bb2482517f3bfcb6e543d08b217134a40c001eade78a772101164cacc18ad`. It predates subsequent feedback, precise-edit and platform changes. It does not certify this tree.
- Historical v53 public scripted QA: Wikipedia, GitHub issues and W3C, 27 calls and no recorded recovery, 53304 output text tokens plus 4808 catalog tokens. This is not measured model reasoning cost or authenticated acceptance.
- Historical MDN model run: seven public calls. Later source MDN checks improved the search-to-result oracle. Neither is matched ChatGPT parity evidence.
- No completed three-pass unchanged-candidate release sequence exists for this replacement. No npm/store release is authorized by this checkpoint push.

## Remaining work / closure criteria

| Gap | Exact remaining work |
| --- | --- |
| Useful next state / model cost | Finish action-specific dialog/menu/search feedback and compact control projection; distinguish all omission/readiness causes; prove navigation returns actionable refs without routine repair observe; measure model turns, output tokens, waits and recovery. |
| Reading / edit conformance | Closed-shadow rendered document reading, consistent cross-frame exclusions and bounded acquisition; real virtualized tables/lists; selection drift, focus/sensitivity changes, rich normalization/persistence, Edge/Linux/borrowed edit and select coverage. |
| Lifecycle / visual reliability | Bound pending startup/stop paths, test host/renderer/adapter loss and resource churn, complete hidden capture cleanup and independent pixel/mask oracles across modes. |
| Login / platform setup | Actual provider authentication sharing from a closed Newton source, refresh/revocation under concurrency, EOF/signal/browser-close maintenance cancellation; real Linux install/chmod/registration/unregister and Edge parity. |
| Legacy retirement | Migrate doctor, old direct-host consumers, tests and scripts to the shared engine; remove old parser/runtime/exports after behavior coverage is retained. Unimported metadata helper and grouped QA runner are candidates, not completed migration. |
| Packaging / release harness | Finish current-engine groups and critical-skip enforcement, assert packed production contents and update stability, freeze an exact candidate, run actual packed both-mode/platform acceptance and three unchanged release gates. |
| Everyday acceptance | Complete real authenticated forms, persisted editing, visual/embedded interfaces, shared login and matched model tasks. Fixtures and public read-only sites are insufficient. |

Do not mark P00–P14 complete from test counts, code presence, worker claims or old packed receipts. The [defect ledger](../test/evidence/bugs.md) retains detailed fixes and residual findings; [ROADMAP.md](../ROADMAP.md) gives the remaining implementation order.
