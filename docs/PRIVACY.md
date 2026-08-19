# Newton Browser Privacy

_Last updated: 2026-08-11_

Newton Browser is a local developer tool. Its direct runtime launches isolated Chrome or
Edge processes and controls them from a local stdio MCP host through inherited private CDP
pipes. It has no Newton cloud backend, account service, telemetry, analytics, crash-report
service, remote relay, or database.

## Data Newton does not inspect

Newton does not parse, enumerate, log, return, export, or merge browser cookies, storage,
saved passwords, autofill, history, downloads, bookmarks, profile contents, or restored
tabs. It controls only its owned session processes.

With explicit operator authorization, the identity importer may copy a narrow documented
set of authentication-bearing files from a closed stable profile. The files remain opaque
bytes. Password, autofill, history, download, extension, session, service-worker, and cache
data is excluded. Closure is proven from the browser-family process table and source
stability rather than the presence of persistent database files named `LOCK`. The source
is never modified.

Opaque import does not guarantee a usable authenticated session. Browser and operating-
system protection can bind encrypted data to its original profile location; notably,
current Windows Chrome App-Bound Encryption may reject standard-profile data when the copy
is launched from Newton's isolated user-data directory. Newton neither bypasses that
protection nor treats authentication preservation as release evidence.

## Data handled during a session

- **Observations and page text:** bounded accessible structure or text is returned to the
  configured MCP client with untrusted-page provenance and host-side redaction.
- **Screenshots:** captured only on request and returned as bounded MCP image content.
  Sensitive zones are masked in trusted post-capture PNG pixels;
  uncertainty fails closed rather than returning an unmasked image.
- **Console and network evidence:** bounded and redacted. Request headers are never
  returned. Bodies are eligible only for supported bounded UTF-8 text from the current
  visible origin; binary, base64, compressed, malformed, and cross-origin bodies are omitted.
- **Identity metadata:** opaque identity ID, browser family, creation time, lease state,
  and bounded lifecycle receipts. Source paths and profile contents are not public output.
- **Local configuration:** selected browser family and opaque identity ID
  are stored in the per-user Newton Browser configuration directory.

Whether page observations or screenshots leave the computer depends on the MCP client and
model provider chosen by the user. Newton Browser itself does not send them elsewhere.

## Network and process isolation

Browser control uses inherited pipes and no browser debug TCP port is opened. Website
traffic uses Chromium's ordinary network stack. Newton does not proxy, block, rewrite, or
log destination traffic, so sites can load their normal redirects and dependencies.

A separate local guardian receives only browser launch arguments plus bounded filesystem
ownership facts. It never receives page content or parsed profile data. Its only purpose
is to terminate the owned browser tree and release the exact lease/ephemeral identity if
the MCP host disappears.

## Contact

Open a minimal issue at <https://github.com/Koala-Studios/newton-browser/issues> without
secrets or private page content. For security reports, follow
[`SECURITY.md`](SECURITY.md).
