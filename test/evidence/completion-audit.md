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
| exit | Full tests/build with extraction source literally unavailable or renamed | partial | packed/isolated-profile non-checkout proofs pass; literal rename is unauthorized before severance and Docker/Sandbox alternatives are unavailable |
| exit | Extension loads from standalone artifact | proved Chrome + Edge | the same checksum-verified unpacked standalone artifact was reloaded through Computer Use and fully driven in both stable browsers |
| exit | Source remains intact for rollback | proved | no post-provenance writes or deletions were made in the source repository |

## B2 — Auto-started MCP package

| item | requirement | status | authoritative evidence |
| --- | --- | --- | --- |
| 1-2 | Client-neutral executable and deterministic stdio-only stdout | proved | `browser-bridge-mcp`; stdio process/packed tests |
| 3 | `--doctor`, `--print-config`, and `--version` | proved | CLI tests; doctor reports Node/config/loopback/incumbents/protocol/extension/next action; four client config shapes |
| 4-5 | Status tool, protocol negotiation, and MCP `isError` semantics | proved | four protocol revisions; host and packed tests |
| 6 | Start waits for extension/tab readiness with typed timeout and calibrated budget | proved Chrome | typed failures plus 10/10 exact-tarball trials; max/P95 nearest-rank 22.082s under the 40-second budget |
| 7-8 | Screenshot delivery and floor decision metadata end to end | proved | packed MCP image block >128 KiB, file delivery, bounded inline, commit-shaped decision test |
| 9-10 | Inspect tarball and install/run without workspace links | proved | exact four-file tarball; spaced and isolated clean-user installs |
| 11 | Initialize/tools/calls/shutdown/setup/reconnect/framing matrix | proved | `scripts/smoke/packed-stdio.mjs`; `pnpm pack:check` |

## B3 — Multi-host and transport hardening

| item | requirement | status | authoritative evidence |
| --- | --- | --- | --- |
| 1 | Two concurrent logical workers in one MCP process with isolated routing/state | proved | packed harness creates two simultaneous sessions with distinct tabs/groups/refs/screenshots and scoped stop (`426d1cf`) |
| 2 | Determine subagent MCP process/surface sharing | proved/informational | QA-B3-005: Codex child inherited `browser.status` |
| 3 | Two independent host processes; typed collision without crash | proved | concurrent packed host smoke; degraded stdio `host_collision` regression (`a304a26`) |
| 4-5 | Audited WebSocket library and fragmentation/large/ping/close/malformed/disconnect tests | proved | `ws` dependency and focused host/chaos tests |
| 6-8 | All queue/pending/result/inline/orphan bounds, direct session ownership, typed failures | proved | host source plus tests for queue/session/result/timeout/stop/collision/disconnect/protocol outcomes; atomic cross-browser owner, standby denial, targeted selection, and failover are deterministic and real-browser proved |
| 9 | Pairing authentication, extension-origin hardening, no wildcard health CORS | proved | HMAC challenge tests, origin rejection, health and authenticated doctor endpoint tests |
| 10 | Mandatory origin and focus-escape regression | proved | start/readiness and controller focus-escape tests |

## B4 — Lifecycle and files

| item | requirement | status | authoritative evidence |
| --- | --- | --- | --- |
| 1-2 | Close/deliverable/handoff and host-exit semantics | proved | controller, tab-port, extension dead-host, and aggregate-live-set regressions |
| 3 | Exact-path `set_files` contract | proved | validation, driver, hidden-ref, cancellation, and packed tests |
| 4-6 | Image/video fixtures, sanitized browser acceptance, no auto-submit | proved Chrome + Edge | deterministic validation plus repeated real PNG/JPEG/WebP/GIF/MP4/WebM FileList acceptance; no path leakage or submit |
| 7 | Explicit unsupported JavaScript-dialog result | proved | `unsupported_dialog_control` MCP regression |
| 8 | Tool schema and canonical skill | proved | MCP schemas and `skills/browser-bridge/SKILL.md` |

## B5 — Cross-client and cross-machine distribution

| item | requirement | status | authoritative evidence |
| --- | --- | --- | --- |
| 1 | Version-pinned Codex, Claude Desktop, Claude Code, and generic configs | proved | `examples/mcp/`; CLI generation; official Codex TOML shape verified |
| 2 | Packed tarball only, including path with spaces | proved | pack and multi-client harnesses |
| 3 | Unpacked extension artifact, deterministic ZIP, checksum | proved | artifact builder; stable SHA-256 in ledger QA-B5-001 |
| 4 | Chrome stable and Edge stable with same extension source | proved | Chrome 150 and Edge 150 use the same unpacked artifact; Edge-targeted and default-auto simultaneous-browser suites each passed 25/25 steps with both extensions enabled |
| 5 | Clean Windows user/machine procedure | partial | isolated HOME/USERPROFILE/LOCALAPPDATA/npm-cache proof passes; actual second account requires elevation or another machine |
| 6 | Concurrent actual Codex and Claude low-risk browser work | proved Chrome | both installed clients simultaneously completed separate exact-tarball owned sessions and finalized cleanly |
| 7 | No source checkout/global install/daemon/service/panel click during normal startup | proved | isolated non-checkout and real-client proofs; zero-touch startup requires no pairing or popup action |
| 8 | Browser/client/version matrix and exact results | proved/current | QA ledger; real rows explicitly remain pending |

## B6 — Release proof gate

All required command names exist. `pnpm release:check` covers boundary, types, 79 source tests, build, deterministic artifacts, packed install, fixture checks, Node matrix, three chaos repetitions, two host processes, isolated user directories, and orphan-port audit. Arbitration commit `2faf97a` passed three consecutive final runs (77.8s, 77.3s, and 77.5s); every run completed all 11 stages with zero skips, failures, or orphan ports.

| evidence class | status | authoritative evidence / remaining proof |
| --- | --- | --- |
| Basic controls, SPA/stale refs, shadow/frame, cross-origin fixture, contenteditable/combobox, lazy page | proved Chrome | three consecutive full live batches after focus-emulation fix |
| Screenshot >64 KiB through caller contract | proved packed | packed MCP image content block >128 KiB |
| Dialog/download/new-target/network-write signals | proved deterministic | debugger-signal and reconciliation tests; dialog control explicitly unsupported |
| Sensitive fields with zero keystrokes | proved deterministic | MCP pre-dispatch block returns before extension dispatch |
| Origin transitions and observe grant regression | proved owned + current | owned sessions stayed bound while operator focus changed; Computer Use physically focused the Edge fixture, bound current-tab, moved focus to Chrome, and observation remained on the original Edge origin |
| Decision metadata across commit-shaped fixture | proved packed | packed commit-shaped action result |
| Approved image/video file inputs | proved Chrome + Edge | validation + packed tests + repeated real browser acceptance in both stable browsers |
| Two logical workers and two host processes | proved packed | single-host dual-session and two-process harnesses |
| Restart/reconnect and readiness budget | proved Chrome | packed reconnect plus 10/10 cold-start distribution, max 22.082s |
| Finalize/cleanup with no orphan processes/tabs | proved Chrome | repeated empty session/tab/port audits after live and client batches |
| Existing authenticated profile retained | proved Chrome + Edge | live QA used the operator's existing profiles without inspecting cookies/storage/profile files |
| Owned tab does not steal active tab | proved Chrome | operator focused other tabs during sessions; observations and actions remained on owned fixture |
| Explicit current-tab scope | proved Edge | deterministic controller regression plus real OS focus/bind/focus-escape proof through Computer Use |
| Concurrent Codex and Claude tasks | proved Chrome | actual packed clients passed concurrently |
| Chrome and Edge stable | proved | full Edge-targeted and default-auto simultaneous suites passed while both extensions remained enabled; exactly one browser owned each session |

Optional live advertising workflow proof is `not-approved` and is not a release requirement. No live client/account action has been attempted.

## Current release conclusion

B0 contracts and repository implementation through B6 are implemented, and the final three-run release gate is green on the simultaneous-browser arbitration commit. Chrome, Edge, current-tab focus escape, actual-client, packed, cold-start, and cleanup evidence are proved. Two environmental acceptance rows remain unproven: a full workspace run with the extraction source literally unavailable, and an actual second Windows account/machine. They require stronger external evidence or explicit operator disposition before the B0-B6 audit can be called fully closed and before severance work begins.
