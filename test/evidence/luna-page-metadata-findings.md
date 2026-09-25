# PageDirectory metadata regression findings

## Run

- Command: `node --test packages/driver/test/page-metadata.test.mjs`
- Result: 7 tests passed, 0 failed, 0 cancelled, 0 skipped, 0 todo
- Duration: 127.6604 ms
- Production changes: none

## Covered contracts

- Inventory exposes selected state, opener page ID, current root URL, and bounded title metadata.
- Adding a popup does not switch selection away from the parent.
- Pages without an initialized root frame are omitted from inventory.
- Root navigation clears stale title and URL metadata.
- Child-frame navigation cannot overwrite root metadata.
- A stale document stamp cannot describe or overwrite newer metadata.
- Titles are bounded and redacted; credential-bearing and non-HTTP(S) URLs are not exposed.
- Removing one page invalidates its refs while preserving another page's refs and inventory.

## Findings

No defects were reproduced in the tested `PageDirectory` behavior. The tests use direct `PageDirectory` methods with deterministic routes, loaders, stamps, bindings, snapshots, and page removal; no browser or integration runtime was involved. Remaining risk is limited to untested integration paths that feed page events into the directory.
