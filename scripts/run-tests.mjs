import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const roots = ["packages/core/test", "packages/driver/test", "apps/mcp-server/test", "test"];
const files = roots.flatMap(testFilesBelow).sort((left, right) => left.localeCompare(right));
const result = spawnSync(process.execPath, ["--test", "--test-isolation=none", ...files], {
  cwd: process.cwd(),
  stdio: "inherit",
});
process.exit(result.status ?? 1);

function testFilesBelow(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) return testFilesBelow(candidate);
    return /\.test\.(?:js|mjs|ts)$/.test(entry.name) ? [candidate] : [];
  });
}
