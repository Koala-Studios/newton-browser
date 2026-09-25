# Lessons from the available Chrome-control interface

Date: 2026-09-07. Follow-up to the [session engine proposal](SESSION_ENGINE_DESIGN.md).

Integration status: these recommendations are now requirements within the proposed
design. Its section 10 also assesses the operator's later request for an optional thin
existing-profile extension, revising the earlier extension exclusion below.

## Evidence boundary

This comparison uses the OpenAI browser-control API documentation exposed in this session
and a small live test through its Chrome extension backend. It does not inspect a private
backend, prove a speed advantage, or establish how every ChatGPT browser product works.

Public documentation distinguishes the [regular-browser extension](https://learn.chatgpt.com/docs/chrome-extension)
from the [built-in and cloud browsers](https://learn.chatgpt.com/docs/browser). The extension
can work with existing signed-in browser context; the built-in browser uses a separate
profile. These are different integration choices. Newton's independent owned-browser/private-
pipe boundary remains unchanged.

The local test created a research tab at the public example domain, read its accessibility
and DOM representations, extracted only heading/link records, clicked its displayed link
with a resulting state read in the same tool call, and checked unchanged-state output.
The research tab was explicitly closed. No private tabs, profiles, credentials or downloads
were inspected. No model-to-model or latency benchmark was run.

## Concrete observations and what to borrow

| Capability | Evidence from this session | Implication for Newton |
| --- | --- | --- |
| Compact accessibility view | Initial output used short numeric indices, nested heading/text/link nodes, link destinations and focused-element context | Preserve relationships and readable text, not just a flat list of actionable controls |
| Automatic diff mode | API documents added/removed/changed output; the live second read returned a brief unchanged-tree message | Return explicit bounded deltas against a known baseline; unchanged is a meaningful result |
| DOM and semantic reads | The public page's DOM snapshot preserved heading level, paragraph text and the link URL; API exposes scoped role/label/frame locators | Give the model a richer reading route without requiring screenshots or raw HTML |
| Structured extraction | Read-only evaluation returned one object containing the heading and label/URL link records | Add a bounded typed extraction operation over current-page DOM evidence |
| Code composition | The persistent JavaScript session retains tab bindings; click plus resulting AX read executed in one invocation | Support deterministic action sequences plus final observation in one tool call |
| Multiple representations | API documents AX, screenshot, combined AX/screenshot, DOM snapshots and scoped text reads | Choose the cheapest representation that answers the current question |
| Useful input primitives | API documents text selection, cursor placement with prefix/suffix matching, multiline/formatted paste and exposed secondary accessibility actions | Avoid forcing the model to express text editing and every control as many keypresses |
| Internal observation waiting | API says observation handles its own wait and callers should not add sleeps | Put bounded readiness handling in the runtime, with a truthful incomplete result |
| Explicit tab objects | Tab handles support navigation, selection through returned IDs, handoff and deliverable lifetime | Make page identity and retention visible; do not hide page routing in an active-tab heuristic |

Only the specific live cases above were exercised. Rich input, combined screenshots,
frame locators, exports and lifecycle marks were documented capabilities, not tested here.
The internal algorithm for waiting, diffing or read-only enforcement is unknown.

## The important addition to the proposed architecture: typed extraction

Newton currently makes the model consume capped text or control summaries for many data
tasks. That creates unnecessary reading and reasoning work. The available comparison
interface lets the model shape current DOM evidence into the exact data it needs before
returning it to context.

Borrow the result-oriented capability without adding arbitrary page JavaScript. A
proposed typed read could express:

```json
{
  "scope": { "role": "table", "name": "Items" },
  "read": {
    "kind": "rows",
    "columns": ["Name", "Status", "Updated"],
    "includeLinks": true
  },
  "maxRows": 30,
  "maxBytes": 8192
}
```

This is an illustrative design, not a current schema. The result should retain cell
boundaries, column names, row identity, links, source page/scope, missing fields and
completeness. It must not invent normalization or infer records from an unrelated
background application store.

Implement a few useful shapes first: table rows, links, form fields with labels and
validation, and document sections. Read only current rendered-page evidence using the
existing permitted CDP/read boundary. No hidden application globals, profile storage,
network fetching, page mutation or credential inspection.

Virtualized tables need explicit limits: the visible DOM may contain only a few rows.
Never label extraction as the whole dataset. If scrolling is necessary, the caller requests
it as an action; a read must not silently drive the UI. Apply resource and redaction limits
before results leave the process.

Local client code can filter/aggregate already returned structured data without asking
the model to recopy each row. Keep that composition in the calling harness. Newton does
not need a new JavaScript execution service to provide this benefit.

## Refine two earlier recommendations

### Stable identity is an implementation choice; fresh grounding is the requirement

The inspected API explicitly tells the model to use indices from the latest AX state.
It does not establish that indices remain valid forever. The demonstrated advantage is
cheap current evidence, including an action and its resulting state in one call.

Newton must not invalidate public refs through a private read. It can meet that obligation
through bounded document refs, or by explicitly superseding a public snapshot while
returning its replacement. Test the model loop before building an elaborate ref-retention
cache. Never cite long-lived refs as a proven special feature of the comparison interface.

### Composition matters more than making every primitive intrinsically asynchronous

The useful pattern was an action and state read in one invocation. The API also allows
more expressive locator-based composition when repetition justifies it. It does not
require a start/poll/finish job around every click.

Newton's existing orchestration-capable clients can already compose tool calls. The core
must add exclusive typed batches when order must not interleave, and a canonical final
receipt. A small client helper can make the happy path convenient; a separate runtime
language is unnecessary.

## Architectural priorities informed by this comparison

1. Add structured page reading/extraction and relationship-preserving control views to
   the new reader's initial contract, not as a late convenience feature.
2. Make action plus useful state the normal invocation, with explicit baseline/diff semantics.
3. Keep semantic, textual and visual paths under the same page/command identities.
4. Supply precise editing primitives where they remove repeated model turns; verify their
   input fidelity against Newton's trusted-input boundary.
5. Teach a short representation-selection policy: semantic state for controls, structured
   reads for data, screenshots for visual uncertainty, and no repeated unchanged polling.
6. Measure completion and repair turns using the same model and tasks; do not attribute a
   perceived speed difference to undocumented backend internals.

Existing signed-in context can eliminate substantial authentication friction. The operator
subsequently asked to reconsider an optional thin extension; the main design now specifies
that proposed backend, distinct ownership and an update workflow. The implemented runtime
is still standalone-only. Optional existing-profile control must not inspect profile files
or become a prerequisite for standalone operation.

The strongest transferable advantage is the combination of useful representations and
client-side composition. None of this establishes a secret accessibility tree, magical
parser, universal site compatibility or a proprietary CDP speedup.
