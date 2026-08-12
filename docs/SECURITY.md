# Security

Newton Browser is local-only, origin-scoped, and local-user trusted. Its primary runtime
owns isolated Chrome or Edge processes, a private inherited CDP pipe, a per-session policy
proxy, and a Newton identity lease. It exposes no default browser-debugging port and has no
hosted relay, telemetry, database, or model-provider runtime call.

## Trust boundary

Every session requires one normalized HTTP(S) origin and explicit additional exact origins.
Grants compare scheme, ASCII host, and effective port; page text, redirects, same-site
relationships, DNS results, and URL suffixes cannot widen them.

The policy proxy is ready before Chromium starts. It decides HTTP absolute-form requests,
HTTPS CONNECT authorities, and WebSocket destinations before opening an upstream socket.
No resource-type exception widens the grant: images, styles, fonts, media, manifests, and
other subresources require the same explicit exact-origin grant as application requests.
CONNECT exposes only an authority, so third-party HTTPS origins must be explicit grants;
Newton does not infer passive image/font/style access through an opaque TLS tunnel.
Denied navigation, popup, frame, worker, form, fetch, beacon, redirect, EventSource, and
connection attempts therefore reach the destination application zero times in the tested
scope. Browser-level Target/Fetch interception is a second boundary, not the only one.
Proxy, browser, CDP, or cleanup uncertainty fences the session. Proxy counters are
aggregate diagnostics only. They are never
temporally assigned to an agent command; truthful `prevented` outcomes require causal
Target/Fetch evidence tied to that command or controlled target.

This does not claim operating-system firewalling, protection from same-user malware,
control of another process, WebRTC/UDP filtering outside the documented proxy/CDP path,
or containment of traffic Chromium does not send through the configured proxy.

## Browser and identity ownership

Each direct session owns one browser process and one identity lease. Startup is blank-first:
the proxy and CDP controls are established before the initial granted navigation. Owned
browsers run with browser extensions disabled, and imported extension data is excluded.
Distinct sessions run concurrently, but the same persistent identity cannot be leased twice.
The browser is spawned by a separate guardian that owns the exact process tree and an
identity-bound cleanup plan. MCP-host loss triggers browser-tree termination and releases
only the marker/dev/ino/nonce-matched lease or ephemeral identity. Stopping succeeds only
after process, proxy, CDP, and lease cleanup is confirmed; uncertain
cleanup remains typed and retryable rather than being discarded.

Newton never parses, inspects, logs, returns, modifies, merges back, or exports cookies,
storage, profile contents, saved passwords, credentials, history, autofill, downloads, or
restored tabs.

With explicit operator authorization, Newton may byte-copy a narrow documented allowlist
of authentication-bearing files from a closed local profile into a new Newton-owned
identity. Import treats every file as opaque. It excludes password, autofill, history,
download, extension, session, service-worker, and cache data; rejects unproved browser
closure, user-data ownership indicators, hardlinks, symlinks, path escapes, case
collisions, family mismatch, instability, and partial copies;
and publishes only an atomic verified staging tree. Failure is closed and the source is
never modified. Imported identities are machine-local, not portable backups. Import is
not an authentication-preservation guarantee: current Windows Chrome App-Bound Encryption
may make protected standard-profile data undecryptable from Newton's isolated
`--user-data-dir`, and Newton does not bypass that browser security boundary.

## Page data and agent authority

Page observations, deltas, console entries, network records, and accessibility names are
untrusted data. They cannot authorize an effect, add an origin, select a local file, define
configuration, or author retry/next-action instructions. Public results carry bounded
host-authored provenance and outcome fields; callers must use those outer fields rather
than page-derived prose.

The deterministic action floor blocks credentials, OTPs, payment identifiers, government
identifiers, disallowed origins, and cross-origin targets. It is not an approval system.
Callers remain responsible for authorization before save, send, publish, purchase, delete,
launch, account, budget, or other external-effect actions.

File input accepts only exact operator-authorized local image/video paths, validates type,
signature, count, and size before setting any file, exposes only sanitized filenames, and
never submits the form.

Network bodies are eligible only when they are bounded granted-origin UTF-8 text. Binary,
base64, compressed, malformed, unsupported, and ungranted bodies are omitted. Eligible text
passes secret/card/identifier redaction. There is no generic raw-body escape hatch.

## Screenshots

Every screenshot reports an explicit masking disposition. Sensitive-zone capture resolves
exact target/frame geometry, freezes page scripts and animations through CDP, captures a
bounded lossless PNG, masks those pixels in the trusted Node process, and resumes the page.
Any resolution, freeze, geometry, decode, masking, or resume uncertainty fails closed. A
masked JPEG request is safely upgraded to PNG; no unmasked fallback is returned.

## Dialogs and lifecycle

JavaScript dialogs are target-scoped and handled only through typed accept/dismiss actions.
Accepting a dialog that confirms an external effect still requires caller authorization.

Direct mode supports close finalization only. It does not attach to the user's current tab,
activate or hand off a user tab, or use incognito as a substitute for an isolated identity.
Unexpected browser/proxy/CDP loss revokes readiness and initiates owned cleanup. Same-session
commands are FIFO; independent sessions remain concurrent.

## Local control transport

Ordinary stdio mode opens no control listener. Explicit continuity mode uses only an
operator-selected local Unix socket. Browser CDP remains on inherited private pipes.

An optional deployment observer is disabled by default. When explicitly configured, it
uses a high-entropy token, mode-0600 local registry records, loopback-only endpoints, and
bounded session metadata. It never exposes page content, origin grants,
profile contents, or ownership secrets.

## Reporting a vulnerability

Do not disclose credentials, sensitive page content, profile data, or
exploitable vulnerability details in a public issue. Use private GitHub vulnerability
reporting when available; otherwise request a private contact channel without exploit
details. Include the affected commit/version, OS, browser version, MCP client,
deterministic reproduction, expected and actual result, and the trust boundary involved.
