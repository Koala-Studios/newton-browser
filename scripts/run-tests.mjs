import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const roots = ["packages/core/test", "packages/driver/test", "apps/extension/test", "apps/mcp-server/test"];
const files = roots.flatMap((root) => fs.readdirSync(root)
  .filter((name) => /\.test\.(?:js|ts)$/.test(name))
  .map((name) => path.join(root, name)));
const result = spawnSync(process.execPath, ["--test", "--test-isolation=none", ...files], {
  cwd: process.cwd(),
  stdio: "inherit",
});
process.exit(result.status ?? 1);
