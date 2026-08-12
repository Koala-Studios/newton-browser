import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildDeterministicPackageTarball } from "../scripts/deterministic-pack.mjs";

test("package tarball is byte-identical across source mtimes and remains installable", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "newton-deterministic-pack-"));
  try {
    const packageRoot = path.join(root, "package-source");
    fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "dist", "browser-guardian.js"), "export const guardian = true;\n");
    fs.writeFileSync(path.join(packageRoot, "dist", "index.js"), "#!/usr/bin/env node\nconsole.log('ok');\n");
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "fixture-package", version: "1.0.0", bin: { fixture: "./dist/index.js" } }, null, 2));
    fs.writeFileSync(path.join(packageRoot, "README.md"), "fixture\r\nreadme\r\n");
    const license = path.join(root, "LICENSE");
    fs.writeFileSync(license, "fixture license\r\n");
    const first = path.join(root, "first.tgz");
    const second = path.join(root, "second.tgz");
    const firstReceipt = buildDeterministicPackageTarball({ packageRoot, licensePath: license, tarball: first });
    const later = new Date(Date.now() + 86_400_000);
    for (const relative of ["dist/browser-guardian.js", "dist/index.js", "package.json", "README.md"]) {
      fs.utimesSync(path.join(packageRoot, ...relative.split("/")), later, later);
    }
    fs.utimesSync(license, later, later);
    const secondReceipt = buildDeterministicPackageTarball({ packageRoot, licensePath: license, tarball: second });
    assert.equal(firstReceipt.sha256, secondReceipt.sha256);
    assert.deepEqual(fs.readFileSync(first), fs.readFileSync(second));
    const listed = spawnSync("tar", ["-tf", first], { encoding: "utf8" });
    assert.equal(listed.status, 0);
    assert.deepEqual(listed.stdout.trim().split(/\r?\n/u), [
      "package/dist/browser-guardian.js",
      "package/dist/index.js",
      "package/package.json",
      "package/README.md",
      "package/LICENSE",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
