# Existing page-family route capacity findings

## Focused verification

- Command: `node --test --test-concurrency=1 test/existing-page-family-route-capacity.test.mjs`
- Result: 3 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo.
- Tests use a deterministic fake native client and no browsers, builds, or native sockets.

## Covered contracts

- Re-announcing an already-owned route remains valid at the 256-route capacity boundary.
- A genuinely new route after 256 routes closes the client.
- A route collision between two owned tabs closes the client without issuing a command.

## Fix

- The route guard now checks capacity only when the route is new; same-tab duplicate announcements no longer trigger false client closure. Cross-tab collisions retain their rejection behavior.
