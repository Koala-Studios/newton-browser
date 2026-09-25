# Document reader regression findings

## Run

- Command: `node --experimental-strip-types --test test/engine-regressions/document-reader.test.mjs`
- Result: 3 passed, 0 failed, 0 skipped, 0 cancelled.
- Duration: 2000.7319 ms.
- Fixture: deterministic local HTTP server with owned browser cleanup; no profile, cookie, storage, or external network reads.
- Scope: current shared `PageExecutor` through `ownedEngineConnection`; no builds or package installs.

## Covered contract

- Paragraph boundaries remain readable with preserved whitespace separation.
- Visible link labels retain their real destination URLs.
- Preformatted code whitespace and indentation survive document extraction.
- Hidden content, script/style text, input initial values, and `textarea autocomplete="one-time-code"` values are excluded.
- Tiny `maxBytes` values produce multiple bounded chunks that reconstruct the complete document exactly.
- Each chunk preserves Unicode surrogate pairs.
- A cursor from the prior document generation is rejected with `cursor_expired` after navigation.

## Findings

No genuine product failure was observed in this run. The first draft required exactly one newline between paragraphs; the fixture output preserved the boundary with an additional whitespace-only line, so the assertion was corrected to require whitespace separation rather than a formatting-specific newline count.
