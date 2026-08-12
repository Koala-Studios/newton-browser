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
   workflows, not release gates; an imported-identity QA run records identity use but never
   claims that opaque import preserved authentication.
5. Require the deterministic five-file USTAR/gzip package receipt and compare its exact
   SHA-256 across all three passes; functional `npm install` success alone is insufficient.
6. Run `pnpm release:check` three consecutive times on the unchanged candidate on both
   Windows (Chrome and Edge) and Linux (Chrome), and run the pinned Linux Chrome for
   Testing container. Any source, test, config, lockfile, doc, or skill change resets the
   count. The command inventories tracked and non-ignored untracked candidate files,
   records their SHA-256 content digest, and fails if that digest changes during the gate.
7. Require matching Windows/Linux tarball hashes and bounded platform receipts before the
   separately approved publish job can create the release or invoke npm publication. The
   release workflow's `scripts/release-three-pass.mjs` additionally requires one clean
   tagged tree, one candidate digest across all three platform passes, and matching
   Windows/Linux commit and Git-tree identities; Linux live receipts live outside the
   source inventory.

Preparatory receipts belong under `test/evidence/`, contain bounded codes/counts/hashes
rather than page or profile content, and identify the tested content. The final
unchanged-tree result is written into the body of the commit that first makes that exact
content durable, avoiding a self-referential post-test evidence edit. Historical extension
receipts do not satisfy a direct-only release gate.
