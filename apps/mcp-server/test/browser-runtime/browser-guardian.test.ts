import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("guardian kills the detached browser and removes its exact ephemeral identity after parent loss", async () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url));
  const guardian = path.resolve(testDirectory, "../../src/browser-runtime/browser-guardian.ts");
  const browserFixture = path.join(testDirectory, "fixtures", "guardian-browser.mjs");
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "newton-guardian-test-"));
  const identityId = `nbi_${randomBytes(16).toString("hex")}`;
  const identityPath = path.join(storeRoot, identityId);
  const identityMarkerNonce = randomBytes(32).toString("hex");
  const storeNonce = randomBytes(32).toString("hex");
  const leaseNonce = randomBytes(32).toString("hex");
  const createdAt = new Date().toISOString();
  fs.mkdirSync(identityPath, { mode: 0o700 });
  const identityStat = fs.lstatSync(identityPath, { bigint: true });
  fs.writeFileSync(path.join(identityPath, ".newton-browser-profile-identity"), `${JSON.stringify({
    version: 1,
    type: "identity",
    nonce: identityMarkerNonce,
    storeNonce,
    identity: identityId,
    kind: "new",
    dev: identityStat.dev.toString(),
    ino: identityStat.ino.toString(),
  })}\n`, { mode: 0o600 });
  const leasePath = path.join(identityPath, ".newton-browser-profile-lease");
  fs.writeFileSync(leasePath, `${JSON.stringify({
    version: 1,
    type: "identity_lease",
    id: identityId,
    browserFamily: "chrome",
    nonce: leaseNonce,
    pid: process.pid,
    createdAt,
  })}\n`, { mode: 0o600 });
  const leaseStat = fs.lstatSync(leasePath, { bigint: true });
  const child = spawn(process.execPath, ["--experimental-strip-types", guardian], {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  try {
    const ready = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.on("message", (message: unknown) => {
        if (message && typeof message === "object" && (message as { type?: unknown }).type === "ready") {
          const pid = (message as { pid?: unknown }).pid;
          if (typeof pid === "number") resolve(pid);
        }
      });
    });
    child.send({
      type: "launch",
      executablePath: process.execPath,
      args: [browserFixture],
      cleanup: {
        storeRoot,
        identityPath,
        identityId,
        identityDev: identityStat.dev.toString(),
        identityIno: identityStat.ino.toString(),
        identityMarkerNonce,
        storeNonce,
        leasePath,
        leaseDev: leaseStat.dev.toString(),
        leaseIno: leaseStat.ino.toString(),
        leaseNonce,
        leasePid: process.pid,
        leaseCreatedAt: createdAt,
        removeIdentity: true,
      },
    });
    const browserPid = await ready;
    assert.doesNotThrow(() => process.kill(browserPid, 0));
    child.disconnect();
    await once(child, "exit");
    assert.equal(processExists(browserPid), false);
    assert.equal(fs.existsSync(identityPath), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
