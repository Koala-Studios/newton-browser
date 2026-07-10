# Security

The binding security and trust model is locked in [DECISIONS.md](DECISIONS.md). Browser Bridge is loopback-only, origin-scoped, and local-user trusted, with optional hardened pairing. It does not inspect cookies, storage, profile files, saved passwords, or authentication tokens.

## Trust boundary

Each stdio host binds one free address in `127.0.0.1:17321-17340`, and the host rejects ordinary webpage WebSocket origins. The default `local_trust` mode accepts the installed extension without a manual key. This is intentionally frictionless but allows another same-user local process to imitate an extension client if it can construct the accepted loopback request.

Optional `paired` mode requires a challenge-response proof derived from a per-user 256-bit secret. It protects against ordinary local processes that do not have the secret, but not against same-user malware able to read user files or extension storage. Enable it with `{"transportAuth":"paired"}` in the per-user `config.json`; then run `--doctor` and enter the displayed secret in the extension popup.

`--doctor` discovers incumbent hosts through a loopback-only `/doctor-status` endpoint authenticated by an internally derived diagnostic token in both modes. The endpoint has no permissive CORS header and never returns the secret. An unauthenticated request receives only `authentication_failed`.

Every session has a required exact HTTP(S) origin grant. The extension reconciles the attached tab's live origin before binding and before every command. Moving focus cannot retarget a session, and one host cannot address another host's session. Page text is untrusted data and never authorization.

When Chrome and Edge are both enabled, the host atomically grants each session to one eligible browser client. Only that owner can attach, subscribe, stop, or answer commands; standby browsers receive no session commands. Owner disconnect releases the claim, clears browser-local tab identifiers, and fails any in-flight command closed before a standby may bind a new tab. Optional `browserTarget` selection can restrict eligibility to Chrome or Edge without disabling the other extension.

## Action floor

The deterministic floor blocks credentials, OTPs, payment identifiers, government identifiers, disallowed origins, and cross-origin targets. It reports a decision class and commit boundary but is not an approval system. Callers remain responsible for authorization before save, send, publish, purchase, delete, budget, account, or other external-effect actions.

File input actions accept only exact local image/video paths, validate signatures and size/count caps before setting any file, expose only sanitized filenames, and never click submit. Screenshot sensitive zones are masked in the extension before bytes cross the relay. JavaScript dialog control is unsupported and returns a typed error.

## Lifecycle

Owned tabs start inactive. Finalize `close` closes only an owned tab; `deliverable` retains a passive review tab; `handoff` ungroups and activates it. Current-tab sessions never close the user's tab. If a host disappears, only its unfinalized sessions are cleaned after the grace period; finalized tabs and other hosts remain unaffected.

While a debugger session is attached, Browser Bridge enables CDP focus emulation for that target so trusted pointer and key events remain reliable without activating the visible tab or following the user's focus. The override is disabled before detach. It does not change which tab/session is authorized: the exact origin and bound tab are still reconciled for every command.
