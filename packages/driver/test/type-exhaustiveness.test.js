import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tsc = require.resolve("typescript/bin/tsc");
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "unhandled-browser-action.ts");

test("strict typecheck rejects an intentionally unhandled browser action", () => {
  const result = spawnSync(process.execPath, [
    tsc,
    fixture,
    "--noEmit",
    "--target", "ES2023",
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--strict",
    "--skipLibCheck",
    "--types", "node",
    "--allowImportingTsExtensions",
    "--pretty", "false",
  ], { cwd: process.cwd(), encoding: "utf8" });

  assert.notEqual(result.status, 0, "the deliberately incomplete switch unexpectedly typechecked");
  const diagnostics = `${result.stdout || ""}${result.stderr || ""}`;
  assert.match(diagnostics, /error TS2345/);
  assert.match(diagnostics, /network/);
});
