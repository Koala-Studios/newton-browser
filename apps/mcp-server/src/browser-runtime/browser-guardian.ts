import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";

type LaunchMessage = Readonly<{
  type: "launch";
  executablePath: string;
  args: readonly string[];
  cleanup: CleanupPlan;
}>;

type CleanupPlan = Readonly<{
  storeRoot: string; identityPath: string; identityId: string; identityDev: string; identityIno: string;
  identityMarkerNonce: string; storeNonce: string; leasePath: string; leaseDev: string; leaseIno: string;
  leaseNonce: string; leasePid: number; leaseCreatedAt: string; removeIdentity: boolean;
}>;

let browser: ChildProcess | null = null;
let terminating = false;
let cleanupPlan: CleanupPlan | null = null;
let browserExitComplete: Promise<void> | null = null;
let resolveBrowserExit: (() => void) | null = null;

process.once("message", (message: unknown) => {
  if (!isLaunchMessage(message) || browser) return fatal("guardian_invalid_launch");
  cleanupPlan = message.cleanup;
  try {
    browser = spawn(message.executablePath, [...message.args], {
      detached: true,
      stdio: ["ignore", "ignore", 2, 3, 4],
      windowsHide: true,
    });
  } catch {
    return fatal("guardian_browser_spawn_failed");
  }
  const pid = browser.pid;
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return fatal("guardian_browser_spawn_failed");
  browserExitComplete = new Promise<void>((resolve) => { resolveBrowserExit = resolve; });
  browser.once("error", () => { void terminateAfterBrowserFailure(); });
  browser.once("exit", (code, signal) => { void finishBrowserExit(code, signal); });
  send({ type: "ready", pid: Number(pid) });
});

process.once("disconnect", () => { void terminateAfterParentLoss(); });
process.once("SIGTERM", () => { void terminateAfterParentLoss(); });
process.once("SIGINT", () => { void terminateAfterParentLoss(); });

async function terminateAfterParentLoss(): Promise<void> {
  if (terminating) return;
  terminating = true;
  const pid = browser?.pid;
  if (Number.isSafeInteger(pid) && Number(pid) > 0 && browser?.exitCode === null && browser?.signalCode === null) {
    await killTree(Number(pid)).catch(() => {});
  }
  await browserExitComplete?.catch(() => {});
  process.exit(0);
}

async function terminateAfterBrowserFailure(): Promise<void> {
  if (terminating) return;
  terminating = true;
  const pid = browser?.pid;
  if (Number.isSafeInteger(pid) && Number(pid) > 0 && browser?.exitCode === null && browser?.signalCode === null) {
    try { await killTree(Number(pid)); }
    catch { return; } // Stay resident and retain the profile lease if ownership is uncertain.
  }
  await browserExitComplete?.catch(() => {});
  fatal("guardian_browser_failed");
}

async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    const [code] = await once(killer, "exit");
    if (code !== 0 && processExists(pid)) throw new Error("guardian_tree_kill_failed");
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function isLaunchMessage(value: unknown): value is LaunchMessage {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return input.type === "launch"
    && typeof input.executablePath === "string"
    && input.executablePath.length > 0
    && input.executablePath.length <= 32_768
    && Array.isArray(input.args)
    && input.args.length <= 128
    && input.args.every((arg) => typeof arg === "string" && arg.length <= 2_048)
    && isCleanupPlan(input.cleanup)
    && Object.keys(input).sort().join(",") === "args,cleanup,executablePath,type";
}

function isCleanupPlan(value: unknown): value is CleanupPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Record<string, unknown>;
  const textKeys = ["storeRoot", "identityPath", "identityId", "identityDev", "identityIno", "identityMarkerNonce", "storeNonce", "leasePath", "leaseDev", "leaseIno", "leaseNonce", "leaseCreatedAt"];
  return textKeys.every((key) => typeof plan[key] === "string" && String(plan[key]).length > 0 && String(plan[key]).length <= 32_768)
    && Number.isSafeInteger(plan.leasePid) && Number(plan.leasePid) > 0
    && typeof plan.removeIdentity === "boolean"
    && Object.keys(plan).sort().join(",") === [...textKeys, "leasePid", "removeIdentity"].sort().join(",");
}

async function finishBrowserExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
  await cleanupProfile(cleanupPlan);
  send({ type: "browser_exit", code, signal });
  resolveBrowserExit?.();
  resolveBrowserExit = null;
  if (!terminating) process.exit(0);
}

async function cleanupProfile(plan: CleanupPlan | null): Promise<void> {
  if (!plan) return;
  try {
    const storeStat = fs.lstatSync(plan.storeRoot);
    const plannedIdentityStat = fs.lstatSync(plan.identityPath);
    if (!storeStat.isDirectory() || storeStat.isSymbolicLink()
      || !plannedIdentityStat.isDirectory() || plannedIdentityStat.isSymbolicLink()
      || path.dirname(path.resolve(plan.identityPath)) !== path.resolve(plan.storeRoot)) return;
    const storeRoot = fs.realpathSync.native(plan.storeRoot);
    const identityPath = fs.realpathSync.native(plan.identityPath);
    if (path.dirname(identityPath) !== storeRoot || path.basename(identityPath) !== plan.identityId
      || path.relative(identityPath, path.join(storeRoot, plan.identityId)) !== "") return;
    const identityStat = fs.lstatSync(identityPath, { bigint: true });
    if (!identityStat.isDirectory() || identityStat.isSymbolicLink()
      || identityStat.dev.toString() !== plan.identityDev || identityStat.ino.toString() !== plan.identityIno) return;
    const markerPath = path.join(identityPath, ".newton-browser-profile-identity");
    const markerStat = fs.lstatSync(markerPath);
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || marker.nonce !== plan.identityMarkerNonce
      || marker.storeNonce !== plan.storeNonce || marker.identity !== plan.identityId
      || marker.dev !== plan.identityDev || marker.ino !== plan.identityIno) return;
    if (path.dirname(path.resolve(plan.leasePath)) !== path.resolve(plan.identityPath)) return;
    const leaseStat = fs.lstatSync(plan.leasePath, { bigint: true });
    if (leaseStat.isSymbolicLink() || fs.realpathSync.native(plan.leasePath) !== path.join(identityPath, path.basename(plan.leasePath))) return;
    const lease = JSON.parse(fs.readFileSync(plan.leasePath, "utf8")) as Record<string, unknown>;
    if (!leaseStat.isFile() || leaseStat.isSymbolicLink() || leaseStat.nlink !== 1n
      || leaseStat.dev.toString() !== plan.leaseDev || leaseStat.ino.toString() !== plan.leaseIno
      || lease.nonce !== plan.leaseNonce || lease.pid !== plan.leasePid || lease.createdAt !== plan.leaseCreatedAt
      || lease.id !== plan.identityId) return;
    if (plan.removeIdentity) {
      const quarantine = path.join(storeRoot, `.guardian-removing-${plan.identityId}-${plan.leaseNonce}`);
      await renameAfterBrowserExit(identityPath, quarantine);
      const moved = fs.lstatSync(quarantine, { bigint: true });
      if (!moved.isDirectory() || moved.isSymbolicLink() || moved.dev.toString() !== plan.identityDev || moved.ino.toString() !== plan.identityIno) return;
      const movedMarkerPath = path.join(quarantine, ".newton-browser-profile-identity");
      const movedLeasePath = path.join(quarantine, path.basename(plan.leasePath));
      const movedMarker = JSON.parse(fs.readFileSync(movedMarkerPath, "utf8")) as Record<string, unknown>;
      const movedLeaseStat = fs.lstatSync(movedLeasePath, { bigint: true });
      const movedLease = JSON.parse(fs.readFileSync(movedLeasePath, "utf8")) as Record<string, unknown>;
      if (movedMarker.nonce !== plan.identityMarkerNonce || movedMarker.storeNonce !== plan.storeNonce
        || !movedLeaseStat.isFile() || movedLeaseStat.isSymbolicLink() || movedLeaseStat.nlink !== 1n
        || movedLeaseStat.dev.toString() !== plan.leaseDev || movedLeaseStat.ino.toString() !== plan.leaseIno
        || movedLease.nonce !== plan.leaseNonce || movedLease.pid !== plan.leasePid || movedLease.createdAt !== plan.leaseCreatedAt) return;
      // Windows may release Chromium profile handles just after process-tree exit.
      // Node's bounded filesystem retry applies only to this already quarantined,
      // identity-verified directory and never broadens the deletion target.
      await fs.promises.rm(quarantine, { recursive: true, maxRetries: 10, retryDelay: 50 });
    } else {
      const released = path.join(identityPath, `.guardian-released-${plan.leaseNonce}`);
      fs.renameSync(plan.leasePath, released);
      fs.unlinkSync(released);
    }
  } catch {
    // Refuse mutation on any identity/path mismatch. The next doctor can recover
    // the exact stale lease explicitly after proving the recorded owner PID absent.
  }
}

async function renameAfterBrowserExit(source: string, destination: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await fs.promises.rename(source, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw error;
      if (attempt === 99) throw error;
      // Windows can report the terminated browser's profile handles briefly after
      // taskkill has confirmed the process tree. This bounded retry is specific to
      // the exact identity-bound rename and never changes the cleanup target.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
}

function send(message: Readonly<Record<string, unknown>>): void {
  if (process.connected) process.send?.(message);
}

function fatal(code: string): void {
  send({ type: "guardian_error", code });
  process.exit(1);
}
