# Plan 08 — Driver TypeScript Hardening

- **Status:** Approved; implementation in progress
- **Depends on:** Plans 01–07 stabilized
- **Primary outcome:** The critical driver/controller/transport path is checked by TypeScript and built deterministically, without rewriting the product or changing runtime behavior.

## Why this is a must-do

Rust gives agent-browser compile-time guarantees and predictable native packaging, but Newton does not need a Rust rewrite to capture the most relevant advantage. Newton’s critical driver files are JavaScript and are excluded by the root TypeScript configuration, so protocol drift, missing cases, and lifecycle shape errors can escape compilation. A focused TypeScript conversion addresses that risk while retaining Newton’s JavaScript/Chromium architecture.

## Non-goals

- No Rust rewrite, native executable, daemon, hosted component, database, or model-provider integration.
- No behavior, output-default, or public contract change in this plan.
- No conversion of overlay/UI assets solely for language uniformity.
- No build framework migration beyond what is required to compile the critical files.

## Files

### Add

- `packages/driver/tsconfig.json` — strict package-local compiler configuration.
- `packages/driver/src/types.ts` — internal target/session/command types not already defined in core.
- `packages/driver/test/build-parity.test.js` — packaged exports/assets and deterministic-build assertions.

### Rename by add/delete after parity

- Add `packages/driver/src/controller.ts`; delete `packages/driver/src/controller.js`.
- Add `packages/driver/src/driver.ts`; delete `packages/driver/src/driver.js`.
- Add `packages/driver/src/chrome-tabs-port.ts`; delete `packages/driver/src/chrome-tabs-port.js`.
- Add TypeScript replacements for Plans 01–07 driver modules; delete their `.js` sources only after each replacement passes its own tests.

### Edit

- `scripts/build-driver.mjs` — compile TypeScript to the existing distribution layout and copy non-code assets.
- Root `tsconfig.json` — reference the driver package rather than pretending copied JavaScript is type-checked.
- Root `package.json` and lockfile only if a compiler/bundler dependency is genuinely missing.
- `scripts/build-extension.mjs` — consume driver output at the same vendor paths.
- Driver tests that import source modules — import the compiled package or a TypeScript-aware test entry consistently.
- `README.md`, `docs/RELEASE.md`, `docs/DECISIONS.md`, and `test/evidence/qa-ledger.md`.

### Delete

- The source-copy-only code path in `scripts/build-driver.mjs` after the compiled build is verified.
- Temporary `allowJs`/`checkJs` scaffolding after all critical files are TypeScript.

## Migration sequence

### Stage A — expose existing errors without renaming

Create a driver-specific config that checks JavaScript:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "strict": true
  },
  "include": ["src/**/*.js", "src/**/*.ts"]
}
```

Resolve diagnostics with real narrowing and shared protocol types. Avoid blanket `any`, `@ts-ignore`, and type assertions that merely suppress uncertainty. Any unavoidable external CDP shape escape is isolated at one adapter boundary and documented.

### Stage B — convert leaf modules first

Convert pure policies and registries from Plans 01–07 before `driver` and `controller`. Preserve export names and module format. Every rename is a reviewable add/delete pair with its unit tests green.

### Stage C — convert controller and driver

Use exhaustive discriminated unions for command and outcome handling:

```ts
function assertNever(value: never): never {
  throw new Error(`Unhandled command variant: ${JSON.stringify(value)}`);
}

switch (command.kind) {
  case "observe": return observe(command);
  case "click": return click(command);
  case "type": return type(command);
  default: return assertNever(command);
}
```

Import public protocol shapes from `packages/core`; do not maintain handwritten duplicates in the driver.

### Stage D — compile deterministically

`scripts/build-driver.mjs` invokes one pinned compiler/bundler configuration and produces the current `dist` filenames expected by the extension. It copies CSS/overlay assets separately. Do not emit source maps into packed artifacts unless separately approved.

Build twice into clean temporary directories and compare hashes. Generated timestamps and machine-specific paths are forbidden.

## Type requirements

- `strict`, `noImplicitOverride`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` are enabled where dependency types permit.
- Session state, target state, command lifecycle, and browser outcomes are discriminated unions.
- CDP session routing requires a composite target/session key; a plain `tabId` is not accepted by routed helpers.
- All timers and listeners have typed ownership/cleanup handles.
- Public payloads enter as `unknown` and pass core validation before narrowing.

## Implementation slices

1. Add check-JS configuration and record the initial diagnostic inventory.
2. Fix diagnostics without runtime changes.
3. Convert pure leaf modules and tests.
4. Convert transport, controller, and driver in dependency order.
5. Replace source copying with deterministic compilation.
6. Verify extension, MCP package, packed artifact, and clean checkout builds.

Each slice must have a behavior-parity assertion. Do not combine feature work with conversion commits.

## Required tests

- Typecheck fails on an intentionally unhandled command/outcome fixture.
- Existing driver unit and integration tests pass unchanged in behavior.
- Built package exports and extension vendor paths match the pre-conversion contract.
- Two clean builds are byte-identical for generated JavaScript/assets.
- Packed artifacts contain no `.ts`, development-only maps, absolute paths, or test fixtures.
- Startup, observer continuity, current-tab, frame routing, containment, and command-pump live smokes pass.

## Exit criteria

- Critical driver/controller sources are TypeScript and included in normal `pnpm lint`/typecheck gates.
- No unchecked source-copy path remains for executable driver code.
- Zero suppressions are added without a specific tracked justification.
- Behavior and MCP fixtures show no unplanned diff.
- `pnpm release:check` passes from packed artifacts three consecutive times with no skipped critical tests.

## Rollback

Restore the last JavaScript sources and copy build only as a complete known-good set. Do not mix TypeScript source with stale copied JavaScript outputs. Preserve conversion diagnostics and parity tests so the migration can resume safely.
