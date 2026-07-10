# Proposal 45 B0-B6 Completion Audit

Audit date: 2026-07-10. Status values are `proved`, `partial`, `pending-real`, or `not-approved`. A green narrow test is not used to claim a broader real-browser requirement.

## B0 — Bootstrap and contract lock

| item | requirement | status | authoritative evidence |
| --- | --- | --- | --- |
| precondition | Commit the seven provenance assets before extraction and record the hash | proved | provenance `56e65944b3b6e4233a634fa3e7781ee449eb51cb`; ledger QA-B0-001 |
| 1-2 | Initialize local `main` repository after approval and record provenance without runtime coupling | proved | `8d7b43f`; root README |
| 3 | Lock package/export/tool/status/Node/artifact names | proved | `docs/DECISIONS.md` §§7-9; package manifests; boundary check |
| 4 | Private/local license posture; no publish | proved | private root package, no license file, no remote/publish action |
| 5 | Forbidden dependency/string and stale-concept boundary | proved | `scripts/verify-boundary.mjs`; repeated `pnpm boundary:check` |
| 6-10 | Lock multi-host, transport auth, screenshot delivery, decision metadata/host policies, and mandatory origin | proved | `docs/DECISIONS.md` §§1-6 plus contract tests; explicit 2026-07-10 revision makes zero-touch local trust default and paired HMAC opt-in |
| 11 | Lock `set_files`, `browser.status`, and finalization | proved | `docs/DECISIONS.md` §§7-8 plus tool schemas |

## B1 — Rehome proven runtime

| item | requirement | status | authoritative evidence |
| --- | --- | --- | --- |
| 1-4 | Package imports/build paths, focused tests, build/smoke scripts, and security content | proved | `94de2f0`; package manifests; `docs/SECURITY.md` |
| 5-7 | Detailed standalone skill, root commands, compiled JavaScript package bin | proved | `skills/browser-bridge/`; root scripts; packed four-file tar listing |
| 8 | Set Node engines from active-LTS evidence | proved | Node 24.18.0 and 25.9.0 matrix; `engines.node >=24.0.0` |
| 9 | Forbidden boundary with inverted standalone assertions | proved | repository-wide boundary scanner and clean release checks |
| 10 | Real `DOM.setFileInputFiles` feasibility probe | proved | repeated real Chrome acceptance of PNG/JPEG/WebP/GIF/MP4/WebM; sanitized filenames; no auto-submit |
| exit | Full tests/build with extraction source literally unavailable or renamed | not-approved | packed/isolated-profile non-checkout proofs pass; on 2026-07-10 the user explicitly declined renaming the extraction source repository because it contains other important information; this check was not run and is not claimed proved |
| exit | Extension loads from standalone artifact | proved Chrome + Edge | the same checksum-verified unpacked standalone artifact was reloaded through Computer Use and fully driven in both stable browsers |
| exit | Source remains intact for rollback | proved | no post-provenance writes or deletions were made in the source repository |

## B2 — Auto-started MCP package

| item | requirement | status | authoritative evidence |
| --- | --- | --- | --- |
| 1-2 | Client-neutral executable and deterministic stdio-only stdout | proved | `browser-bridge-mcp`; stdio process/packed tests |
| 3 | `--doctor`, `--print-config`, and `--version` | proved | CLI tests; doctor reports Node/config/loopback/incumbents/protocol/extension/next action; four client config shapes |
| 4-5 | Status tool, protocol negotiation, and MCP `isError` semantics | proved | four protocol revisions; host and packed tests |
| 6 | Start waits for extension/tab readiness with typed timeout and calibrated budget | proved Chrome + Edge | typed failures plus 10/10 fresh exact-tarball trials; max/P95 2.009s under the 40-second budget |
| 7-8 | Screenshot delivery and floor decision metadata end to end | proved | packed MCP image block >128 KiB, file delivery, bounded inline, commit-shaped decision test |
| 9-10 | Inspect tarball and install/run without workspace links | proved | exact four-file tarball; spaced and isolated clean-user installs |
| 11 | Initialize/tools/calls/shutdown/setup/reconnect/framing matrix | proved | `scripts/smoke/packed-stdio.mjs`; `pnpm pack:check` |

## B3 — Multi-host and transport hardening

| item | requirement | status | authoritative evidence |
| --- | --- | --- | --- |
| 1 | Two concurrent logical workers in one MCP process with isolated routing/state | proved | packed harness creates two simultaneous sessions with distinct tabs/groups/refs/screenshots and scoped stop (`426d1cf`) |
| 2 | Determine subagent MCP process/surface sharing | proved live | QA-B3-006: collaboration subagent inherited all Browser Bridge tools, completed an isolated search/screenshot session, and finalized cleanly |
| 3 | Two independent host processes; typed collision without crash | proved | concurrent packed host smoke; degraded stdio `host_collision` regression (`a304a26`) |
| 4-5 | Audited WebSocket library and fragmentation/large/ping/close/malformed/disconnect tests | proved | `ws` dependency and focused host/chaos tests |
| 6-8 | All queue/pending/result/inline/orphan bounds, direct session ownership, typed failures | proved | host source plus tests for queue/session/result/timeout/stop/collision/disconnect/protocol outcomes; atomic cross-browser owner, standby denial, targeted selection, and failover are deterministic and real-browser proved |
| 9 | Pairing authentication, extension-origin hardening, no wildcard health CORS | proved | HMAC challenge tests, origin rejection, health and authenticated doctor endpoint tests |
| 10 | Mandatory origin and focus-escape regression | proved | start/readiness and controller focus-escape tests |

## B4 — Lifecycle and files

| item | requirement | status | authoritative evidence |
| --- | --- | --- | --- |
| 1-2 | Close/deliverable/handoff and host-exit semantics | proved live | controller/tab-port regressions plus real worker reload, debugger cancel, driven-tab close, and killed-host orphan cleanup |
| 3 | Exact-path `set_files` contract | proved | validation, driver, hidden-ref, cancellation, and packed tests |
| 4-6 | Image/video fixtures, sanitized browser acceptance, no auto-submit | proved Chrome + Edge | deterministic validation plus repeated real PNG/JPEG/WebP/GIF/MP4/WebM FileList acceptance; no path leakage or submit |
| 7 | Explicit unsupported JavaScript-dialog result | proved | `unsupported_dialog_control` MCP regression |
| 8 | Tool schema and canonical skill | proved | MCP schemas and `skills/browser-bridge/SKILL.md` |

## B5 — Cross-client and cross-machine distribution

| item | requirement | status | authoritative evidence |
| --- | --- | --- | --- |
| 1 | Version-pinned Codex, Claude Desktop, Claude Code, and generic configs | proved | `examples/mcp/`; CLI generation; official Codex TOML shape verified |
| 2 | Packed tarball only, including path with spaces | proved | pack and multi-client harnesses |
| 3 | Unpacked extension artifact, deterministic ZIP, checksum | proved | artifact builder; final SHA-256 `5d8873e8d13bbf6471ca6e7e0d59e70c6cf84f4c0df39167fe4ad4d89dcdf995` |
| 4 | Chrome stable and Edge stable with same extension source | proved | Chrome 150 and Edge 150 use the same unpacked artifact; both targeted suites passed 33/33 steps with both extensions enabled |
| 5 | Clean Windows user/machine procedure | not-approved | isolated HOME/USERPROFILE/LOCALAPPDATA/npm-cache proof passes; on 2026-07-10 the user explicitly declined creating another Windows account; this check was not run and is not claimed proved |
| 6 | Concurrent actual Codex and Claude low-risk browser work | proved Chrome + Edge Codex repeat | visible packed-client transcripts include search/extract/full-page screenshot/finalize; Edge repeated Codex acceptance |
| 7 | No source checkout/global install/daemon/service/panel click during normal startup | proved | isolated non-checkout and real-client proofs; zero-touch startup requires no pairing or popup action |
| 8 | Browser/client/version matrix and exact results | proved/current | QA ledger; real rows explicitly remain pending |

## B6 — Release proof gate

All required command names exist. The unshortened `pnpm release:check` passed three consecutive times on implementation `305bd51` and evidence tree `8ace479`: 378.2s, 379.2s, and 378.2s. Every run completed all 11 stages and 84/84 tests; each five-minute interleave exceeded 2.94 million operations with zero cross-session results/deadlocks, bounded RSS growth, and zero orphan ports.

| evidence class | status | authoritative evidence / remaining proof |
| --- | --- | --- |
| Basic controls, SPA stale/moved refs, nested shadow/frame, custom combobox/listbox, long page | proved Chrome + Edge | final targeted live suites passed 33/33 in each browser with both extensions open |
| Screenshot >64 KiB through caller contract | proved live + packed | live byte-decoded PNGs were 438,862 and 437,258 bytes; packed MCP image block >128 KiB |
| Dialog/download/new-target/network-write signals | proved deterministic | debugger-signal and reconciliation tests; dialog control explicitly unsupported |
| Sensitive fields with zero keystrokes | proved live | Password, OTP, card, SSN, and IBAN blocked; page `keydown`/`keypress`/`input` sentinel remained `none` |
| Origin transitions and observe grant regression | proved owned + current | owned sessions stayed bound while user focus changed; Computer Use physically focused the Edge fixture, bound current-tab, moved focus to Chrome, and observation remained on the original Edge origin |
| Decision metadata across commit-shaped fixture | proved live | Publish/place order/delete returned `commit`; like/subscribe returned `external_effect` |
| Approved image/video file inputs | proved Chrome + Edge | validation + packed tests + repeated real browser acceptance in both stable browsers |
| Two logical workers and two host processes | proved packed | single-host dual-session and two-process harnesses |
| Restart/reconnect and readiness budget | proved Edge + packed | exact-tab worker reload recovery plus 10/10 cold starts, max 2.009s |
| Finalize/cleanup with no orphan processes/tabs | proved Chrome + Edge | user cancel/tab close/host kill, live/client batches, and final orphan-port audit all clean |
| Existing authenticated profile retained | proved Chrome + Edge | cookie/localStorage/sessionStorage sentinels survived navigation, reload, actions, and screenshots |
| Owned tab does not steal active tab | proved Chrome + Edge | three simultaneous owned sessions remained isolated while OS focus changed between browsers |
| Explicit current-tab scope | proved Edge | deterministic controller regression plus real OS focus/bind/focus-escape proof through Computer Use |
| Concurrent Codex and Claude tasks | proved Chrome + Edge repeat | actual packed clients passed concurrently in Chrome with visible tool transcripts; Codex repeated in Edge |
| Chrome and Edge stable | proved | final 33/33 suites passed while both extensions remained enabled; exactly one browser owned each session |

Optional live advertising workflow proof is `not-approved` and is not a release requirement. No live client/account action has been attempted.

## Current release conclusion

B0 contracts and repository implementation through B6 are implemented, and three consecutive exhaustive release gates are green on `305bd51`. Chrome, Edge, current-tab focus escape, three-session isolation, subagent inheritance, actual clients, packed distribution, cold start, lifecycle chaos, and cleanup are proved. Two environmental acceptance rows remain unproven: a full workspace run with the extraction source literally unavailable, and an actual second Windows account/machine. On 2026-07-10 the user explicitly declined both environment mutations and authorized the remaining local release work to proceed. They are excluded from execution by user disposition, not claimed complete, and do not authorize any extraction-source severance work.
