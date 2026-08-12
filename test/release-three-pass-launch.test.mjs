import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolvePnpmInvocation } from "../scripts/pnpm-invocation.mjs";

test("Windows release verifier launches pnpm through Node instead of spawning a cmd shim", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-pnpm-invocation-"));
  try {
    const execPath = path.join(root, "node.exe");
    const entrypoint = path.join(root, "node_modules", "pnpm", "bin", "pnpm.cjs");
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(execPath, "node");
    fs.writeFileSync(entrypoint, "pnpm");
    const invocation = resolvePnpmInvocation({ platform: "win32", execPath, npmExecPath: undefined });
    assert.deepEqual(invocation, { command: execPath, argsPrefix: [entrypoint] });
    assert.equal(invocation.command.endsWith(".cmd"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("release verifier uses an exact package-manager entrypoint supplied by pnpm", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-pnpm-invocation-"));
  try {
    const execPath = path.join(root, "node");
    const npmExecPath = path.join(root, "pnpm.cjs");
    fs.writeFileSync(execPath, "node");
    fs.writeFileSync(npmExecPath, "pnpm");
    assert.deepEqual(resolvePnpmInvocation({ platform: "linux", execPath, npmExecPath }), {
      command: execPath,
      argsPrefix: [npmExecPath],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
