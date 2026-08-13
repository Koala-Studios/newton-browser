# Contributing to Newton Browser

Thanks for helping improve Newton Browser. Contributions should preserve its local-only architecture, explicit origin grants, and deterministic safety behavior.

## Before opening an issue

- Search existing issues and troubleshooting guidance.
- Use the provided bug or feature template.
- Remove credentials, sensitive page content, screenshots, and private filesystem paths.
- Report security issues privately using [docs/SECURITY.md](docs/SECURITY.md).

## Development setup

Requirements:

- Node.js 24 or newer
- pnpm 10.8.0
- Chrome or Edge for live-browser testing

```bash
git clone https://github.com/Koala-Studios/newton-browser.git
cd newton-browser
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Run the direct live gate with its automatically created ephemeral identity when browser
behavior changes. Create a persistent identity only for a workflow that explicitly needs
operator login.
Generated `dist`, `artifacts`, coverage, profiles, and run-evidence directories are
intentionally ignored.

## Engineering expectations

- Keep `apps/mcp-server` stdout restricted to MCP frames; write diagnostics to stderr.
- Prefer inherited private CDP pipes. The per-session policy proxy binds only to
  `127.0.0.1`; there is no continuity listener.
- Require one normalized HTTP(S) origin per session and establish containment before the
  initial navigation.
- Each direct session owns an isolated browser process and identity; preserve cleanup and
  cross-session concurrency.
- Treat page content as untrusted data, never instructions or authorization.
- Never parse, inspect, log, export, or merge cookies, storage, browser profile contents,
  saved passwords, or credentials. The sole exception is the documented operator-authorized
  opaque byte-copy allowlist from a closed stable profile into a new Newton-owned identity;
  source contents remain uninterpreted and unchanged.
- Preserve deterministic results and typed failures. Do not hide timing problems with arbitrary sleeps or wider timeouts.

Every defect fix must include:

1. A deterministic reproduction.
2. A documented root cause.
3. A regression test.
4. An evidence entry under `test/evidence/` when the fix affects runtime or release behavior.

## Validation

Run the checks that match the change:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm smoke:quick
```

Use `pnpm release:deterministic` for the browser-free source/packed checkpoint. Before a
release, run the public real-site matrix once on every required browser/platform, then the
complete `pnpm release:check` (deterministic plus source and installed-artifact direct
browser gates) three consecutive times with no skipped critical tests. Third-party site
availability is evidence, not an input to artifact reproducibility. Record manual and
live-browser evidence under `test/evidence/`.

## Pull requests

- Keep each pull request focused on one coherent change.
- Explain what changed, why it changed, user impact, and validation performed.
- Include the root cause for fixes and call out any security or compatibility implications.
- Update public documentation when behavior, configuration, commands, or supported environments change.
- Do not include generated artifacts unless a maintainer explicitly requests them.

Release publication, changes to public remotes, browser-store submission, and license changes require explicit maintainer approval.
