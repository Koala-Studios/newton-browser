# Browser Bridge 0.1 Contract Decisions

Status: locked for implementation on 2026-07-10. Changes require an explicit decision entry and matching contract tests.

## 1. Multi-host mechanism: bounded port-range discovery

Chosen: Option A, bounded port-range discovery on `127.0.0.1:17321-17340`.

Option A keeps every stdio MCP process independent: a host binds the first free port, the extension maintains one authenticated socket per discovered host, and routing uses the tuple `hostInstanceId + sessionId`. Losing one host cannot make another host's sessions depend on leader election. Option B would keep one extension socket but turns the first short-lived client process into an incumbent broker and requires proxying, successor election, and crash-safe handoff. That lifecycle is materially more complex and creates a hidden daemon-like responsibility inside an ordinary client process.

Discovery is bounded to 20 loopback ports. A host that cannot bind within the range returns typed `host_collision`; it never exits from an unhandled `EADDRINUSE`. The popup reports only connected host and session counts.

## 2. Transport authentication: zero-touch local trust with opt-in pairing

Revised by explicit user decision on 2026-07-10: `local_trust` is the default. Installing the extension and configuring the MCP package is sufficient; no key paste or popup action is required. Every host still binds only to `127.0.0.1`, accepts only Chromium extension WebSocket origins, keeps the bounded port range, and applies all session-origin and action-floor controls.

The optional hardened mode is enabled with `{"transportAuth":"paired"}` in the per-user `config.json`, or `BROWSER_BRIDGE_AUTH_MODE=paired`. In that mode the MCP package creates/reads a random 256-bit base64url secret in the per-user config directory, `--doctor` prints it for deliberate one-time entry in the extension popup, and the extension stores it in `chrome.storage.local`. Normal MCP mode never emits it.

Hardened mode sends `{type:"auth_challenge",protocol:"browser-bridge-auth-v1",hostInstanceId,nonce}`. The extension answers with `{type:"auth_response",hostInstanceId,proof}` where `proof = base64url(HMAC-SHA-256(secret, "browser-bridge-auth-v1:" + hostInstanceId + ":" + nonce))`. Until verification, that socket may send no bridge requests and is closed after 3 seconds. Nonces are random, single-use, and process-local; comparison is constant-time.

Tradeoff: local trust allows another process running as the same OS user to imitate an extension-origin client on loopback. Pairing raises that bar for ordinary local processes, but it does not defend against same-user malware able to read the config file or extension storage. Native Messaging could provide a stronger OS registration boundary but would require a platform installer, contrary to the zero-touch artifact goal for 0.1.0.

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
- `file`: the host decodes the PNG and writes it only inside the caller-designated absolute output directory. It returns `{delivery:"file",path,filename,bytes,sha256,width,height,fullPage,truncated}`. The default filename is `browser-bridge-<UTC timestamp>.png`; caller names are sanitized to a basename.
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

`decision` is the strongest of the host preflight and extension pre-dispatch decisions. The caller may raise risk but never lower it. Browser Bridge exposes classification; it is not an approval system.

## 5. Mandatory session origin

`browser.session.start` requires `origin`. It must parse as HTTP(S) and is stored as normalized `URL.origin`. `allowedOrigins` defaults to `[origin]`; every entry must independently parse as an exact normalized HTTP(S) origin. Wildcards, paths, credentials, fragments, and origin-less sessions are rejected with typed `invalid_origin` or `origin_required`.

The tool does not return success until the extension has created/selected the tab, attached the debugger, and reported the tab's live origin. A current-tab session is denied unless the live tab origin is in the grant. Observe and act re-check the live origin for every command, so focus changes cannot move a session outside its grant.

## 6. Host-policy manifests remain and are active

Chosen: wire the machinery.

Browser Bridge ships without vendor-specific host-policy manifests. An optional per-user `config.json` may define `hostPolicies`; the schema is validated at startup and by `--doctor`. The host selects a matching manifest from the command's reconciled live origin and passes it into both preflight and extension-side floor evaluation. Screenshot `sensitiveZones` from a selected manifest are passed into capture. The generic structural safety floor remains active when no manifest matches. Invalid configuration produces typed `invalid_config`; inert manifests are forbidden by tests.

## 7. New lifecycle contracts

### `browser.status`

Input: `{}`. Result:

```json
{
  "ready": true,
  "version": "0.1.0",
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
- `handoff`: detach, remove overlay and Browser Bridge group ownership, activate the tab, then end the session.

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

- `@browser-bridge/core`
- `@browser-bridge/driver`
- `@browser-bridge/extension`
- `browser-bridge-mcp` with executable `browser-bridge-mcp`

Public package exports point to compiled JavaScript under `dist/`; no package bin or export points at TypeScript. Release artifact names are:

- `browser-bridge-mcp-0.1.0.tgz`
- `browser-bridge-extension-0.1.0.zip`
- `browser-bridge-extension-0.1.0.zip.sha256`

The repository is public as of 2026-07-10. npm publication, browser-store submission, and adding a license remain separate approval gates; no license file is added until the public-license posture is explicitly approved.

## 10. Boundary and stale concepts

Runtime source, package metadata, scripts, fixtures, docs, and artifacts must not import, name, or reference the source product/repository, its services, or its private shared files. The boundary check also rejects retired concepts: the old non-local transport enum, database host-policy table comments, raw TypeScript package bins, cross-package relative source escapes, and the former private shared module.

The provenance hash in the evidence history is non-runtime provenance and is the only temporary source-reference exception from extraction; release artifacts contain no such reference.

## 11. Simultaneous-browser arbitration

Chrome and Edge may keep the same unpacked extension enabled at the same time. Every browser profile persists a random local client identity and announces only that identity plus its browser family to each loopback host. For every session, the host performs one atomic claim: exactly one eligible extension becomes owner, while every other extension remains connected as standby.

Only the owner may attach a tab, subscribe, stop the session, or return command results. Commands are sent only to that owner's socket. A non-owner receives typed `session_not_owned` and cannot race or duplicate an action. If the owner disconnects, the host releases the claim, clears browser-specific tab identifiers, and lets one standby reclaim and bind a fresh tab; an in-flight command fails closed as `extension_disconnected` rather than being replayed.

The default `browserTarget` is `auto`, so installation remains zero-touch and the first atomic claimant owns each new session. A user who wants deterministic browser selection may set `{"browserTarget":"chrome"}` or `{"browserTarget":"edge"}` in the per-user `config.json`, or set `BROWSER_BRIDGE_BROWSER=chrome|edge` for that MCP process. Non-selected browsers stay connected as standby and never receive session control. `browser.status` reports the target, connected browser families, eligible-client count, and aggregate claimed-session counts without exposing profile identity values.
