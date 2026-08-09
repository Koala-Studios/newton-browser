# Newton Browser 0.1 Contract Decisions

Status: locked for implementation on 2026-07-10. Changes require an explicit decision entry and matching contract tests.

## 1. Multi-host mechanism: bounded port-range discovery

Chosen: Option A, bounded port-range discovery on `127.0.0.1:17321-17340`.

Option A keeps every stdio MCP process independent: a host binds the first free port, the extension maintains one authenticated socket per discovered host, and routing uses the tuple `hostInstanceId + sessionId`. Losing one host cannot make another host's sessions depend on leader election. Option B would keep one extension socket but turns the first short-lived client process into an incumbent broker and requires proxying, successor election, and crash-safe handoff. That lifecycle is materially more complex and creates a hidden daemon-like responsibility inside an ordinary client process.

Discovery is bounded to 20 loopback ports. A host that cannot bind within the range returns typed `host_collision`; it never exits from an unhandled `EADDRINUSE`. The popup reports only connected host and session counts.

## 2. Transport authentication: zero-touch local trust with opt-in pairing

Revised by explicit user decision on 2026-07-10: `local_trust` is the default. Installing the extension and configuring the MCP package is sufficient; no key paste or popup action is required. Every host still binds only to `127.0.0.1`, accepts only Chromium extension WebSocket origins, keeps the bounded port range, and applies all session-origin and action-floor controls.

The optional hardened mode is enabled with `{"transportAuth":"paired"}` in the per-user `config.json`, or `NEWTON_BROWSER_AUTH_MODE=paired`. In that mode the MCP package creates/reads a random 256-bit base64url secret in the per-user config directory, `--doctor` prints it for deliberate one-time entry in the extension popup, and the extension stores it in `chrome.storage.local`. Normal MCP mode never emits it.

Hardened mode sends `{type:"auth_challenge",protocol:"newton-browser-auth-v1",hostInstanceId,nonce}`. The extension answers with `{type:"auth_response",hostInstanceId,proof}` where `proof = base64url(HMAC-SHA-256(secret, "newton-browser-auth-v1:" + hostInstanceId + ":" + nonce))`. Until verification, that socket may send no bridge requests and is closed after 3 seconds. Nonces are random, single-use, and process-local; comparison is constant-time.

Tradeoff: local trust allows another process running as the same OS user to imitate an extension-origin client on loopback. Pairing raises that bar for ordinary local processes, but it does not defend against same-user malware able to read the config file or extension storage. Native Messaging could provide a stronger OS registration boundary but would require a platform installer, contrary to the zero-touch artifact goal for 0.3.0.

## 3. Screenshot delivery

`browser.screenshot` accepts:

```json
{
  "sessionId": "required",
  "delivery": "image | file | inline",
  "outputDirectory": "absolute path required for file",
  "filename": "optional basename ending in .png",
  "fullPage": false,
  "device": "mobile | desktop",
  "waitMs": 0
}
```

`delivery` defaults to `image`.

- `image`: the MCP tool result contains one JSON metadata text block and one `{type:"image", data, mimeType:"image/png"}` content block. Base64 is never placed in the JSON text block.
- `file`: the host decodes the PNG and writes it only inside the caller-designated absolute output directory. It returns `{delivery:"file",path,filename,bytes,sha256,width,height,fullPage,truncated}`. The default filename is `newton-browser-<UTC timestamp>.png`; caller names are sanitized to a basename.
- `inline`: compatibility fallback returning `dataUrl` inside JSON text, capped at 1,000,000 characters. Larger output returns typed `result_too_large` with `recommendedDelivery:"image"` or `"file"`.

Relay messages are capped at 24 MiB encoded and screenshot bytes at 16 MiB decoded. A result above either bound returns `result_too_large`; it is never truncated silently. Sensitive-zone masking occurs in the extension before bytes cross the relay.

## 4. `browser.act` floor decision shape

Every `browser.act` response, successful or blocked, carries:

```json
{
  "ok": true,
  "actionStatus": "verified",
  "decision": {
    "class": "read_only | agentic | approval_required | blocked",
    "commitBoundary": "none | draft | commit | external_effect",
    "reasons": ["typed_reason"]
  },
  "result": {}
}
```

`decision` is the strongest of the host preflight and extension pre-dispatch decisions. The caller may raise risk but never lower it. Newton Browser exposes classification; it is not an approval system.

## 5. Mandatory session origin

`browser.session.start` requires `origin`. It must parse as HTTP(S) and is stored as normalized `URL.origin`. `allowedOrigins` defaults to `[origin]`; every entry must independently parse as an exact normalized HTTP(S) origin. Wildcards, paths, credentials, fragments, and origin-less sessions are rejected with typed `invalid_origin` or `origin_required`.

The tool does not return success until the extension has created/selected the tab, attached the debugger, and reported the tab's live origin. A current-tab session is denied unless the live tab origin is in the grant. Observe and act re-check the live origin for every command, so focus changes cannot move a session outside its grant.

## 6. Host-policy manifests remain and are active

Chosen: wire the machinery.

Newton Browser ships without vendor-specific host-policy manifests. An optional per-user `config.json` may define `hostPolicies`; the schema is validated at startup and by `--doctor`. The host selects a matching manifest from the command's reconciled live origin and passes it into both preflight and extension-side floor evaluation. Screenshot `sensitiveZones` from a selected manifest are passed into capture. The generic structural safety floor remains active when no manifest matches. Invalid configuration produces typed `invalid_config`; inert manifests are forbidden by tests.

## 7. New lifecycle contracts

### `browser.status`

Input: `{}`. Result:

```json
{
  "ready": true,
  "version": "0.3.0",
  "protocolVersions": ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"],
  "hostInstanceId": "uuid",
  "port": 17321,
  "authMode": "local_trust",
  "zeroTouch": true,
  "paired": false,
  "browserTarget": "auto",
  "extensionConnected": true,
  "connectedBrowsers": ["chrome", "edge"],
  "eligibleClientCount": 2,
  "claimedSessionsByBrowser": {},
  "hostCountSeenByExtension": 1,
  "sessionCount": 0,
  "limits": {}
}
```

Default not-ready states use typed `extension_disconnected` or `protocol_mismatch` without opening a tab. Hardened mode can additionally return `pairing_required` or `authentication_failed`.

### `browser.tabs.finalize`

Input: `{sessionId, disposition:"close | deliverable | handoff"}`.

- `close`: detach and close the owned tab.
- `deliverable`: detach, remove the driving overlay, keep the tab and its group for passive review, then end the session.
- `handoff`: detach, remove overlay and Newton Browser group ownership, activate the tab, then end the session.

The result is `{finalized:true,disposition,tabId,tabKept}`. Current-tab sessions never close the user's tab. On normal host exit, unfinalized owned sessions are closed by the extension after a 15-second disconnect grace; finalized deliverable/handoff tabs remain. One host's death affects only sessions stamped with its `hostInstanceId`.

## 8. `set_files` contract

`set_files` is a `browser.act` action:

```json
{
  "kind": "set_files",
  "target": {"ref": "fresh observation ref"},
  "files": ["C:\\absolute\\asset.png"]
}
```

Rules:

- exact absolute file paths only; no glob, directory, environment-variable, tilde, or symlink expansion;
- target must resolve unambiguously to `<input type="file">` from a fresh observation;
- at most 8 files, 50 MiB each, 200 MiB total;
- allowed extensions/MIME: PNG, JPEG, WebP, GIF, MP4, and WebM;
- all files are validated before `DOM.setFileInputFiles`; a validation failure sets no files;
- hidden inputs require an exact fresh ref; broad text/selector targeting of hidden inputs is rejected;
- result exposes sanitized `{filename,sizeBytes,mimeType}` entries, never full paths;
- acceptance is verified from the input's `files` list;
- cancellation is `{kind:"set_files",files:[]}` and clears the input;
- no upload, submit, save, publish, or other button is clicked automatically.

## 9. Node, packages, exports, and artifacts

Supported runtime baseline is Node `>=24.0.0`, selected from the source's existing Node 24 APIs and verified locally on Node 25.9.0. Release proof must include Node 24 before the engine range is widened or the release is called complete.

Locked package names:

- `@newton-browser/core`
- `@newton-browser/driver`
- `@newton-browser/extension`
- `newton-browser` with executable `newton-browser`

Public package exports point to compiled JavaScript under `dist/`; no package bin or export points at TypeScript. Release artifact names are:

- `newton-browser-0.4.0.tgz`
- `newton-browser-extension-0.4.0.zip`
- `newton-browser-extension-0.4.0.zip.sha256`

The repository is public as of 2026-07-10. The owner explicitly approved the MIT License on 2026-07-10 and confirmed the copyright holder as `Koala Studios`; the repository's `LICENSE` is therefore `Copyright (c) 2026 Koala Studios`. Version 0.4.0 is public on npm and GitHub. Its Chrome Web Store listing was accepted and became public on 2026-07-13. That acceptance satisfies the condition that deferred Edge Add-ons; the Edge listing remains outstanding.

## 10. Boundary and stale concepts

Runtime source, package metadata, scripts, fixtures, docs, and artifacts must not import, name, or reference the source product/repository, its services, or its private shared files. The boundary check also rejects retired concepts: the old non-local transport enum, database host-policy table comments, raw TypeScript package bins, cross-package relative source escapes, and the former private shared module.

The provenance hash in the evidence history is non-runtime provenance and is the only temporary source-reference exception from extraction; release artifacts contain no such reference.

## 11. Simultaneous-browser arbitration

Chrome and Edge may keep the same unpacked extension enabled at the same time. Every browser profile persists a random local client identity and announces only that identity plus its browser family to each loopback host. For every session, the host performs one atomic claim: exactly one eligible extension becomes owner, while every other extension remains connected as standby.

Only the owner may attach a tab, subscribe, stop the session, or return command results. Commands are sent only to that owner's socket. A non-owner receives typed `session_not_owned` and cannot race or duplicate an action. If the owner disconnects, the host releases the claim, clears browser-specific tab identifiers, and lets one standby reclaim and bind a fresh tab; an in-flight command fails closed as `extension_disconnected` rather than being replayed.

The default `browserTarget` is `auto`, so installation remains zero-touch and the first atomic claimant owns each new session. A user who wants deterministic browser selection may set `{"browserTarget":"chrome"}` or `{"browserTarget":"edge"}` in the per-user `config.json`, or set `NEWTON_BROWSER_BROWSER=chrome|edge` for that MCP process. Non-selected browsers stay connected as standby and never receive session control. `browser.status` reports the target, connected browser families, eligible-client count, and aggregate claimed-session counts without exposing profile identity values.

## 12. Rename to Newton Browser (2026-07-10)

The project, formerly "Browser Bridge", is renamed to **Newton Browser** (`newton-browser`) by owner decision. `browser-bridge` and `browser-bridge-mcp` were already occupied on npm by unrelated projects, and the owner selected the new brand before first publication. The rename is a single pre-1.0 breaking change covering:

- npm package and CLI bin: `newton-browser` (formerly workspace `browser-bridge-mcp`)
- Internal workspace packages: `@newton-browser/core`, `@newton-browser/driver`
- Extension manifest name/short name: "Newton Browser" / "Newton"
- Environment variables: `NEWTON_BROWSER_*` (formerly `BROWSER_BRIDGE_*`)
- Transport auth protocol id: `newton-browser-auth-v1` (formerly `browser-bridge-auth-v1`)
- Doctor probe header: `X-Newton-Browser-Doctor`
- Per-user config directory: `newton-browser`
- Extension-internal message types: `NB_*` (formerly `BB_*`)
- Default owner/tab-group label: "Newton" (formerly "Bridge")
- Skill: `skills/newton-browser`
- Release artifacts: `newton-browser-<version>.tgz`, `newton-browser-extension-<version>.zip`
- GitHub repository: `Koala-Studios/newton-browser`

The standalone-boundary guards that previously blocked the terms "newton" (a legacy internal codename, guarded in `scripts/verify-boundary.mjs` and the extension coupling test) and "koala studios" (now the public GitHub org and MIT copyright holder) are lifted by this decision; both strings are now sanctioned public branding. All other boundary and identity guards remain in force.

MCP tool names (`browser.*`) are deliberately unchanged: they are generic, describe the capability rather than the brand, and renaming them would invalidate recorded client transcripts for no benefit. Historical evidence under `test/evidence/` and recorded artifacts keep the old name as accurate records of what was tested. No compatibility shims are provided for old env vars, config directories, or the old auth protocol id; 0.3.0 installs must be reconfigured.

## 13. Popup session-summary contract (2026-07-10)

The popup remains a glanceable, local status surface. `NB_PANEL_STATUS` and `NB_STATE` carry at most 32 summaries, each containing only an exact session origin, `owned` or `current` mode, and an optional instance label. They never carry a URL path, page title, favicon, page text, or any other page-derived content. `NB_PANEL_STOP_ALL` maps only to the existing local `stopAll` lifecycle path; it does not create an approval or action channel. Contract tests enforce the field projection and empty-list behavior.

## 14. Host/extension version skew (2026-07-10)

The loopback `ready` and `client_hello` frames carry optional package/manifest versions. Missing versions from a 0.3 peer are tolerated as unknown. Equal versions report `none`; patch-only difference reports `patch`; major or minor difference reports `incompatible` while operations continue. `browser.status` exposes host and extension versions and, for incompatible skew, instructs the user to update the older side. The popup shows one amber warning only for incompatible skew.

## 15. npm packaging, runtime Node floor, and `--install` (2026-07-10)

The host publishes to npm as **`newton-browser`** (the `browser-bridge`/`browser-bridge-mcp` names were already occupied by unrelated projects). The bin is also `newton-browser`, so `npx -y newton-browser` both installs and launches.

Runtime vs. development Node floors are split deliberately:

- The published package declares `engines.node >=20.0.0`, and `scripts/build-mcp.mjs` targets `node20`. The compiled `dist` bundle carries its only runtime dependency (`ws`) and uses no API newer than Node 20, so current-LTS users can run the host through `npx`. `--doctor` accepts Node 20+.
- The root workspace still declares `engines.node >=24.0.0` because the test suite type-strips TypeScript sources with `node --test`, which requires a modern Node. Contributors need Node 24; end users do not.
- The private workspace packages (`@newton-browser/core`, `@newton-browser/driver`, `@newton-browser/extension`) declare `>=20.0.0` to match the runtime floor of the code they compile into the bundle. `scripts/verify-boundary.mjs` enforces the `>=20.0.0` engines contract on all package manifests.

`newton-browser --install <codex|claude-desktop|claude-code|generic>` configures a client:

- `codex` merges a `[mcp_servers.newton-browser]` table into `~/.codex/config.toml`; `claude-desktop` merges an `mcpServers["newton-browser"]` entry into the platform Claude Desktop config JSON.
- Any existing file is copied to a timestamped `.bak` before writing. An existing `newton-browser` entry is never overwritten without `--force`; the tool returns a typed conflict message instead.
- `--dry-run` prints the planned file without touching disk. Unparseable existing config is reported (`client_config_unparseable`), never clobbered.
- `claude-code` and `generic` are not edited in place — Claude Code owns its own MCP store and generic clients have no canonical path — so the tool prints the exact `claude mcp add-json` command or config block to apply. Interactive confirmation is intentionally omitted in favor of `--dry-run` preview plus mandatory backup, which are deterministic and testable.

The planning logic (`planClientInstall`) is IO-free and unit-tested for all clients across Windows, macOS, and Linux path conventions.

## 16. Readable-text observations, and no arbitrary JavaScript (2026-07-10)

### `browser.observe` text mode (WS9.1)

`browser.observe` accepts `mode: "text"` with an optional `maxChars` (200–200,000, default 20,000). It returns `{ kind: "observation_text", origin, title, text, chars, truncated }` where `text` is the page's main/article content (falling back to `document.body.innerText`). This is the cheap "read the prose" primitive; a full accessibility snapshot is unnecessary when the caller only needs to read, not target.

The raw text crosses the loopback relay and is redacted host-side by `redactBrowserResult` before it reaches the client — the same trust boundary as accessible names in a normal observation. Redaction runs the standard secret/PII pass plus bare card- and SSN-like masking, then bounds the result at a hard 200,000-character cap independent of the requested `maxChars`. The mode is read-only (`decision.class: "read_only"`); it dispatches no input and mutates nothing.

### No arbitrary JavaScript evaluation tool (WS9.7)

Newton Browser will not expose a general JavaScript-evaluation or expression tool. Every mutation must route through a typed action so the safety floor's classification (`read_only`/`agentic`/`approval_required`/`blocked`, and the commit boundary) is sound. An eval tool would let a caller perform navigation, form submission, network writes, and DOM mutation without any of that classification, converting the floor from a guarantee into a suggestion. This is a deliberate capability gap, not an oversight. It may be revisited only as a sandboxed, provably read-only expression evaluator with its own contract; unrestricted evaluation is out of scope permanently.

## 17. JavaScript dialog accept/dismiss (WS9.4, 2026-07-10)

Newton Browser now answers page-initiated JavaScript dialogs instead of returning a
blanket unsupported result. Two typed act kinds are added: `dialog_accept` (with an
optional `promptText` applied only to `prompt()` dialogs) and `dialog_dismiss`. They map
to CDP `Page.handleJavaScriptDialog`. The driver tracks an open dialog from
`Page.javascriptDialogOpening` / `Page.javascriptDialogClosed` independently of the
per-action signal window, because a dialog blocks the renderer until answered, and
surfaces it as `pendingDialog` on observations (message and default prompt pass the
observation-text redaction, so a dialog cannot leak a card/SSN the field passes miss).

Floor: both kinds are `agentic` and can never be `blocked`-class — the dialog exists
because of an action the agent already took, and leaving it open wedges the page. They
remain available even when actuation is disabled, so an observe-only session can still
clear a blocking dialog. Post-action reconciliation is unchanged: an accept that fires a
navigation or network write is caught exactly like an agentic click. Newton Browser does
not auto-answer dialogs; the agent decides. The legacy `handle_dialog` kind returns the
typed `use_dialog_accept_or_dismiss` pointing at the new kinds.

## 18. Owned-tab viewport resize (WS9.6, 2026-07-10)

A `resize` act kind sets the owned tab's viewport via `viewport: { width, height }`
(CDP `Emulation.setDeviceMetricsOverride`, deviceScaleFactor 1, non-mobile). It is
owned-tab only — a current (user) tab is never silently reflowed, returning typed
`resize_needs_owned_tab`. Sizes are bounded to 200–3840 × 200–2160 so a caller cannot
request a surface large enough to wedge the serial capture pump. The override is stored
on the driver and re-applied after a debugger re-attach (e.g. a cross-process
navigation), so the caller's chosen size is not silently reverted. Floor class is
`agentic` (a layout change, not a commit). The per-shot screenshot `device` preset is
unchanged and independent.

## 19. Host-side observation redaction is wired into the result path (2026-07-10)

Secret/PII redaction of observation results (`redactBrowserResult`) runs in the host
before results reach the MCP client, closing BB-035. The driver produces raw accessible
names/values and, for `mode:"text"`, full page innerText; these cross only the
127.0.0.1 loopback relay (same machine, same OS user) and are redacted at the host — the
actual exfiltration boundary to the model — for `observation`, `observation_delta`, and
`observation_text` kinds. Screenshot protection is unchanged and remains in the
extension (sensitive-zone masking before capture, non-inline bytes dropped pre-relay),
because image pixels cannot be un-leaked once transmitted. Redaction is guarded to the
three observation kinds so finalize acknowledgements and other control results pass
through unchanged.

## 20. Batch fill_form via host-side expansion (WS9.8, 2026-07-10)

`fill_form` lets one MCP call fill an ordered `fields` array. It is expanded host-side
into sequential single `fill` dispatches, each receiving the full existing per-field
floor (host hints plus driver-resolved facts) and the same value redaction as any fill.
The batch stops at the first blocked or failed field and returns a per-field summary
with `stoppedAt`; a sensitive field (credential/OTP/payment/government-id) halts the
batch *before* that field is dispatched, so no keystrokes reach it — identical safety to
a standalone fill. Host expansion (rather than a driver batch command) was chosen so the
security-critical floor path is reused unchanged and the whole feature is deterministically
testable; the saving is one MCP round-trip per form, not per relay hop. `fields` values
are redacted to `[REDACTED]` in action artifacts.

## 21. Read-only console and network inspection (WS9.2 / WS9.3, 2026-07-10)

Two read-only tools expose per-session diagnostics the driver buffers from CDP:

- `browser.console` returns buffered `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`,
  and `Log.entryAdded` output as a bounded ring buffer (500 entries), filterable by level
  and pattern, with an optional `clear`. Only rendered text, level, and source are kept —
  never raw argument objects — and text passes the observation-text redaction.
- `browser.network` returns buffered request metadata (method, URL, status, resource type,
  encoded size) as a 500-entry ring. Request/response **headers are never buffered or
  returned**, because they carry cookies and authorization tokens. Passing `requestId`
  fetches one response body via `Network.getResponseBody`, but only when that request's
  URL origin is within the session's `allowedOrigins`; a cross-origin body is refused with
  `origin_not_granted` and is never even fetched. Bodies are capped and text bodies pass
  the card/SSN masking pass.

Both are `read_only` at the floor. The buffers live on the driver and populate from the
existing debugger event stream (the `Log` domain is now enabled alongside Network/Runtime).

## 22. Screenshot region and JPEG encoding (WS10.2 / WS10.3, 2026-07-10)

`browser.screenshot` gains a `region: {x,y,width,height}` option that maps to the
existing, tested CDP clip path so a caller can capture just the area it needs (smaller
payload, less masking surface), and `format:"jpeg"` with `quality` (default 70, PNG
remains default) for a token-grade capture that is typically several times smaller than
PNG for the model. The host image/file/inline delivery, size caps, and sensitive-zone
masking are unchanged; the delivery path now carries the correct `image/png` or
`image/jpeg` mime and file extension. The observation token budget (WS10.1) and cold-start
p95 targets (WS10.4) are measurement tasks deferred to live runs, since they require real
pages and timing rather than deterministic fixtures.

## 23. Multi-tab sessions deferred to live iteration (WS9.5, 2026-07-10)

Multi-tab sessions — tracking pages a session's owned tab opens (window.open,
target=_blank), origin-gating popups, and addressing child tabs from
observe/act/screenshot — are deferred past 0.4.0. The current model binds one attached
tab per session throughout the driver, controller, floor, and finalize paths; extending
it to route commands across multiple concurrent CDP targets is an architectural change
whose correctness (target attach ordering, popup lifecycle, per-tab origin reconciliation)
can only be validated against a real browser. Rather than destabilize the single-tab core
that the rest of 0.4.0 depends on with an un-live-testable rewrite, WS9.5 is scheduled as
a focused, live-verified effort. The `newTarget` reconciliation signal already halts an
agentic action when a popup appears, so today a new tab is surfaced (not silently
ignored); it simply is not yet independently drivable. Tracked in `ROADMAP.md`.

## 24. Incognito owned-tab sessions (2026-07-11)

`browser.session.start` accepts `incognito: true` (owned-group tab mode only; ignored
for current-tab). The owned tab is created in an incognito window — an existing one is
reused, otherwise a fresh incognito window is opened — so the driven tab never touches
the user's authenticated profile cookies or storage. This is the privacy-preserving way
to drive popular sites without the user's logged-in state (e.g. for screenshots or
untrusted browsing). It requires the extension to be allowed in incognito
(chrome://extensions → Newton → Details → Allow in incognito); when it is not, tab
creation fails with a typed `incognito_not_allowed` so the caller can tell the user
exactly what to enable. Debugger attach, the safety floor, origin scoping, and redaction
are unchanged in incognito.

## 25. Remaining 0.4 convenience surfaces deferred (2026-07-11)

The 0.4 release ships the proven primitives and defers three convenience surfaces:

- element-target screenshot capture; callers use a fresh observation plus an explicit
  `region` crop;
- duplicating `pendingDialog` into `browser.status`; the authoritative dialog state
  remains on full/diff observations for the target session;
- the `browser.session.start` `viewport` convenience option; callers use the owned-tab
  `resize` action immediately after session start.

These deferrals do not weaken origin scoping, redaction, the action floor, or dialog
control. They are recorded in `ROADMAP.md` for post-0.4 consideration. Owner approval to
defer all three was recorded on 2026-07-11 so the release scope remains stable.

## 26. Per-session ordering, fencing, and retry truth (2026-08-09)

Commands are serialized independently per browser session. One session therefore has at
most one running command, while separate sessions remain concurrent. Every relay command
and terminal result carries a host-owned session epoch and monotonic sequence. A stale
owner, epoch, or sequence cannot settle current work, and finalization establishes a
closing barrier before cleanup begins.

Mutation callers may provide an 8-128 character URL-safe `idempotencyKey`. The host hashes
the normalized action, joins an identical in-flight call, replays its bounded terminal
result for ten minutes, and rejects reuse with a different action as
`idempotency_conflict`. `fill_form` derives a stable private key per field so a replay does
not repeat fields already represented by the same request.

Retry advice is based on execution state, not transport success: queued work that was
never sent is `not_started` and retry-safe; a pre-dispatch refusal is `prevented` and
retry-safe; a terminal controller response is `completed` and not automatically retried;
sent work without a terminal response is `outcome_unknown` and not automatically retried.
Late results are matched only to their exact command generation and cannot overwrite a
newer idempotency entry.

## 27. Centralized input and event-driven renderer recovery (2026-08-09)

All CDP keyboard, pointer, and wheel events route through one per-session dispatcher.
Printable text uses `Input.insertText`; named keys and chords use complete virtual-key,
code, modifier, raw-down, optional-char, and key-up descriptors. The dispatcher owns
pressed button/modifier state and performs balanced cleanup. If cleanup fails after an
effect may have been released, the host reports `outcome_unknown` rather than suggesting
an automatic retry.

JavaScript dialogs are scoped by flattened CDP session and subscribed before input is
released. A dialog in another frame cannot settle or block the current target's input,
and dialog handling waits for the dispatcher's observable idle transition before the
next command. Renderer state is explicit (`healthy`, `dialog_blocked`, `discarded`,
`debugger_detached`, `target_gone`, `unresponsive`, `reconciling`, `terminal`). Debugger
reattachment is triggered by detach/tab lifecycle events with a strict attempt bound;
there is no delay loop, and current-tab recovery never focuses, reloads, or navigates the
user's tab. Owned tabs are marked non-discardable, while a real discard remains a typed
failure rather than an automatic reload.

Completion settling uses document mutation/input revision plus network-quiet state. It
does not use URL and element counts as a proxy, so text/value-only changes are visible.
Invalid selectors are validated before dispatch and remain `invalid_selector` through
the controller. A failed click hit test returns bounded blocker evidence and never falls
back to blind coordinates.

## 28. Compact agent output with full internal evidence (2026-08-09)

The MCP boundary now projects the full, redacted driver observation into a compact
geometry-free form by default. Agents can bound work with `query`, `roles`, and `limit`;
lean JSON and geometry remain explicit diagnostic options. Truncation is deterministic
and returns a typed continuation. The internal AX/target model is not reduced: checked,
selected, expanded, disabled, required, heading level, value, sanitized same-origin
links, element type, document epoch, and frame provenance survive redaction and either
renderer. Optional interactive discovery uses bounded CDP DOM reads and isolated
read-only element facts; it never writes discovery attributes into the page.

Action calls use one host-normalized outcome envelope instead of repeating status,
decision, origin, and observation data. Host-owned `outcome`, retry safety, session
epoch, and sequence remain public. `browser.session.start` can include the initial
observation, and `browser.status` is compact unless `detail: "full"` is requested.

Cost gates serialize the actual public envelope and use the pinned development-only
`js-tiktoken@1.0.21` `o200k_base` encoding. No tokenizer, provider call, telemetry, or
adaptive model logic exists in the runtime. The checked-in representative fixture must
remain within the Plan 06 catalog, compact/JSON observation, action, and workflow token
budgets on Windows and Linux.

## 29. Versioned compact MCP contract and opaque-body refusal (2026-08-09)

The MCP contract is versioned independently as `1.0`. Initialization and full status
publish that version, initialization warns that page-derived content is untrusted, and
every public tool carries reviewed read-only, destructive, idempotent, and open-world
hints. Public observations, console records, network records, and page-derived action
deltas inherit host-authored provenance bound to their origin and session epoch. Driver
or page fields cannot forge a decision, next action, warning, or trust label.

Action validation is generated from one exact per-kind field table and runs before relay
dispatch. The public schema carries that table in compact `x-newtonVariants`,
`x-newtonRequired`, and `x-newtonTargetRequired` metadata while standard JSON Schema
retains the union field types, ref pattern, enum constraints, and unknown-field ban. A
fully expanded 23-way `oneOf` made the measured catalog 5,287 tokens and was rejected;
the compact generated form keeps the complete catalog plus server instructions at 2,818
`o200k_base` tokens while the host remains the authoritative strict validator.

Only granted-origin, supported textual response bodies may cross the MCP boundary, and
they still pass secret/card/identifier redaction. Base64, binary MIME, malformed UTF-8,
compressed, and otherwise opaque bodies are omitted. Their bounded metadata may include
MIME type, declared encoding, byte count, and SHA-256, never raw bytes. Screenshot
results always state `mask_applied`, `mask_not_configured`, or `mask_not_applicable`; a
configured mask failure prevents capture instead of returning unmasked bytes.

## 30. Strict TypeScript control path with deterministic JavaScript output (2026-08-09)

The critical browser-side control path is now strict TypeScript: driver, controller,
Chrome tabs adapter, session command pump and transaction, target registry, origin
containment, input dispatcher, and renderer liveness. The package enables `strict`,
`noImplicitOverride`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` and
imports public browser action types from `@newton-browser/core`. Raw CDP variability is
isolated to one documented adapter record; the rest of the control path uses narrowed
internal types. This captures the relevant compile-time advantage without a Rust
rewrite, native executable, daemon, or architecture change.

`scripts/build-driver.mjs` invokes the pinned workspace TypeScript compiler, emits the
existing JavaScript filenames, removes the empty declaration-only `types.js`, and copies
the overlay JavaScript/CSS separately. The extension builder consumes only this compiled
output. Driver tests also import compiled output, so source-only success cannot hide a
broken package graph. A two-clean-build regression compares the exact production
allowlist, SHA-256, and bytes and rejects TypeScript, source maps, tests, fixtures, and
absolute workspace paths. An intentionally incomplete action switch must fail strict
typechecking, while the production action switch is exhaustive and retains the prior
runtime fallback for invalid unvalidated JavaScript callers.

## 31. Provider-free regression tasks and bounded local diagnostics (2026-08-09)

Newton's regression evals execute declared fixture steps through a supplied deterministic
runner. They do not call an LLM, model provider, hosted service, or telemetry endpoint.
Each run receives isolated home, config, cache, browser-profile, download, and output
roots under a validated temporary parent; recorded local writes must stay below that root,
and cleanup refuses any path that is not an owned `newton-browser-eval-*` child.

Full status and authenticated doctor output may expose operational facts needed to debug
the command system: session epoch/sequence, queue depth/bytes, running command identifier,
oldest queued age, lifecycle state, bounded p50/p95/max queue-wait and execution samples,
outcome counts, and fixed MCP framing limits. Samples retain only the latest 256 numeric
values in memory. Compact agent status remains unchanged. These diagnostics never include
page text, response bodies, cookies, storage, browser profile files, saved credentials, or
real-user browsing history.
