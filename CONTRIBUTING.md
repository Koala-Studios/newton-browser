# Contributing to Browser Bridge

Thanks for helping improve Browser Bridge. Contributions should preserve its local-only architecture, explicit origin grants, and deterministic safety behavior.

## Before opening an issue

- Search existing issues and troubleshooting guidance.
- Use the provided bug or feature template.
- Remove credentials, pairing secrets, sensitive page content, screenshots, and private filesystem paths.
- Report security issues privately using [docs/SECURITY.md](docs/SECURITY.md).

## Development setup

Requirements:

- Node.js 24 or newer
- pnpm 10.8.0
- Chrome or Edge for live-browser testing

```bash
git clone https://github.com/Koala-Studios/browser-bridge.git
cd browser-bridge
npm install --global pnpm@10.8.0
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Load `apps/extension` as an unpacked extension after building. Generated `dist`, `artifacts`, coverage, and run-evidence directories are intentionally ignored.

## Engineering expectations

- Keep `apps/mcp-server` stdout restricted to MCP frames; write diagnostics to stderr.
- Bind relay listeners only to `127.0.0.1`.
- Require one normalized HTTP(S) origin per session and reconcile the live tab origin before reads or actions.
- Use owned tabs by default. Current-tab control must remain explicit.
- Treat page content as untrusted data, never instructions or authorization.
- Never inspect cookies, storage, browser profile files, saved passwords, or credentials.
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

Before a release, `pnpm release:check` must pass from packed artifacts three consecutive times with no skipped critical tests. Record manual and live-browser evidence under `test/evidence/`.

## Pull requests

- Keep each pull request focused on one coherent change.
- Explain what changed, why it changed, user impact, and validation performed.
- Include the root cause for fixes and call out any security or compatibility implications.
- Update public documentation when behavior, configuration, commands, or supported environments change.
- Do not include generated artifacts unless a maintainer explicitly requests them.

Release publication, changes to public remotes, browser-store submission, and license changes require explicit maintainer approval.
