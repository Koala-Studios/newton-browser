# Spark packet04 — release candidate identity and grouped test runner

Work in authoritative421a checkout. No tests/builds/browser/task messages/subagents. Luna is testing batch02; no existing production/config/test files may change. Write ONLY:
- NEW `scripts/release-candidate.mjs`
- NEW `scripts/qa/session-engine.mjs`
- `docs/implementation/SPARK_04_DELIVERY.md`

Do not wire root scripts yet. No framework/dependencies. These are small reusable root-script helpers for P13/P14, not proof of acceptance.

## Candidate digest

Read current scripts/release-complete-local.mjs candidateDigest implementation. Export `candidateDigest(root=process.cwd())` synchronous returning `{sha256,files,excluded}` where files is count and excluded is an array of explicit excluded inventory paths. No import-time subprocess/effects. Use execFileSync('git',['ls-files','-co','--exclude-standard','-z'],{cwd:root,encoding:'buffer',windowsHide:true,timeout:30000,maxBuffer:16*1024*1024}). Do not compose a shell string.

Inventory includes tracked plus untracked nonignored files; deduplicate before sorting using deterministic ordinal comparison, not localeCompare. Root realpath must exist. Reject absolute relative entries, NUL, path escapes, backslashes masquerading as separators on Linux, symlink traversal in ancestor paths. File itself may be symlink: hash link target text rather than follow it; do not read through symlinks. Explicit intended missing tracked file hashes as deleted marker, not omitted. Unexpected directories/devices rejected. Hash relative normalized slash path and type, byte count and exact file bytes with unambiguous NUL separators. Do not hash timestamps. Do not exclude all docs/tests/new files or ignore source changes because Git reports dirty.

Only explicit output exclusions: `test/evidence/runs/`, `artifacts/`, root `coverage/`, exact workspace `node_modules/` and `dist/` directories under root, apps/<one package>/, packages/<one package>/. Do not exclude a source subdirectory merely named dist (e.g. packages/driver/src/dist). Since most are already gitignored, exclusions only act when inventory contains them. Other existing evidence files remain candidate inputs. Return excluded list for audit.

Before hashing each regular file capture lstat; open handle and fstat and compare dev/ino; read bounded chunks with total cap 64MiB per file, streaming into hash; after read verify size/dev/ino/mtime/ctime unchanged, and final lstat still same entry. Reject changing file, hard link (nlink!==1) and oversized file with bounded machine error names, no file contents. Document these exclusions/caps; user credentials/profile files are not candidates and must never be searched for or read.

No CLI in this module yet; Astra wires release orchestration to it. No commit/manifest writing, network, cleanup or mutable global cache.

## Grouped deterministic test runner

Implement executable ESM `scripts/qa/session-engine.mjs` with optional import-safe `engineTestFiles(root,group)` export. CLI accepts exactly one group `engine|reader|connections`; unknown/missing/extra args fail nonzero. Root derived from import.meta.url (two parents), not caller cwd. Only run CLI if process.argv[1] resolves exactly to this module.

Use existing test discovery convention .test.js/.test.mjs/.test.ts and node --test --test-isolation=none. No test framework, new fixtures or syntax conversion. Return sorted unique absolute paths; reject symlinks during traversal. Groups:
- engine: packages/core/test/command-foundation.test.mjs; packages/driver/test/engine-foundation.test.mjs; driver native-input, target-inspection, navigation-probe, navigation-feedback, press-feedback, hidden-input, action-new-pages test files; test/engine-regressions directory.
- reader: driver filenames matching ax-snapshot, control-reader, control-budget, document-chunk, record-delta*, table-grid*, scoped-document*, scoped-control*, frame-scope-predicate, raster-mask, screenshot-mask-consistency, native-sensitive-regions; plus engine-regressions document-reader, structured-records, oversized-observation, control-context, sensitive-shadow-discovery.
- connections: discover existing root test filenames and apps/mcp-server/test filenames relevant to engine-host, existing/native, adapter, tab, source/profile-transaction/process-table foundations. Before coding read rg --files output to build a CONCRETE exact required file list that exists, rather than a fuzzy regex catching arbitrary tests. Put lists in this runner, concise comments explain scope. Require each listed file exists and is regular; missing file is hard failure, never silent omit. No old direct-runtime tests in these new groups.

Use spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',windowsHide:true,timeout:600000}). Propagate exit/failure. Print no fake completeness receipt. Tests currently may skip: this runner does not claim critical-skip enforcement; delivery must mark release completeness enforcement as remaining work. Do not run the runner now while Luna is testing. No package.json/root scripts changes.

Delivery: APIs, exact lists/exclusions, why source changes cannot be hidden, identified limits and missing final release wiring. Do not claim tests passed. End normal final response.
