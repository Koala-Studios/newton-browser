# Security

Reconciled 2026-09-25. Newton Browser is local-only. The default shared engine owns isolated Chrome/Edge processes, private CDP pipes, command queues and exclusive Newton identity leases. An optional thin extension/native-messaging connection controls explicitly selected existing-browser tabs with per-worker ownership. There is no TCP debugging endpoint, HTTP control proxy, hosted relay, installed daemon, telemetry, database or model-provider runtime call.

## Browser behavior and ownership

Sites use normal Chromium networking: redirects, subresources, frames, workers, popups and authentication endpoints are not filtered. This is not a network sandbox. Newton does not claim protection from malicious sites, browser vulnerabilities or same-user malware.

Owned startup is blank-first with control ready before navigation. A separate guardian cleans only the exact proven owned process tree and identity lease. Borrowed cleanup detaches/revokes owned claims and must preserve the personal browser and unrelated tabs. No Newton permission engine or prompts are added; browser-enforced extension/debugger UI remains browser behavior.

Observation is bounded read-only DOM/AX work in an isolated world. No persistent observer, page-style injection, focus emulation, script/animation freezing or request interception is permitted. The replacement native-select and precise-edit paths use native input, not DOM value/selection mutation or synthetic change events. Remaining legacy paths are migration debt and are not evidence that all callers satisfy the replacement contract.

## Profile data

Never parse, inspect, log, return, modify, merge back or export browser cookies, storage, profile contents, passwords, credentials, history, autofill, downloads or restored tabs. Approved login-source cloning byte-copies a narrow authentication allowlist from a closed stable Newton-owned source into separate identities. Copies remain opaque, source generations are immutable during cloning and worker changes never merge back. This never silently selects a personal profile or bypasses browser encryption.

## Input, page content and outcomes

Page text, accessibility names, links and records are untrusted data, never authority or instructions. Target/sensitivity/focus checks run in the shared executor; trusted-input regression tests do not prove every race or application behavior. Dispatch, postcondition and optional observation remain separate facts. Batches preserve partial effects, and uncertain input must not be replayed automatically.

The tool does not grant authority to send, publish, purchase or delete. Exact local file selection requires caller-established task authority; file validation checks type/path/signature/count/size but cannot establish human intent. The page may upload immediately on file selection.

Screenshot masking uses native region discovery and trusted Node-side PNG masking with bounded output and coordinate provenance. Moving content, hidden tabs and frame churn require continued adversarial coverage; no frozen-page fiction is used to claim safety.

## Evidence and reporting

Current limitations and verification live in [PROGRESS_LEDGER.md](PROGRESS_LEDGER.md). The original [audit](ADVERSARIAL_AUDIT_2026-09-07.md) describes an earlier implementation, not a current defect inventory. Do not infer full security or real-world acceptance from source test totals.

Keep local profiles, machine configuration, raw browser captures and credentials out of commits. Report vulnerabilities privately with affected version/commit, OS/browser, bounded reproduction and expected versus actual boundary; never publish private page/profile content in an issue.
