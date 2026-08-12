import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const family = process.env.NEWTON_BROWSER_QA_OWNER === "edge" ? "edge" : "chrome";
const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "newton-direct-hard-crash-"));
const storeRoot = path.join(root, "identity-store");
const worker = path.resolve("scripts/smoke/direct-hard-crash-worker.mjs");
let child;
let observedBrowserPid = 0;
try {
  child = spawn(process.execPath, ["--experimental-strip-types", worker], {
    cwd: process.cwd(),
    env: { ...process.env, NEWTON_BROWSER_QA_OWNER: family, NEWTON_BROWSER_PROFILE_STORE_DIR: storeRoot },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  child.stderr.on("data", () => {});
  const browserPid = await waitForReady(child);
  observedBrowserPid = browserPid;
  if (!processExists(browserPid)) throw new Error("direct_hard_crash_browser_not_live");
  const cleaned = waitForIdentityCleanup(storeRoot);
  child.kill("SIGKILL");
  await once(child, "exit");
  await cleaned;
  if (processExists(browserPid)) throw new Error("direct_hard_crash_browser_orphaned");
  const residue = fs.existsSync(storeRoot)
    ? fs.readdirSync(storeRoot).filter((name) => name.startsWith("nbi_") || name.includes("lease"))
    : [];
  if (residue.length !== 0) throw new Error("direct_hard_crash_identity_residue");
  process.stdout.write(`${JSON.stringify({ ok: true, browserFamily: family, browserProcessTerminated: true, ephemeralIdentityRemoved: true })}\n`);
} catch (error) {
  const identities = fs.existsSync(storeRoot) ? fs.readdirSync(storeRoot).filter((name) => name.startsWith("nbi_")) : [];
  const leases = identities.filter((identity) => fs.existsSync(path.join(storeRoot, identity, ".newton-browser-profile-lease"))).length;
  process.stdout.write(`${JSON.stringify({
    ok: false,
    browserFamily: family,
    errorCode: safeCode(error),
    browserProcessAlive: observedBrowserPid > 0 && processExists(observedBrowserPid),
    identityCount: Math.min(identities.length, 64),
    leaseCount: Math.min(leases, 64),
  })}\n`);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  // The detached guardian can finish its process exit just after it has removed
  // the identity. Windows may retain a directory handle during that bounded
  // transition, so await the exact owned temp root instead of reporting a false
  // failure after the browser and identity cleanup have both been proven.
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 100, retryDelay: 50 });
}

function safeCode(error) {
  const value = error && typeof error === "object" && typeof error.code === "string"
    ? error.code
    : error instanceof Error ? error.message : "direct_hard_crash_failed";
  return /^[a-z][a-z0-9_]{0,79}$/u.test(value) ? value : "direct_hard_crash_failed";
}

function waitForReady(processHandle) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("direct_hard_crash_ready_timeout")), 60_000);
    timer.unref();
    const onError = (error) => finish(error);
    const onExit = () => finish(new Error("direct_hard_crash_worker_exited"));
    const onMessage = (message) => {
      if (message?.type === "ready" && message.ephemeralIdentity === true && Number.isSafeInteger(message.browserPid) && message.browserPid > 0) {
        cleanup();
        resolve(message.browserPid);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      processHandle.off("error", onError);
      processHandle.off("exit", onExit);
      processHandle.off("message", onMessage);
    };
    const finish = (error) => { cleanup(); reject(error); };
    processHandle.once("error", onError);
    processHandle.once("exit", onExit);
    processHandle.on("message", onMessage);
  });
}

function waitForIdentityCleanup(storeRoot) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("direct_hard_crash_cleanup_timeout")), 30_000);
    timer.unref();
    let watcher;
    const check = () => {
      if (!fs.existsSync(storeRoot)) return;
      const identities = fs.readdirSync(storeRoot).filter((name) => name.startsWith("nbi_"));
      if (identities.length === 0) finish();
    };
    const finish = (error) => {
      clearTimeout(timer);
      watcher?.close();
      if (error) reject(error); else resolve();
    };
    fs.mkdirSync(storeRoot, { recursive: true });
    watcher = fs.watch(storeRoot, check);
    check();
  });
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}
