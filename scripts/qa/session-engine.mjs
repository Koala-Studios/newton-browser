import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const TEST_FILE_SUFFIXES = [".test.js", ".test.mjs", ".test.ts"];

const GROUPS = Object.freeze({
  // engine: foundational queue, lifecycle, navigation, and direct engine regressions.
  engine: Object.freeze([
    "packages/core/test/command-foundation.test.mjs",
    "packages/driver/test/engine-foundation.test.mjs",
    "packages/driver/test/native-input.test.mjs",
    "packages/driver/test/target-inspection.test.mjs",
    "packages/driver/test/navigation-probe.test.mjs",
    "packages/driver/test/navigation-feedback.test.mjs",
    "packages/driver/test/press-feedback.test.mjs",
    "packages/driver/test/hidden-input.test.mjs",
    "packages/driver/test/action-new-pages.test.mjs",
    { kind: "directory", path: "test/engine-regressions" },
  ]),
  // reader: bounded reads, raster/sensitive control/document projection, and delta/document extensions.
  reader: Object.freeze([
    "packages/driver/test/ax-snapshot.test.mjs",
    "packages/driver/test/control-reader.test.mjs",
    "packages/driver/test/control-budget.test.mjs",
    "packages/driver/test/document-chunk.test.mjs",
    "packages/driver/test/record-delta.test.mjs",
    "packages/driver/test/record-delta-adversarial.test.mjs",
    "packages/driver/test/table-grid.test.mjs",
    "packages/driver/test/table-grid-adversarial.test.mjs",
    "packages/driver/test/scoped-document-frames.test.mjs",
    "packages/driver/test/scoped-document-frame-limits.test.mjs",
    "packages/driver/test/scoped-control-frames.test.mjs",
    "packages/driver/test/frame-scope-predicate.test.mjs",
    "packages/driver/test/raster-mask.test.ts",
    "packages/driver/test/screenshot-mask-consistency.test.mjs",
    "packages/driver/test/native-sensitive-regions.test.mjs",
    "test/engine-regressions/document-reader.test.mjs",
    "test/engine-regressions/structured-records.test.mjs",
    "test/engine-regressions/oversized-observation.test.mjs",
    "test/engine-regressions/control-context.test.mjs",
    "test/engine-regressions/sensitive-shadow-discovery.test.mjs",
  ]),
  // connections: existing/browser lifecycle, tab lifecycle, adapter, and profile/process foundations.
  connections: Object.freeze([
    "test/existing-discovery.test.mjs",
    "test/existing-new-tab-host.test.mjs",
    "test/existing-page-family.test.mjs",
    "test/existing-page-family-route-capacity.test.mjs",
    "test/tab-foundation.test.mjs",
    "test/tab-route-retirement.test.mjs",
    "test/tab-popup-claims.test.mjs",
    "test/tab-popup-claims-adversarial.test.mjs",
    "test/tab-detach-pending.test.mjs",
    "test/tab-detach-pending-adversarial.test.mjs",
    "test/tab-create-cleanup.test.mjs",
    "test/tab-create-claims.test.mjs",
    "test/tab-adapter-response.test.mjs",
    "test/profile-transaction-recovery.test.mjs",
    "test/process-table-foundation.test.mjs",
    "test/adapter-cli-update.test.mjs",
    "test/adapter-directory-adversarial.test.mjs",
    "test/adapter-update-journal.test.mjs",
    "test/adapter-update-journal-adversarial.test.mjs",
    "test/adapter-update-transaction-adversarial.test.mjs",
    "test/native-broker-startup.test.mjs",
    "test/native-client-adversarial.test.mjs",
    "test/native-launcher-validation.test.mjs",
    "test/native-publication.test.mjs",
    "test/native-reconnect.test.mjs",
    "test/native-registration-path.test.mjs",
    "test/native-runtime-build-adversarial.test.mjs",
    "apps/mcp-server/test/modern-mcp-stdio.test.ts",
    "apps/mcp-server/test/mcp-contract.test.ts",
    "apps/mcp-server/test/browser-runtime/profile-store.test.ts",
    "apps/mcp-server/test/browser-runtime/profile-closure.test.ts",
    "apps/mcp-server/test/browser-runtime/process-supervisor.test.ts",
    "apps/mcp-server/test/browser-runtime/identity-cli.test.ts",
  ]),
});

if (path.resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  runCli();
}

export function engineTestFiles(root = ROOT, group) {
  const rootDirectory = resolveRoot(root);
  if (typeof group !== "string" || group.length === 0) throw new Error("session_engine_group_missing");
  if (!Object.hasOwn(GROUPS, group)) throw new Error(`session_engine_unknown_group:${group}`);
  const entries = GROUPS[group];
  const files = new Set();
  for (const entry of entries) {
    if (typeof entry === "string") {
      const absolute = resolveRelativeCandidate(rootDirectory, entry);
      if (!isTestFile(absolute)) {
        throw new Error(`session_engine_invalid_test_file:${entry}`);
      }
      assertNotSymlinkOrMissing(absolute, entry);
      files.add(absolute);
      continue;
    }
    if (!entry || entry.kind !== "directory" || typeof entry.path !== "string" || entry.path.length === 0) {
      throw new Error("session_engine_group_entry_invalid");
    }
    for (const discovered of collectTestFilesFromDirectory(rootDirectory, entry.path)) {
      files.add(discovered);
    }
  }
  if (files.size === 0) throw new Error(`session_engine_group_empty:${group}`);
  return [...files].sort(comparePath);
}

function runCli() {
  const group = process.argv[2];
  if (process.argv.length !== 3 || typeof group !== "string" || group.length === 0) {
    process.stderr.write(`Usage: node scripts/qa/session-engine.mjs <${Object.keys(GROUPS).sort().join("|")}>
`);
    process.exit(1);
  }
  let files;
  try {
    files = engineTestFiles(ROOT, group);
  } catch (error) {
    process.stderr.write(`${String(error instanceof Error ? error.message : error)}
`);
    process.exit(1);
  }
  const result = spawnSync(process.execPath, ["--test", "--test-isolation=none", ...files], {
    cwd: ROOT,
    stdio: "inherit",
    windowsHide: true,
    timeout: 600_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status);
  }
}

function collectTestFilesFromDirectory(rootDirectory, relativeDirectory) {
  const absoluteDirectory = resolveRelativeCandidate(rootDirectory, relativeDirectory);
  const stat = fs.lstatSync(absoluteDirectory);
  if (stat.isSymbolicLink()) throw new Error(`session_engine_directory_symlink:${relativeDirectory}`);
  if (!stat.isDirectory()) throw new Error(`session_engine_directory_invalid:${relativeDirectory}`);
  return fs.readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.resolve(absoluteDirectory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`session_engine_directory_entry_symlink:${path.relative(rootDirectory, absolute)}`);
    if (entry.isDirectory()) {
      return collectTestFilesFromDirectory(rootDirectory, path.relative(rootDirectory, absolute));
    }
    if (entry.isFile() && isTestFile(absolute)) return [absolute];
    return [];
  });
}

function resolveRoot(candidate) {
  const rootDirectory = path.resolve(candidate);
  const stat = fs.lstatSync(rootDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("session_engine_root_invalid");
  return rootDirectory;
}

function resolveRelativeCandidate(rootDirectory, relativePath) {
  const normalized = relativePath.replace(/\\/gu, "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("..") || normalized.includes("\0")) {
    throw new Error(`session_engine_relative_invalid:${relativePath}`);
  }
  const absolute = path.resolve(rootDirectory, ...normalized.split("/"));
  const relative = path.relative(rootDirectory, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(`..${path.sep}`)) {
    throw new Error(`session_engine_relative_escape:${relativePath}`);
  }
  return absolute;
}

function assertNotSymlinkOrMissing(absolutePath, relativePath = absolutePath) {
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(`session_engine_file_missing:${relativePath}`);
    }
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`session_engine_path_symlink:${relativePath}`);
  if (!stat.isFile()) throw new Error(`session_engine_not_file:${relativePath}`);
}

function isTestFile(candidate) {
  return TEST_FILE_SUFFIXES.some((suffix) => candidate.endsWith(suffix));
}

function comparePath(left, right) {
  const leftLength = left.length;
  const rightLength = right.length;
  const minimumLength = Math.min(leftLength, rightLength);
  for (let index = 0; index < minimumLength; index += 1) {
    const leftChar = left.charCodeAt(index);
    const rightChar = right.charCodeAt(index);
    if (leftChar === rightChar) continue;
    return leftChar < rightChar ? -1 : 1;
  }
  if (leftLength === rightLength) return 0;
  return leftLength < rightLength ? -1 : 1;
}