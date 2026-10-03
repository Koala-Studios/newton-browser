import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Skips that only mean "this platform or filesystem lacks the feature under test".
// Any other skip (a missing browser, above all) is a required check that did not run.
const PLATFORM_SKIPS = new Set([
  "Windows-specific path behavior",
  "SEA launcher on Windows",
  "script launcher on this platform",
  "POSIX hard links",
  "symlink creation is unavailable in this environment",
  "file links unavailable",
  "temporary directory has no system directory link",
]);

const roots = ["packages/core/test", "packages/driver/test", "apps/mcp-server/test", "test"];
const files = roots.flatMap(testFilesBelow).sort((left, right) => left.localeCompare(right));
const required = process.env.NEWTON_BROWSER_REQUIRE_ACCEPTANCE === "1";
const tap = required ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-tests-")), "results.tap") : undefined;
const result = spawnSync(process.execPath, ["--test", "--test-isolation=none",
  ...(tap ? ["--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=tap", `--test-reporter-destination=${tap}`] : []),
  ...files], {
  cwd: process.cwd(),
  stdio: "inherit",
});
if (tap) {
  const skipped = [...fs.readFileSync(tap, "utf8").matchAll(/^\s*ok \d+ - (.*?) # SKIP ?(.*)$/gmu)]
    .filter(([, , reason]) => !PLATFORM_SKIPS.has(reason.trim()));
  fs.rmSync(path.dirname(tap), { recursive: true, force: true });
  if (skipped.length) {
    for (const [, name, reason] of skipped) process.stderr.write(`required test did not run: ${name} (${reason.trim() || "no reason"})\n`);
    process.exit(1);
  }
}
process.exit(result.status ?? 1);

function testFilesBelow(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) return testFilesBelow(candidate);
    return /\.test\.(?:js|mjs|ts)$/.test(entry.name) ? [candidate] : [];
  });
}
