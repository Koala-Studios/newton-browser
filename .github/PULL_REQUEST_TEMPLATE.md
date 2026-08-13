## Summary

Describe what changed and why.

## User impact

Explain the behavior, compatibility, security, or documentation impact.

## Validation

List the exact checks and environments used.

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] Relevant smoke or live-browser checks

## Defect evidence

For a fix, include the deterministic reproduction, root cause, regression test, and evidence entry. Write `Not applicable` for non-defect changes.

## Checklist

- [ ] The change preserves private-CDP/local-only transport and exact origin scoping.
- [ ] No credentials, profile contents, sensitive page content, or private paths are included.
- [ ] Public behavior and configuration changes are documented.
- [ ] Generated artifacts are excluded unless explicitly requested.
