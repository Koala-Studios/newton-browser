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

- `newton-browser-0.3.0.tgz`
- `newton-browser-extension-0.3.0.zip`
- `newton-browser-extension-0.3.0.zip.sha256`

The repository is public as of 2026-07-10. The owner explicitly approved the MIT License on 2026-07-10 and confirmed the copyright holder as `Koala Studios`; the repository's `LICENSE` is therefore `Copyright (c) 2026 Koala Studios`. npm publication and browser-store submission remain separate approval gates.

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

## 13. npm packaging, runtime Node floor, and `--install` (2026-07-10)

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

## 14. Readable-text observations, and no arbitrary JavaScript (2026-07-10)

### `browser.observe` text mode (WS9.1)

`browser.observe` accepts `mode: "text"` with an optional `maxChars` (200–200,000, default 20,000). It returns `{ kind: "observation_text", origin, title, text, chars, truncated }` where `text` is the page's main/article content (falling back to `document.body.innerText`). This is the cheap "read the prose" primitive; a full accessibility snapshot is unnecessary when the caller only needs to read, not target.

The raw text crosses the loopback relay and is redacted host-side by `redactBrowserResult` before it reaches the client — the same trust boundary as accessible names in a normal observation. Redaction runs the standard secret/PII pass plus bare card- and SSN-like masking, then bounds the result at a hard 200,000-character cap independent of the requested `maxChars`. The mode is read-only (`decision.class: "read_only"`); it dispatches no input and mutates nothing.

### No arbitrary JavaScript evaluation tool (WS9.7)

Newton Browser will not expose a general JavaScript-evaluation or expression tool. Every mutation must route through a typed action so the safety floor's classification (`read_only`/`agentic`/`approval_required`/`blocked`, and the commit boundary) is sound. An eval tool would let a caller perform navigation, form submission, network writes, and DOM mutation without any of that classification, converting the floor from a guarantee into a suggestion. This is a deliberate capability gap, not an oversight. It may be revisited only as a sandboxed, provably read-only expression evaluator with its own contract; unrestricted evaluation is out of scope permanently.

## 15. JavaScript dialog accept/dismiss (WS9.4, 2026-07-10)

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
