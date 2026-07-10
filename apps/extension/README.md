# Browser Bridge Extension

Standalone MV3 extension source for Browser Bridge.

Build the unpacked extension:

```bash
pnpm extension:build
```

Then load this folder in Chromium:

```text
apps/extension
```

The `dist` folder is generated and ignored, but the unpacked extension root is the app folder so Chrome can use the checked-in manifest and generated runtime together. Source of truth stays in `packages/core` and `packages/driver`.
