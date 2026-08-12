# Release process

Newton Browser ships one npm MCP package. There is no browser-extension artifact or
browser-store release.

1. Freeze the exact candidate tree and record its commit plus dirty-content digest.
2. Run deterministic build, lint, typecheck, tests, evals, token budgets, pack/install,
   catalog, and cleanup gates.
3. Run the complete direct live suite and public real-site suite on Windows Chrome and
   Edge, then Linux Chrome for Testing in the pinned container.
4. Record unauthenticated read-only public-site evidence and trusted sensitive-zone
   screenshot evidence. Profile import and persistent-identity login are optional operator
   workflows, not release gates; never claim that opaque import preserves authentication.
5. Require the deterministic five-file USTAR/gzip package receipt and compare its exact
   SHA-256 across all three passes; functional `npm install` success alone is insufficient.
6. Run `pnpm release:check` three consecutive times on the unchanged candidate. Any source,
   test, config, lockfile, doc, or skill change resets the count.
7. Build the npm tarball, verify its allowlist/hash/entry count and packed install from a
   spaced path, then create the approved release and publish only with separate authority.

Preparatory receipts belong under `test/evidence/`, contain bounded codes/counts/hashes
rather than page or profile content, and identify the tested content. The final
unchanged-tree result is written into the body of the commit that first makes that exact
content durable, avoiding a self-referential post-test evidence edit. Historical extension
receipts do not satisfy a direct-only release gate.
