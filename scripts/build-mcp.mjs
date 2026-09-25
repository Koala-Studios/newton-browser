import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import {buildTabAdapter} from './build-tab-adapter.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "apps", "mcp-server", "dist");
fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.mkdirSync(outputDirectory, { recursive: true });

await build({
  entryPoints: [path.join(root, "apps", "mcp-server", "src", "index.ts")],
  outfile: path.join(outputDirectory, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
});
await build({
  entryPoints: [path.join(root, "apps", "mcp-server", "src", "browser-runtime", "browser-guardian.ts")],
  outfile: path.join(outputDirectory, "browser-guardian.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: false,
  logLevel: "warning",
});
fs.chmodSync(path.join(outputDirectory, "index.js"), 0o755);
for (const entry of ["native-install", "engine-candidate"]) await build({
  entryPoints: [path.join(root, "apps", "mcp-server", "src", `${entry}.ts`)],
  outfile: path.join(outputDirectory, `${entry}.js`), bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "warning",
});
fs.copyFileSync(path.join(root, "apps", "mcp-server", "src", "native-launcher.cjs"), path.join(outputDirectory, "native-launcher.cjs"));
await build({
  entryPoints: [path.join(root, "apps", "mcp-server", "src", "native-host.ts")],
  outfile: path.join(outputDirectory, "native-host.js"), bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "warning",
});
await build({
  entryPoints: [path.join(root, "apps", "mcp-server", "src", "browser-runtime", "profile-copy-worker.ts")],
  outfile: path.join(outputDirectory, "profile-copy-worker.js"),
  bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "warning",
});
console.log("newton browser MCP build ok");
await buildTabAdapter(path.join(outputDirectory,'tab-adapter'));
