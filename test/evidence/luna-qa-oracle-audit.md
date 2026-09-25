# Packed QA oracle audit

## Scope

Audited `scripts/qa/packed-acceptance-probes.mjs` and the packed evidence files `test/evidence/astra-packed-probes-v2.json`, `test/evidence/astra-packed-probes-v3.json`, and `test/evidence/astra-packed-probes-v4.json`. No browser, build, pack, or test command was run.

## Findings

### Critical: successful MCP envelopes are treated as successful browser actions

`dataFromToolMessage` returns `ok: true` for any JSON-RPC result without a top-level protocol error (`scripts/qa/packed-acceptance-probes.mjs:111-120`). `PackedMcpClient.request` records that value as `protocolOk` and returns it without interpreting the action receipt (`scripts/qa/packed-acceptance-probes.mjs:197-212`). `act` records the receipt but only branches on `result.ok` (`scripts/qa/packed-acceptance-probes.mjs:310-336`).

Consequently, these guards do not detect rejected or failed actions:

- Wikipedia Enter: `scripts/qa/packed-acceptance-probes.mjs:370-376`.
- Wikipedia click: `scripts/qa/packed-acceptance-probes.mjs:399-405`.
- GitHub Enter: `scripts/qa/packed-acceptance-probes.mjs:470-476`.
- Document reads/continuations use the same transport-only distinction at `scripts/qa/packed-acceptance-probes.mjs:518-552`.

Required correction: normalize every `browser.act` receipt before allowing the workflow to continue. For mutating actions, require `data.state === "finished"`, `data.reason === "completed"`, no `data.errorCode`, and no step-level `errorCode`; require an acknowledged dispatch for `fill`, `press`, and `click`. For `wait_for`, allow `dispatch: "not_started"`, but still require `reason: "completed"`, `postcondition.state: "met"`, and no error. A rejected or failed receipt must call `fail(...)` and return immediately. Recovery must also inspect the returned command receipt; transport success is not action success.

### High: the runner sends an invalid key spelling

Both website workflows send `keys: ["ENTER"]` at `scripts/qa/packed-acceptance-probes.mjs:373` and `scripts/qa/packed-acceptance-probes.mjs:473`. The shipped parser defines `Enter` at `packages/driver/src/key-description.ts:7`; the published action sample also uses `keys: ["Enter"]` at `packages/core/test/action-json-schema.test.ts:14`. `ENTER` is not a shipped named-key spelling or alias. Use `"Enter"` (or the shipped `"Return"` alias at `packages/driver/src/key-description.ts:34`) and add a runner assertion that the press receipt is completed.

### High: Wikipedia can pass from pre-click or incidental evidence

The destination assertion falls back to the pre-click result href (`scripts/qa/packed-acceptance-probes.mjs:427-430`):

```js
const visibleDestination = destinationUrls.find(isWikipediaArticle) ?? articleLink.href;
```

That makes the returned link, rather than the post-click page, sufficient URL evidence. The click receipt is ignored unless the transport envelope itself fails. Require the click receipt to complete first, then independently verify the current observed page URL/title or document identity is the Ada Lovelace article and that document text contains the expected article identity/content. Do not use `articleLink.href` as a post-click destination fallback.

### High: GitHub can pass without proving the filter took effect

After the rejected Enter, the GitHub workflow only requires at least one issue link (`scripts/qa/packed-acceptance-probes.mjs:484-496`) and an `/microsoft/vscode/issues` URL (`scripts/qa/packed-acceptance-probes.mjs:498-500`). Those are properties of the unfiltered issues page as well. Require a completed Enter receipt, verify the observed filter control still contains the exact query `is:issue is:open label:bug`, and independently verify the resulting state: the current URL/query must encode the filter when available and visible rows must expose evidence consistent with open bug issues, not merely issue-shaped hrefs.

### Medium: W3C continuity assertions permit unrelated or repeated data

The continuity predicate accepts absent document stamps and only checks non-empty chunks (`scripts/qa/packed-acceptance-probes.mjs:560-569`). It does not require a stable non-null snapshot, a changed/consumed cursor, or non-duplicate continuation text. In addition, `referenceUrls` combines control-page URLs with document-chunk URLs (`scripts/qa/packed-acceptance-probes.mjs:516-517`, `scripts/qa/packed-acceptance-probes.mjs:562`), so the final URL assertion can pass using unrelated controls even when document chunks contain no reference URL.

Require the first read to return a non-null cursor, require each continuation request to consume the prior cursor and return the same non-null document stamp, require continuation text to be non-empty and meaningfully different from the preceding chunk, and derive reference URLs only from document responses. Verify the expected W3C document identity in the document output, not just that any page-control URL exists.

## Historical evidence impact

- `test/evidence/astra-packed-probes-v2.json`: all three workflows are recorded as successful even though call sequence 5 (Wikipedia Enter) and sequence 16 (GitHub Enter) have `protocolOk: true` but action receipts with `reason: "rejected"`, `errorCode: "invalid_arguments"`, and `dispatch: "not_started"`.
- `test/evidence/astra-packed-probes-v3.json`: the same sequence 5 and sequence 16 rejected Enter receipts are present while all three workflows are recorded as successful. Its Wikipedia click also failed at the receipt level, but the workflow did not fail on that receipt.
- `test/evidence/astra-packed-probes-v4.json`: sequence 5 and sequence 16 still have rejected `ENTER` actions; sequence 8 has a click receipt with `reason: "failed"`, `errorCode: "stale_target"`, and `dispatch: "acknowledged"`. Wikipedia is marked failed only because the later independent text check found empty article text; GitHub remains falsely successful because its assertions do not prove filtering.

The top-level success/exit logic (`scripts/qa/packed-acceptance-probes.mjs:670-678`) is only as trustworthy as these workflow booleans. Once the receipt helper and independent effect assertions above are enforced, failed actions cannot be masked by later observations.

## Implementation status

The listed fixes are implemented in `scripts/qa/packed-acceptance-probes.mjs`: canonical `Enter` keys, normal and recovery receipt inspection, truthful receipt-derived stop reasons, post-click Wikipedia URL/body verification, GitHub query/result verification, and strict W3C snapshot/cursor/chunk/document-link assertions. The packed workflows were not rerun for this implementation handoff because runtime navigation is changing; prior v2/v3/v4 reports remain historical evidence of the pre-fix oracle behavior.

Follow-up corrections are also implemented: intrinsic `met` postconditions for input actions, MCP `isError` propagation, unavailable/none control-observation rejection, current-location checks sourced only from `observation.url`, Wikipedia suggestion navigation without the invalid Enter step, and a fresh GitHub filter ref plus submitted `q` URL verification. No packed workflow was rerun.

The W3C oracle now extracts only validated HTTP(S) destinations from documented angle-bracket syntax in returned document chunks, reparsing adjacent chunk pairs for boundary-spanning links. Evidence labels this source `inline_document_link_destinations`; control observations and arbitrary text URL matches are not used. It also independently checks the actual first-chunk/title identity against the expected HTML Living Standard text while preserving snapshot, cursor, and duplicate-chunk checks. No packed workflow was rerun for this correction.
