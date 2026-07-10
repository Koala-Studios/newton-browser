# Browser Bridge

Browser Bridge lets an MCP client control isolated tabs in an existing authenticated Chrome or Edge profile through a local MV3 extension and an auto-started stdio MCP server.

The default setup is zero-touch local trust: load the extension, add the MCP config, and start the client. An opt-in HMAC pairing mode is available for a stricter local boundary.

Chrome and Edge may stay enabled simultaneously. Each session is atomically owned by one browser while the other remains a non-controlling standby; an optional browser target selects Chrome or Edge without extension toggling.

This repository is private/local during the 0.1.0 hardening cycle. No public license, remote, npm publication, or browser-store submission is implied.

## Provenance

The initial runtime is extracted from source commit `56e65944b3b6e4233a634fa3e7781ee449eb51cb`. That hash records provenance only; this repository must build and operate with its extraction source unavailable.

The authoritative contract locks are in [docs/DECISIONS.md](docs/DECISIONS.md).

## Commands

Use `pnpm release:check` for the complete private release gate. Installation, MCP client examples, security posture, troubleshooting, and release evidence are documented under `docs/`; deterministic browser fixtures live under `test/fixtures/`.
