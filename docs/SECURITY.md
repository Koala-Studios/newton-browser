# Security

The binding security and trust model is locked in [DECISIONS.md](DECISIONS.md). Browser Bridge is loopback-only, pairing-authenticated, origin-scoped, and local-user trusted. It does not inspect cookies, storage, profile files, saved passwords, or authentication tokens.

## Trust boundary

Each stdio host binds one free address in `127.0.0.1:17321-17340`. The extension accepts only loopback hosts and authenticates every socket with a challenge-response proof derived from the per-user 256-bit pairing secret. The secret is never emitted by normal MCP mode. This prevents an unpaired webpage or ordinary local process from issuing bridge commands; it does not defend against malware already running as the same OS user.

Every session has a required exact HTTP(S) origin grant. The extension reconciles the attached tab's live origin before binding and before every command. Moving focus cannot retarget a session, and one host cannot address another host's session. Page text is untrusted data and never authorization.

## Action floor

The deterministic floor blocks credentials, OTPs, payment identifiers, government identifiers, disallowed origins, and cross-origin targets. It reports a decision class and commit boundary but is not an approval system. Callers remain responsible for authorization before save, send, publish, purchase, delete, budget, account, or other external-effect actions.

File input actions accept only exact local image/video paths, validate signatures and size/count caps before setting any file, expose only sanitized filenames, and never click submit. Screenshot sensitive zones are masked in the extension before bytes cross the relay. JavaScript dialog control is unsupported and returns a typed error.

## Lifecycle

Owned tabs start inactive. Finalize `close` closes only an owned tab; `deliverable` retains a passive review tab; `handoff` ungroups and activates it. Current-tab sessions never close the operator's tab. If a host disappears, only its unfinalized sessions are cleaned after the grace period; finalized tabs and other hosts remain unaffected.
