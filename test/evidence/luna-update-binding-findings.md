# Update-binding adversarial findings

## Focused verification

- Command: `node --test --test-concurrency=1 test/update-binding-adversarial.test.mjs`
- Result: 10 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo.
- The harness imports `apps/tab-adapter/src/update-binding.ts` directly and uses controlled fake tab events and promises; production code is unchanged.
- Scope: deterministic unit tests with a controlled fake `chrome.tabs` API; no browser launch, extension install, or sleeps.
- Production changes: none.

## Covered contracts

- Invalid tickets and foreign extension profiles are rejected before tab operations.
- One inactive exact blank marker derived from the validated extension hostname is created, and a new `UpdateBinding` instance proves it after reload.
- Pending-to-committed navigation is observed through `onUpdated`.
- Removal before commit rejects and removes both event listeners.
- A commit missed before listener subscription is reconciled through the initial `get`.
- The commit deadline rejects and cleans up both listeners.
- Ambiguous markers, wrong-ticket navigation, removed markers, and navigation drift fail closed.
- Simultaneous preparation is serialized; query/create failures do not leave the binding permanently busy.
- Query, create, and remove failures propagate.
- `finish()` removes only the exact marker proven for its ticket.

## Findings

- A `tabs.get(tabId)` failure after `tabs.create()` rejects `prepare()` with `update_binding_lost`, but the created exact marker remains. A subsequent prepare can therefore return `adapter_update_busy` because the failed marker is still discoverable. The test reproduces this deterministically by setting `getError` after creation and asserting the marker remains in the fake tab state.
- No other defects were reproduced by this focused suite. Browser-specific extension navigation and service-worker reload behavior remain outside these tests.

## Astra review closure

The retained-marker finding was reproduced and fixed after this report. `prepare`
is now idempotent for one exact committed marker with the same ticket; it does not
create another tab. A different ticket or ambiguous markers remain busy. An added
regression fails the first commit read, constructs a fresh binding, verifies a
foreign ticket is refused, retries the original ticket, and removes only its marker.
The updated 11 binding tests pass in an independent 15-test focused run with native
reconnect and the actual-worker oversized-response case. Durable journal ownership
and update locking remain the public caller's unfinished responsibility.
