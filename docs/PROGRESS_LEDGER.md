# Newton Browser progress ledger

## Current completion program — 2026-08-11

The owner approved completing the no-extension architecture. Implementation is now
consolidated around one local MCP package that owns isolated Chrome or Edge processes over
private CDP pipes. The former MV3 application, loopback relay, pairing/version-skew plane,
current-tab/tab-group/incognito compatibility runtime, browser-store assets, and extension
build/release paths have been deleted.

This is the completed direct-only candidate. The current tree has
passed its consolidated deterministic gate, Windows Chrome/Edge direct and public
real-site matrices, and the pinned Linux Chrome-for-Testing container. The
operator-authorized Chrome Default opaque import ran successfully with exact
source/identity cleanup. On 2026-08-12 the owner explicitly removed authenticated-site QA
from the release scope and directed Newton to validate only sites that do not require
sign-in. This is also the honest Windows boundary: Chrome App-Bound Encryption can prevent
cookies copied from the standard user-data directory from decrypting under Newton's
isolated `--user-data-dir`. An earlier frozen candidate passed `pnpm release:check` three
times with one byte-identical package. That sequence is historical because the public-site
receipt and RFC Editor first-navigation correction were materialized afterward. The final
evidence-bearing tree is finalized only by a commit-body attestation after its required
three-pass confirmation, per Decision 44.
Historical extension-era receipts do not close any current gate.

## Definition of complete

Newton Browser is complete only when every row below is recorded against the same frozen
tree and no later source, test, documentation, dependency, or generated-artifact change has
occurred:

| Gate | Required evidence | Current state |
| --- | --- | --- |
| Sole architecture | no production/package/document/skill dependency on the deleted extension, relay, pairing plane, browser store, or current-tab compatibility contracts | pass; direct-only boundary gate passed |
| Direct runtime | source and exact-packed MCP start/observe/act/screenshot/stop on installed Windows Chrome and Edge and Linux Chrome | pass on Windows Chrome/Edge and pinned Linux Chrome |
| Concurrency | same-session FIFO plus cross-session progress with distinct processes/identities and zero residue | pass on Windows Chrome/Edge and Linux Chrome |
| Containment | direct navigation, mutation, connection, popup, worker, frame, redirect, and HTTPS grant behavior with honest outcomes and zero denied application requests | pass on Windows Chrome/Edge and Linux Chrome |
| Frames/input/lifecycle | same-process and OOPIF routing, nested actions, dialogs, renderer failures, process loss, guardian cleanup, and stale-ref fencing | pass on Windows Chrome/Edge and Linux Chrome |
| Trusted screenshots | exact sensitive-zone refs are measured under a script/animation freeze and masked in trusted PNG raster bytes; uncertainty never returns unmasked pixels | pass on Mercato in Windows Chrome/Edge and Linux Chrome plus deterministic raster regressions |
| Agent usability | compact/token gates plus unauthenticated read-only RFC Editor, Wikipedia, Mercato di Bellina storefront, and W3C accessibility workflows | pass on Windows Chrome, Windows Edge twice, and Linux Chrome for Testing; no sign-in-dependent site is in release scope |
| Optional identity migration | one operator-authorized closed-profile opaque byte copy, identity deletion, no source mutation, and no profile parsing/logging | pass for import and cleanup; authentication preservation is not claimed or release-gated, and standard-profile Google sessions may be unusable after isolated Windows launch because of Chrome App-Bound Encryption |
| Packaging and platform | exact tarball install/run, Windows Chrome/Edge, Linux Chrome for Testing, bounded receipts, and zero process/proxy/lease/temp residue | pass; final Linux run `linux-cft-3468e9531b2a05d215e1`, source digest `c81f89cfaf4d2f7cc27208f9b3cd4ec66a58606731f607a269ac929d2fe0d8e2` |
| Release stability | `pnpm release:check` passes three consecutive times on an unchanged frozen tree, with exact hashes and no skipped critical tests | the final commit is valid only when its body records the exact 3/3 attestation required by Decision 44; the latest in-tree precursor receipt is `QA-COMPLETE-006` |

## Implementation status by plan

| Plan | Implementation state | Remaining completion evidence |
| --- | --- | --- |
| 01 command pump | complete | current deterministic/live evidence passed |
| 02 lifecycle/framing/guardian | complete | current crash and cross-platform cleanup evidence passed |
| 03 target/frame/session registry | complete | current Windows/Linux nested frame evidence passed |
| 04 preventive containment | complete | current popup/worker/frame/redirect matrix passed |
| 05 input/renderer reliability | complete | current real-browser matrix passed |
| 06 compact output | complete | current token budgets passed |
| 07 schemas/provenance/privacy | complete | current schema/redaction gates passed |
| 08 strict TypeScript/build parity | complete | current typecheck/build parity passed |
| 09 regression/release program | implementation complete | final commit must carry the Decision 44 attestation |
| 10 owned browser/private CDP | complete | Windows/Linux live evidence passed |
| 11 launch-time policy proxy | complete | current containment matrix passed |
| 12 identities/opaque import | complete optional workflow | imported profile proved closed/copyable/cleanable; authentication preservation is explicitly not a release claim |
| 13 direct driver/host collapse | complete | current integrated/packed evidence passed |
| 14 compact agent operations | complete | token evidence and final four-site Chrome/Edge public rerun passed |
| 15 deletion/release | implementation complete | final commit must carry the Decision 44 attestation; publishing remains separately gated |

## Current implementation facts

- Direct stdio is the ordinary transport. Explicit Unix-socket continuity is local-only
  and does not install a daemon.
- Every session owns a browser process, exact origin grant, policy proxy, CDP transport,
  identity lease, command pump, and guardian ownership record.
- Initial browser state is blank and containment is established before the first granted
  navigation.
- Opaque profile import is operator-only, closed-source-only, allowlisted, stability
  checked, no-follow, atomic, and never merges back into the source.
- Screenshot masking is performed after capture inside trusted Node code while page script
  execution and animations are frozen through CDP. A masked JPEG request is deliberately
  returned as PNG. Target, geometry, freeze, capture, decode, or resume uncertainty fails
  closed.
- Public MCP remains the compact 11-tool surface; process, target, session-routing,
  filesystem, profile, and proxy identities are not published.
- The packed MCP is built by a deterministic five-file USTAR/gzip encoder with fixed
  ordering and metadata; exact artifact SHA-256 equality is required across release passes.
- No public publishing, remote, license change, or browser-store submission is authorized.

## Evidence policy

Final evidence belongs under `test/evidence/` and must include the exact source digest,
platform/browser/runtime versions, bounded stage results, packed artifact hash and entries,
residue facts, and release pass ordinal. Receipts may contain codes, counts, categories,
hashes, and fixed step names only; they must not contain page content, credentials, profile
paths, profile contents, origins from private authenticated work, or raw browser/CDP logs.

The historical AIP and extension-era records remain under `test/evidence/` for engineering
traceability. They are explicitly superseded as release evidence by this ledger.
