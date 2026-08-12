import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

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
console.log("newton browser MCP build ok");
