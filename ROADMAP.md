# Newton Browser roadmap

Updated 2026-09-25. The shared engine is now the default source implementation; this is a completion roadmap, not a proposal to start another rewrite. Current facts and evidence live in the [progress ledger](docs/PROGRESS_LEDGER.md). The granular checklist remains [final push.md](final%20push.md).

1. Finish the model interaction loop: compact contextual next-state feedback, actionable navigation results, bounded complete/partial reading, closed-shadow coverage and precise-edit conformance. Keep original deadlines and never replay uncertain input.
2. Close lifecycle and backend gaps: pending startup/stop bounds, renderer/host loss, visual cleanup, per-worker tab isolation, real shared-login refresh/revocation, Windows Chrome/Edge and Linux installation/effect parity.
3. Retire the old implementation: migrate doctor/CLI and test/script consumers, then delete old direct-host dispatch/parser/exports. Preserve behavioral coverage; do not treat deletion or fewer files as proof of correctness.
4. Complete release tooling: reviewed engine/reader/connection groups, critical-skip failure, packed content assertions, immutable candidate identity and update/recovery evidence.
5. Freeze and accept the product: everyday authenticated forms, persisted rich editing, visual/embedded UI, shared login and real model-directed tasks in owned and existing-browser modes. Measure turns, tokens, waits, recovery, elapsed time and actual effects. Pass packed platform gates three consecutive times unchanged.

Working foundations include native actions and exact-range editing, contextual controls/typed records/documents, private owned browsers, opaque login-source clones, optional thin extension ownership and staged updates. Source tests demonstrate slices, not release acceptance. Latest historical source milestone is 841/841; fresh consolidation results are [recorded separately](docs/implementation/CONSOLIDATION_2026-09-25.md).

Standalone remains the default. Existing personal-browser access is explicit and has no Newton approval prompts. Keep private CDP, normal site behavior, independent guardian ownership, no telemetry/service/database/provider coupling, and no credential/profile inspection. Do not restore the retired relay/pairing/socket implementation.

Implementation and QA are solo. No further worker tasks, messages, waits or subagents. Public package/store publication and a merge are not part of the development checkpoint push.
