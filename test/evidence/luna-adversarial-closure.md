# Luna adversarial closure

Source review: `C:\DEV\newton-browser\docs\implementation\LUNA_ADVERSARIAL_REVIEW.md`.

| Finding | Result | Evidence |
| --- | --- | --- |
| Retired host in release and real-site gates | Fixed | `scripts/smoke/packed-real-sites-live.mjs`; packed receipt includes `engine: packed_default_session_engine` and `legacyHost: false`. |
| Disabled native select | Fixed | `test/evidence/luna-engine-regression.json` and `packages/driver/src/page-executor.ts`. |
| Covered click | Fixed | `target_moved` in `test/evidence/luna-engine-regression.json`. |
| Wait semantics | Fixed | Hidden and detached waits pass in `test/engine-regressions/luna-adversarial.test.mjs`. |
| Back/forward | Fixed | History action passes in the same independent test. |
| Empty fill and selection type | Fixed | Empty value and `aXd` are asserted by independent DOM reads. |
| Escaped document budget | Fixed | Packed real-site Wikipedia document read completes within the requested envelope. |
| Missing Spark packets | Implemented candidate | Records/deltas, coordinate action, source UX, and explicit existing adapter status are wired through the public engine. |
| Legacy compatibility seam | Residual | Default/release reachability is removed; old injected setup/test sources remain for a separate migration. |
