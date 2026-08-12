import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const driverRoot = path.join(root, "packages", "driver");
const defaultDestination = path.join(driverRoot, "dist");
const config = path.join(driverRoot, "tsconfig.json");
const coreConfig = path.join(root, "packages", "core", "tsconfig.build.json");
const tsc = require.resolve("typescript/bin/tsc");

export function buildDriver({ destination = defaultDestination, quiet = false } = {}) {
  const resolvedDestination = path.resolve(destination);
  prepareDestination(resolvedDestination);

  runTypeScript(["-p", coreConfig, "--pretty", "false"], quiet, "core_typescript_build_failed");

  runTypeScript([
    "-p",
    config,
    "--outDir",
    resolvedDestination,
    "--pretty",
    "false",
  ], quiet, "driver_typescript_build_failed");

  // `types.ts` contains declarations only. TypeScript emits an empty `export {}`
  // module for it, but no runtime imports reference that file after type erasure.
  fs.rmSync(path.join(resolvedDestination, "types.js"), { force: true });

  if (!quiet) console.log("newton browser driver build ok");
  return resolvedDestination;
}

function runTypeScript(args, quiet, failureCode) {
  const result = spawnSync(process.execPath, [tsc, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: quiet ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = quiet ? `${result.stdout || ""}${result.stderr || ""}`.trim() : "";
    throw new Error(`${failureCode}${detail ? `\n${detail}` : ""}`);
  }
}

function prepareDestination(destination) {
  if (destination === defaultDestination) {
    const relative = path.relative(driverRoot, destination);
    if (relative !== "dist") throw new Error("invalid_default_driver_build_destination");
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(destination, { recursive: true });
    return;
  }

  if (fs.existsSync(destination) && fs.readdirSync(destination).length > 0) {
    throw new Error("custom_driver_build_destination_must_be_empty");
  }
  fs.mkdirSync(destination, { recursive: true });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) buildDriver();
