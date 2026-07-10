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
| 6-10 | Lock multi-host, pairing, screenshot delivery, decision metadata/host policies, and mandatory origin | proved | `docs/DECISIONS.md` §§1-6 plus contract tests |
| 11 | Lock `set_files`, `browser.status`, and finalization | proved | `docs/DECISIONS.md` §§7-8 plus tool schemas |

## B1 — Rehome proven runtime

| item | requirement | status | authoritative evidence |
| --- | --- | --- | --- |
| 1-4 | Package imports/build paths, focused tests, build/smoke scripts, and security content | proved | `94de2f0`; package manifests; `docs/SECURITY.md` |
| 5-7 | Detailed standalone skill, root commands, compiled JavaScript package bin | proved | `skills/browser-bridge/`; root scripts; packed four-file tar listing |
| 8 | Set Node engines from active-LTS evidence | proved | Node 24.18.0 and 25.9.0 matrix; `engines.node >=24.0.0` |
| 9 | Forbidden boundary with inverted standalone assertions | proved | repository-wide boundary scanner and clean release checks |
| 10 | Real `DOM.setFileInputFiles` feasibility probe | pending-real | deterministic CDP/FileList tests pass; `pnpm smoke:real-browser` awaits manually loaded/paired extension |
| exit | Full tests/build with extraction source literally unavailable or renamed | partial | packed/isolated-profile non-checkout proofs pass; literal rename is unauthorized before severance and Docker/Sandbox alternatives are unavailable |
| exit | Extension loads from standalone artifact | pending-real | deterministic manifest/build/ZIP extraction passes; browser-internal loading requires operator action |
| exit | Source remains intact for rollback | proved | no post-provenance writes or deletions were made in the source repository |

## B2 — Auto-started MCP package

| item | requirement | status | authoritative evidence |
| --- | --- | --- | --- |
| 1-2 | Client-neutral executable and deterministic stdio-only stdout | proved | `browser-bridge-mcp`; stdio process/packed tests |
| 3 | `--doctor`, `--print-config`, and `--version` | proved | CLI tests; doctor reports Node/config/loopback/incumbents/protocol/extension/next action; four client config shapes |
| 4-5 | Status tool, protocol negotiation, and MCP `isError` semantics | proved | four protocol revisions; host and packed tests |
| 6 | Start waits for extension/tab readiness with typed timeout and calibrated budget | partial | typed `extension_disconnected`/`session_setup_timeout`, 40-second budget vs 30-second extension alarm; real cold-start measurement pending |
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
| 6-8 | All queue/pending/result/inline/orphan bounds, direct session ownership, typed failures | proved | host source plus tests for queue/session/result/timeout/stop/collision/disconnect/protocol outcomes |
| 9 | Pairing authentication, extension-origin hardening, no wildcard health CORS | proved | HMAC challenge tests, origin rejection, health and authenticated doctor endpoint tests |
| 10 | Mandatory origin and focus-escape regression | proved | start/readiness and controller focus-escape tests |

## B4 — Lifecycle and files

| item | requirement | status | authoritative evidence |
| --- | --- | --- | --- |
| 1-2 | Close/deliverable/handoff and host-exit semantics | proved | controller, tab-port, extension dead-host, and aggregate-live-set regressions |
| 3 | Exact-path `set_files` contract | proved | validation, driver, hidden-ref, cancellation, and packed tests |
| 4-6 | Image/video fixtures, sanitized browser acceptance, no auto-submit | partial | PNG/JPEG/WebP/GIF/MP4/WebM deterministic validation and simulated FileList pass; real Chrome acceptance awaits pairing |
| 7 | Explicit unsupported JavaScript-dialog result | proved | `unsupported_dialog_control` MCP regression |
| 8 | Tool schema and canonical skill | proved | MCP schemas and `skills/browser-bridge/SKILL.md` |

## B5 — Cross-client and cross-machine distribution

| item | requirement | status | authoritative evidence |
| --- | --- | --- | --- |
| 1 | Version-pinned Codex, Claude Desktop, Claude Code, and generic configs | proved | `examples/mcp/`; CLI generation; official Codex TOML shape verified |
| 2 | Packed tarball only, including path with spaces | proved | pack and multi-client harnesses |
| 3 | Unpacked extension artifact, deterministic ZIP, checksum | proved | artifact builder; stable SHA-256 in ledger QA-B5-001 |
| 4 | Chrome stable and Edge stable with same extension source | pending-real | versions detected; extension loading/interaction not yet operator-completed |
| 5 | Clean Windows user/machine procedure | partial | isolated HOME/USERPROFILE/LOCALAPPDATA/npm-cache proof passes; actual second account requires elevation or another machine |
| 6 | Concurrent actual Codex and Claude low-risk browser work | pending-real | both clients initialize exact tarball; typed `extension_disconnected` until pairing |
| 7 | No source checkout/global install/daemon/service/panel click during normal startup | proved for packed startup | isolated non-checkout harness and client configs; one-time extension loading/pairing remains setup |
| 8 | Browser/client/version matrix and exact results | proved/current | QA ledger; real rows explicitly remain pending |

## B6 — Release proof gate

All required command names exist. `pnpm release:check` covers boundary, types, 68 source tests, build, deterministic artifacts, packed install, fixture checks, Node matrix, three chaos repetitions, two host processes, isolated user directories, and orphan-port audit. Three consecutive green runs were recorded before the latest audit hardening; a fresh three-run gate is required after real-browser closure.

| evidence class | status | authoritative evidence / remaining proof |
| --- | --- | --- |
| Basic controls, SPA/stale refs, shadow/frame, cross-origin fixture, contenteditable/combobox, lazy page | proved deterministic; pending-real | static fixture tests; expanded real-browser harness awaits pairing |
| Screenshot >64 KiB through caller contract | proved packed | packed MCP image content block >128 KiB |
| Dialog/download/new-target/network-write signals | proved deterministic | debugger-signal and reconciliation tests; dialog control explicitly unsupported |
| Sensitive fields with zero keystrokes | proved deterministic | MCP pre-dispatch block returns before extension dispatch |
| Origin transitions and observe grant regression | proved deterministic; pending-real focus check | host/controller tests and real harness |
| Decision metadata across commit-shaped fixture | proved packed | packed commit-shaped action result |
| Approved image/video file inputs | proved deterministic; pending-real | validation + packed FileList; real browser acceptance pending |
| Two logical workers and two host processes | proved packed | single-host dual-session and two-process harnesses |
| Restart/reconnect and readiness budget | proved deterministic; pending-real cold latency | packed disconnect/reconnect and chaos tests |
| Finalize/cleanup with no orphan processes/tabs | proved deterministic; pending-real tabs | finalize tests and zero port audit |
| Existing authenticated profile retained | pending-real | requires operator's paired Chrome profile |
| Owned tab does not steal active tab | proved contract; pending-real | inactive tab-port test; real focus observation pending |
| Explicit current-tab scope | proved contract; pending-real | controller origin/focus tests; real requested-tab proof pending |
| Concurrent Codex and Claude tasks | pending-real | actual-client harness ready; extension currently disconnected |
| Chrome and Edge stable | pending-real | versions detected; extension not loaded/paired in either browser |

Optional live advertising workflow proof is `not-approved` and is not a release requirement. No live client/account action has been attempted.

## Current release conclusion

B0 contracts and repository implementation through B6 are substantially implemented, but the release gate is **not complete**. Required real-browser/client evidence, literal source-unavailable full-workspace proof, and an actual clean-account/machine proof remain unproven. Severance work must not begin until those rows are either proved or explicitly dispositioned by the operator and the evidence ledger is updated.
