import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreRoot = path.join(root, "packages", "core");
const defaultDestination = path.join(coreRoot, "dist");
const config = path.join(coreRoot, "tsconfig.build.json");
const tsc = require.resolve("typescript/bin/tsc");

export function buildCore({ quiet = false } = {}) {
  if (path.relative(coreRoot, defaultDestination) !== "dist"
    || defaultDestination === path.parse(defaultDestination).root) {
    throw new Error("invalid_core_build_destination");
  }
  fs.rmSync(defaultDestination, { recursive: true, force: true });
  fs.mkdirSync(defaultDestination, { recursive: true });
  const result = spawnSync(process.execPath, [tsc, "-p", config, "--pretty", "false"], {
    cwd: root,
    encoding: "utf8",
    stdio: quiet ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = quiet ? `${result.stdout || ""}${result.stderr || ""}`.trim() : "";
    throw new Error(`core_typescript_build_failed${detail ? `\n${detail}` : ""}`);
  }
  if (!quiet) console.log("newton browser core build ok");
  return defaultDestination;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) buildCore();
