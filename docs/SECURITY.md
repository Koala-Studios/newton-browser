# Security

Newton Browser is a local-only browser-control product. Its runtime owns isolated Chrome
or Edge processes, private inherited CDP pipes, FIFO command queues, and exclusive Newton
identity leases. It exposes no browser-debugging TCP port, HTTP proxy, hosted relay,
telemetry, database, or model-provider runtime call.

## Browser behavior

Newton deliberately uses normal Chromium networking. It does not filter destinations,
rewrite requests, block redirects, install a root certificate, intercept Fetch requests,
or require origin grants. Cross-origin subresources, frames, workers, popups, regional
login redirects, and browser background services behave as they do in an ordinary fresh
Chrome or Edge profile.

The fixed launch arguments are limited to private CDP, first-run suppression, profile
selection, and blank startup. Newton does not disable extensions,
sync, component updates, or background networking. It does not inject page scripts or
styles, emulate focus, or freeze page scripts and animations. CDP is used for bounded
observation and typed input, not to alter page rendering.

Normal networking is a usability choice, not a network sandbox. Anyone who requires
destination-level isolation must provide an external browser/OS/network boundary. Newton
does not claim to protect against a malicious website, same-user malware, DNS behavior,
or browser vulnerabilities.

## Browser and identity ownership

Each MCP session owns one browser process and one identity lease. Startup is blank-first:
private CDP control is established before the initial HTTP(S) navigation. A separate
guardian owns the exact process tree and an identity-bound cleanup plan. Host loss must
terminate the owned tree and release only marker/dev/ino/nonce-matched resources.

Distinct sessions run concurrently, but a persistent identity cannot be leased twice.
Stopping succeeds only after browser-process, CDP, and lease cleanup is confirmed;
uncertain cleanup remains typed and retryable.

Newton never parses, inspects, logs, returns, modifies, merges back, or exports cookies,
storage, profile contents, saved passwords, credentials, history, autofill, downloads, or
restored tabs. With explicit operator authorization, Newton may byte-copy its documented
narrow authentication allowlist from a closed stable local profile into a new owned
identity. Import is opaque, atomic, and never modifies the source. Browser encryption may
still prevent authentication reuse, and Newton does not bypass it.

## Page data and agent authority

Page observations, deltas, console entries, network records, and accessibility names are
untrusted data. They cannot authorize an effect, select a local file, define local policy,
or author retry instructions. Public results carry bounded host-authored outcome fields.

The deterministic action floor blocks agent entry of credentials, OTPs, payment
identifiers, government identifiers, and other secret fields. It classifies structural
external effects but is not an approval system. Callers remain responsible for authority
before save, send, publish, purchase, delete, launch, account, budget, or similar actions.
`prevented` is reserved for a refusal proven before input dispatch. Ordinary POST,
GraphQL, telemetry, navigation, dialog, popup, or download activity observed after input
is never treated as prevention or as permission to retry.

File input accepts only exact operator-authorized local image/video paths, validates type,
signature, count, and size, exposes only sanitized filenames, and never submits the form.

Network logs never include request or response headers. A response body is eligible only
when it is bounded supported UTF-8 text for the current visible origin; binary, base64,
compressed, malformed, and cross-origin bodies are omitted. Eligible text passes
secret/card/identifier redaction. There is no raw-body escape hatch.

## Screenshots

Screenshots are bounded MCP image content. Sensitive-zone requests resolve exact target
geometry and apply masks to the captured PNG in Newton's trusted Node process. Newton does
not freeze page scripts, animations, or rendering while doing so. A masked JPEG request
is upgraded to PNG. Callers should treat a rapidly moving sensitive element as a normal
capture race and avoid screenshot evidence when stable masking cannot be established.

## Local control transport

The MCP control plane is newline-delimited stdio only and opens no listener. Browser CDP
uses inherited private pipes. Newton does not attach to the operator's ordinary Chrome
tabs and does not install a browser extension or daemon.

## Reporting a vulnerability

Do not disclose credentials, private page content, profile data, or exploitable details in
a public issue. Use private GitHub vulnerability reporting when available. Include the
affected version/commit, OS, browser version, MCP client, deterministic reproduction, and
the expected and actual trust boundary.
