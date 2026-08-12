import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const harnessRoot = path.join(root, "scripts", "smoke", "linux-chrome-live");
const dockerfile = fs.readFileSync(path.join(harnessRoot, "Dockerfile"), "utf8");
const entrypoint = fs.readFileSync(path.join(harnessRoot, "entrypoint.sh"), "utf8");
const readme = fs.readFileSync(path.join(harnessRoot, "README.md"), "utf8");
const prepare = path.join(harnessRoot, "prepare-workspace.mjs");
const receipt = path.join(harnessRoot, "harness-receipt.mjs");
const boundedCommand = fs.readFileSync(path.join(harnessRoot, "bounded-command.mjs"), "utf8");

function run(script, args) { return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" }); }
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "newton-linux-runner-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source"); const destination = path.join(directory, "destination");
  fs.mkdirSync(source);
  for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "README.md", "LICENSE"]) fs.writeFileSync(path.join(source, file), file === "package.json" ? "{}\n" : `${file}\n`);
  for (const child of ["apps", "packages", "scripts", "test"]) fs.mkdirSync(path.join(source, child));
  fs.mkdirSync(path.join(source, "packages", "driver", "src"), { recursive: true });
  fs.writeFileSync(path.join(source, "packages", "driver", "src", "dirty-new.ts"), "export const value = 1;\n");
  return { directory, source, destination };
}

test("image pins a full Chrome runtime and no extension tooling", () => {
  assert.match(dockerfile, /node:24\.6\.0-bookworm-slim@sha256:[a-f0-9]{64}/u);
  assert.match(dockerfile, /CHROME_FOR_TESTING_SHA256=[a-f0-9]{64}/u);
  assert.match(dockerfile, /sha256sum --check --strict/u);
  assert.match(dockerfile, /chmod 4755 .*chrome_sandbox/u);
  assert.doesNotMatch(dockerfile, /xdotool|load-extension|apps\/extension/u);
});

test("entrypoint runs only the direct owned-process gates", () => {
  assert.match(entrypoint, /pnpm build/u);
  assert.match(entrypoint, /pnpm pack:check/u);
  assert.match(entrypoint, /pnpm eval:agent-cost/u);
  assert.match(entrypoint, /pnpm eval:direct-live/u);
  assert.match(entrypoint, /pnpm eval:real-sites/u);
  assert.match(entrypoint, /newton-bounded-command\.mjs|\$BOUNDED_COMMAND/u);
  assert.doesNotMatch(entrypoint, />"\$RAW_LOG_ROOT\/[^"]+" 2>&1/u);
  assert.match(boundedCommand, /const CAP = 64 \* 1024/u);
  assert.match(dockerfile, /bounded-command\.mjs/u);
  assert.doesNotMatch(entrypoint, /extension|remote-debugging-port|NEWTON_BROWSER_RUNTIME_MODE|--headless|\bsleep\b/iu);
  assert.match(entrypoint, /rm -rf -- "\$RUN_ROOT"/u);
  assert.match(entrypoint, /RUN_OWNER/u);
  assert.match(readme, /private CDP pipe/u);
  assert.match(readme, /never adds `--no-sandbox`/u);
});

test("workspace preflight copies dirty source and refuses links and credentials", (t) => {
  const { directory, source, destination } = fixture(t);
  let result = run(prepare, [source, destination, "--skip-mount-check"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(destination, "packages", "driver", "src", "dirty-new.ts")), true);
  fs.writeFileSync(path.join(source, "scripts", "credentials.json"), "{}\n");
  result = run(prepare, [source, `${destination}-credential`, "--skip-mount-check"]);
  assert.notEqual(result.status, 0);
  fs.rmSync(path.join(source, "scripts", "credentials.json"));
  const outside = path.join(directory, "outside"); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(source, "apps", "escape"), process.platform === "win32" ? "junction" : "dir");
  result = run(prepare, [source, `${destination}-link`, "--skip-mount-check"]);
  assert.notEqual(result.status, 0);
});

test("receipts persist bounded hashes and exact direct gate status", (t) => {
  const { directory } = fixture(t); const input = path.join(directory, "raw.log"); const output = path.join(directory, "log.json");
  fs.writeFileSync(input, `${JSON.stringify({ step: "direct_live", secret: "DO_NOT_PERSIST" })}\n`);
  let result = run(receipt, ["log", input, output, "direct-live", "17"]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(fs.readFileSync(output, "utf8"), /DO_NOT_PERSIST/u);
  const runId = "linux-cft-0123456789abcdef"; const runDirectory = path.join(directory, runId); fs.mkdirSync(runDirectory);
  assert.equal(run(receipt, ["start", runDirectory, runId]).status, 0);
  result = run(receipt, ["final", runDirectory, runId, "direct_live", "17", "0", "0", "17"]);
  assert.equal(result.status, 0, result.stderr);
  const final = JSON.parse(fs.readFileSync(path.join(runDirectory, "gate-status.json"), "utf8"));
  assert.equal(final.architecture, "owned_process_private_cdp"); assert.equal(final.liveStatus, 17); assert.equal(final.gateStatus, 17);
});
