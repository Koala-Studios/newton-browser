import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildDriver } from "../../../scripts/build-driver.mjs";

const TEMP_PREFIX = "newton-driver-build-parity-";
const EXPECTED_FILES = [
  "ax-snapshot.d.ts", "ax-snapshot.js",
  "command-context.d.ts", "command-context.js",
  "command-store.d.ts", "command-store.js",
  "connection.d.ts", "connection.js",
  "control-reader.d.ts", "control-reader.js",
  "direct-debugger-port.d.ts",
  "direct-debugger-port.js",
  "direct-session-runtime.d.ts",
  "direct-session-runtime.js",
  "document-reader.d.ts", "document-reader.js",
  "driver.d.ts",
  "driver.js",
  "frame-mask-geometry.d.ts", "frame-mask-geometry.js",
  "input-dispatcher.d.ts",
  "input-dispatcher.js",
  "key-description.d.ts", "key-description.js",
  "native-edit-selection.d.ts", "native-edit-selection.js",
  "native-input.d.ts", "native-input.js",
  "native-sensitive-regions.d.ts", "native-sensitive-regions.js",
  "page-directory.d.ts", "page-directory.js",
  "page-executor.d.ts", "page-executor.js",
  "raster-mask.d.ts",
  "raster-mask.js",
  "readonly-world.d.ts", "readonly-world.js",
  "renderer-liveness.d.ts",
  "renderer-liveness.js",
  "session-command-pump.d.ts",
  "session-command-pump.js",
  "session-engine.d.ts", "session-engine.js",
  "session-live.d.ts", "session-live.js",
  "structured-reader.d.ts", "structured-reader.js",
  "table-grid.d.ts", "table-grid.js",
  "table-reader.d.ts", "table-reader.js",
  "target-registry.d.ts",
  "target-registry.js",
  "target-resolver.d.ts",
  "target-resolver.js",
  "text-edit-range.d.ts",
  "text-edit-range.js",
  "types.d.ts",
  "upload-files.d.ts", "upload-files.js",
];

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

function listFiles(root, directory = root) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
  return files.sort();
}

function snapshotBuild(root) {
  return new Map(listFiles(root).map((relative) => {
    const bytes = readFileSync(path.join(root, ...relative.split("/")));
    return [relative, {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }];
  }));
}

function removeExactTempRoot(root) {
  const resolvedRoot = path.resolve(root);
  const resolvedTemp = realpathSync(tmpdir());
  assert.equal(path.dirname(resolvedRoot), resolvedTemp);
  assert.match(path.basename(resolvedRoot), /^newton-driver-build-parity-[^/\\]+$/);
  rmSync(resolvedRoot, { recursive: true, force: true });
}

test("driver builds are deterministic and contain only production outputs", () => {
  const resolvedTemp = realpathSync(tmpdir());
  const coreEntry = path.join(workspaceRoot, "packages", "core", "dist", "index.js");
  const coreBefore = statSync(coreEntry, { bigint: true });
  const destinations = [
    mkdtempSync(path.join(resolvedTemp, TEMP_PREFIX)),
    mkdtempSync(path.join(resolvedTemp, TEMP_PREFIX)),
  ].map((destination) => path.resolve(destination));

  try {
    const firstDestination = buildDriver({ destination: destinations[0], quiet: true });
    const first = snapshotBuild(firstDestination);

    const secondDestination = buildDriver({ destination: destinations[1], quiet: true });
    const second = snapshotBuild(secondDestination);

    assert.deepEqual([...first.keys()], EXPECTED_FILES);
    assert.deepEqual([...second.keys()], EXPECTED_FILES);

    for (const relative of EXPECTED_FILES) {
      const firstFile = first.get(relative);
      const secondFile = second.get(relative);
      assert.ok(firstFile, `first build omitted ${relative}`);
      assert.ok(secondFile, `second build omitted ${relative}`);
      assert.equal(firstFile.sha256, secondFile.sha256, `${relative} hash differs`);
      assert.equal(firstFile.bytes.equals(secondFile.bytes), true, `${relative} bytes differ`);
    }

    const forbiddenPathSegment = /(^|\/)(?:test|tests|fixtures|__fixtures__)(?:\/|$)/i;
    const workspaceNeedles = [
      `${workspaceRoot}${path.sep}`,
      `${workspaceRoot.split(path.sep).join("/")}/`,
    ].map((value) => value.toLowerCase());

    for (const [relative, file] of first) {
      assert.equal(relative.endsWith(".ts") && !relative.endsWith(".d.ts"), false, `${relative} is TypeScript source`);
      assert.equal(relative.endsWith(".map"), false, `${relative} is a source map`);
      assert.equal(forbiddenPathSegment.test(relative), false, `${relative} is a dev-only fixture`);

      const text = file.bytes.toString("utf8").toLowerCase();
      for (const needle of workspaceNeedles) {
        assert.equal(text.includes(needle), false, `${relative} contains an absolute workspace path`);
      }
    }

    assert.equal(statSync(firstDestination).isDirectory(), true);
    assert.equal(statSync(secondDestination).isDirectory(), true);
    const coreAfter = statSync(coreEntry, { bigint: true });
    assert.equal(coreAfter.dev, coreBefore.dev, "custom driver build replaced the shared core device");
    assert.equal(coreAfter.ino, coreBefore.ino, "custom driver build replaced the shared core output");
    assert.equal(coreAfter.mtimeNs, coreBefore.mtimeNs, "custom driver build rewrote the shared core output");
  } finally {
    for (const destination of destinations) removeExactTempRoot(destination);
  }
});
