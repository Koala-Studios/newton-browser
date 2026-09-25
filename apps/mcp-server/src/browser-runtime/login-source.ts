import fs from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { BrowserDisplay } from "./chromium-process.ts";
import { createNewtonIdentity, inspectNewtonIdentityLease, recoverStaleNewtonIdentityLease, removeNewtonIdentity, type NewtonProfileIdentity, type ProfileStore } from "./profile-store.ts";
import { OwnedBrowserRuntime, launchOwnedBrowserRuntime } from "./owned-browser-runtime.ts";
import { recoverProfileTransaction } from "./profile-transaction-recovery.ts";
import { freshIdentityClosureVerifier } from "./async-closure.ts";

type Generation = Readonly<{ version: 1; sourceId: string; generation: string; identityId: string; browserFamily: "chrome" | "edge" }>;
let activeCopies = 0;

/** Immutable source identities are never launched. Only clones become writable browsers. */
export class LoginSource {
  private readonly store: ProfileStore;
  private readonly directory: string;
  private readonly sourceId: string;
  private readonly family: "chrome" | "edge";
  private readonly closedMaintenance = new WeakSet<OwnedBrowserRuntime>();
  private readonly maintenance = new WeakSet<OwnedBrowserRuntime>();
  private readonly maintenanceNonce = new WeakMap<OwnedBrowserRuntime, string>();
  private constructor(store: ProfileStore, directory: string, sourceId: string, family: "chrome" | "edge") {
    this.store = store; this.directory = directory; this.sourceId = sourceId; this.family = family;
  }
  static async open(store: ProfileStore, metadataRoot: string, sourceId: string, family: "chrome" | "edge"): Promise<LoginSource> {
    if (!/^[a-z0-9_-]{1,80}$/.test(sourceId)) throw new Error("source_invalid");
    await fs.mkdir(metadataRoot, { recursive: true, mode: 0o700 });
    const root = await fs.realpath(metadataRoot);
    const rootStat = await fs.lstat(metadataRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("source_invalid");
    recoverProfileTransaction(store);
    const directory = path.join(root, sourceId);
    try { await fs.mkdir(directory); await fs.writeFile(path.join(directory, "owner.json"), JSON.stringify({ version: 1, sourceId, storeRoot: store.root }), { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if ((await fs.lstat(directory)).isSymbolicLink() || await fs.realpath(directory) !== directory) throw new Error("source_invalid");
    const owner = await readMetadata(path.join(directory, "owner.json"));
    if (owner.sourceId !== sourceId || owner.storeRoot !== store.root || owner.version !== 1) throw new Error("source_invalid");
    return new LoginSource(store, directory, sourceId, family);
  }
  async clone(): Promise<{ identity: NewtonProfileIdentity; generation: string | null; authentication: "unknown" }> {
    const current = await this.current();
    if (!current) return { identity: createNewtonIdentity(this.store, { browserFamily: this.family }), generation: null, authentication: "unknown" };
    return { identity: await copyIdentity(this.store, current.identityId), generation: current.generation, authentication: "unknown" };
  }
  async status(): Promise<Readonly<{ sourceId: string; browserFamily: "chrome" | "edge"; generation: string | null; authentication: "unknown" }>> {
    const current = await this.current();
    return Object.freeze({ sourceId: this.sourceId, browserFamily: this.family, generation: current?.generation ?? null, authentication: "unknown" });
  }
  async beginMaintenance(executablePath: string, headless = true, display?: BrowserDisplay): Promise<OwnedBrowserRuntime> {
    const nonce = randomUUID(), filename = path.join(this.directory, "maintenance.lock");
    await durableWrite(filename, { version: 1, pid: process.pid, nonce });
    try {
      const { identity } = await this.clone();
      const runtime = await launchOwnedBrowserRuntime({ executablePath, browserFamily: this.family, profileStore: this.store, identityId: identity.id, headless, ...(display ? { display } : {}) });
      this.maintenance.add(runtime); this.maintenanceNonce.set(runtime, nonce);
      return runtime;
    } catch (error) {
      if ((await readMetadata(filename)).nonce === nonce) await fs.unlink(filename);
      throw error;
    }
  }
  async cancelMaintenance(runtime: OwnedBrowserRuntime): Promise<void> {
    if (!this.maintenance.has(runtime)) throw new Error("source_maintenance_invalid");
    await runtime.close(); await this.releaseMaintenance(runtime);
    this.removeMaintenanceIdentity(runtime);
  }
  /** The maintenance clone is only a staging copy; once closed, only the published generation remains. */
  private removeMaintenanceIdentity(runtime: OwnedBrowserRuntime): void {
    if (runtime.cleanupState() !== "closed" || inspectNewtonIdentityLease(this.store, runtime.receipt.identityId) !== "available") return;
    try { removeNewtonIdentity(this.store, runtime.receipt.identityId); } catch { /* collectRetired can remove it later */ }
  }
  /** Caller must supply the exact guardian-owned maintenance runtime; no boolean closure override. */
  async publish(runtime: OwnedBrowserRuntime, cutpoint?: (stage: string) => Promise<void>): Promise<Generation> {
    if (!(runtime instanceof OwnedBrowserRuntime) || !this.maintenance.has(runtime) || runtime.receipt.browserFamily !== this.family || this.closedMaintenance.has(runtime)) throw new Error("source_maintenance_invalid");
    await runtime.close();
    if (runtime.cleanupState() !== "closed" || inspectNewtonIdentityLease(this.store, runtime.receipt.identityId) !== "available") throw new Error("source_closure_unproved");
    const lockPath = path.join(this.directory, "publication.lock");
    const lock = await fs.open(lockPath, "wx");
    const nonce = randomUUID();
    await lock.writeFile(JSON.stringify({ version: 1, pid: process.pid, nonce })); await lock.sync();
    try {
      await cutpoint?.("before_copy");
      const identity = await copyIdentity(this.store, runtime.receipt.identityId);
      const generation: Generation = { version: 1, sourceId: this.sourceId, generation: randomUUID(), identityId: identity.id, browserFamily: this.family };
      // A complete journal entry precedes pointer replacement. A crash leaves the old pointer usable.
      await durableWrite(path.join(this.directory, `${generation.generation}.json`), generation);
      await cutpoint?.("generation_complete");
      const staged = path.join(this.directory, `pointer-${generation.generation}.json`);
      await durableWrite(staged, generation);
      await cutpoint?.("before_pointer");
      await fs.rename(staged, path.join(this.directory, "current.json"));
      await cutpoint?.("after_pointer");
      this.closedMaintenance.add(runtime);
      return Object.freeze(generation);
    } finally {
      await lock.close();
      const currentLock = await readMetadata(lockPath);
      if (currentLock.nonce !== nonce) throw new Error("source_lock_changed");
      await fs.unlink(lockPath);
      await this.releaseMaintenance(runtime);
      if (this.closedMaintenance.has(runtime)) this.removeMaintenanceIdentity(runtime);
    }
  }
  /** Recover only a dead publisher's own metadata lock. Never guess profile closure from it. */
  async recoverPublication(): Promise<"available" | "recovered"> {
    const publication = await this.recoverLock("publication.lock");
    const maintenance = await this.recoverLock("maintenance.lock");
    return publication === "recovered" || maintenance === "recovered" ? "recovered" : "available";
  }
  private async releaseMaintenance(runtime: OwnedBrowserRuntime): Promise<void> {
    const nonce = this.maintenanceNonce.get(runtime);
    const filename = path.join(this.directory, "maintenance.lock");
    if (!nonce || (await readMetadata(filename)).nonce !== nonce) throw new Error("source_lock_changed");
    await fs.unlink(filename); this.maintenance.delete(runtime); this.maintenanceNonce.delete(runtime);
  }
  private async recoverLock(name: string): Promise<"available" | "recovered"> {
    const lockPath = path.join(this.directory, name);
    let lock: Record<string, unknown>;
    try { lock = await readMetadata(lockPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "available"; throw error; }
    if (!Number.isSafeInteger(lock.pid) || Number(lock.pid) <= 0 || typeof lock.nonce !== "string") throw new Error("source_lock_invalid");
    try { process.kill(Number(lock.pid), 0); throw new Error("source_publisher_active"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    const recoveryPath = path.join(this.directory, `recovered-${lock.nonce}.json`);
    if (!/^[a-f0-9-]{36}$/.test(lock.nonce)) throw new Error("source_lock_invalid");
    await fs.rename(lockPath, recoveryPath);
    const claimed = await readMetadata(recoveryPath);
    if (claimed.nonce !== lock.nonce || claimed.pid !== lock.pid) throw new Error("source_lock_changed");
    await fs.unlink(recoveryPath);
    return "recovered";
  }
  async collectRetired(): Promise<number> {
    const lockPath = path.join(this.directory, "publication.lock");
    const lock = await fs.open(lockPath, "wx");
    const nonce = randomUUID();
    await lock.writeFile(JSON.stringify({ version: 1, pid: process.pid, nonce })); await lock.sync();
    try {
    const current = await this.current();
    if (!current) return 0;
    // Each clone holds the identity lease while copying. Removal checks it under the store lock.
    let removed = 0;
    for (const name of await fs.readdir(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name) || name === `${current.generation}.json`) continue;
      const metadata = await readMetadata(path.join(this.directory, name));
      if (metadata.sourceId !== this.sourceId || metadata.browserFamily !== this.family || typeof metadata.identityId !== "string") throw new Error("source_generation_invalid");
      if (inspectNewtonIdentityLease(this.store, metadata.identityId) !== "available") continue;
      removeNewtonIdentity(this.store, metadata.identityId);
      await fs.unlink(path.join(this.directory, name)); removed++;
    }
    return removed;
    } finally {
      await lock.close();
      if ((await readMetadata(lockPath)).nonce !== nonce) throw new Error("source_lock_changed");
      await fs.unlink(lockPath);
    }
  }
  private async current(): Promise<Generation | null> {
    let value: Record<string, unknown>;
    try { value = await readMetadata(path.join(this.directory, "current.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (value.version !== 1 || value.sourceId !== this.sourceId || value.browserFamily !== this.family
      || typeof value.generation !== "string" || !/^[a-f0-9-]{36}$/.test(value.generation)
      || typeof value.identityId !== "string" || !/^nbi_[a-f0-9]{32}$/.test(value.identityId)) throw new Error("source_generation_invalid");
    const completed = await readMetadata(path.join(this.directory, `${value.generation}.json`));
    if (JSON.stringify(completed) !== JSON.stringify(value)) throw new Error("source_generation_incomplete");
    return value as Generation;
  }
}
async function readMetadata(filename: string): Promise<Record<string, unknown>> {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("source_metadata_invalid");
  return JSON.parse(await fs.readFile(filename, "utf8"));
}
async function durableWrite(filename: string, value: unknown): Promise<void> {
  const handle = await fs.open(filename, "wx");
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
}
async function copyIdentity(store: ProfileStore, identityId: string): Promise<NewtonProfileIdentity> {
  const deadline = performance.now() + 60_000;
  for (;;) {
    try { return await copyIdentityAttempt(store, identityId); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== "source_copy_busy") throw error;
      await waitForCopyAvailability(store, identityId, deadline);
    }
  }
}
async function copyIdentityAttempt(store: ProfileStore, identityId: string): Promise<NewtonProfileIdentity> {
  if (activeCopies >= 4) throw new Error("source_copy_capacity");
  activeCopies++;
  const extension = fileURLToPath(import.meta.url).endsWith(".ts") ? "ts" : "js";
  try {
    return await new Promise((resolve, reject) => {
      const options = { stdio: ["ignore", "ignore", "ignore", "ipc"] as ["ignore", "ignore", "ignore", "ipc"], windowsHide: true };
      const worker = fork(fileURLToPath(new URL(`./profile-copy-worker.${extension}`, import.meta.url)), [], options);
      worker.send({ storeRoot: store.root, identityId });
      let received: { ok: boolean; identity?: NewtonProfileIdentity; errorCode?: string } | undefined;
      const timer = setTimeout(() => { worker.kill(); }, 60_000);
      worker.on("message", message => { received = message as typeof received; });
      worker.on("error", () => reject(new Error("source_copy_failed")));
      worker.on("exit", code => {
        clearTimeout(timer);
        if (received?.errorCode === "profile_copy_busy") { reject(new Error("source_copy_busy")); return; }
        if (!received?.ok || !received.identity || code !== 0) {
          void (async () => {
            recoverProfileTransaction(store);
            if (inspectNewtonIdentityLease(store, identityId) !== "available") {
              const family = (await fs.readFile(path.join(store.root, identityId, ".newton-browser-profile.json"), "utf8"));
              recoverStaleNewtonIdentityLease(store, identityId, await freshIdentityClosureVerifier(JSON.parse(family).browserFamily));
            }
          })().then(() => reject(new Error("source_copy_failed")), () => reject(new Error("source_copy_cleanup_uncertain")));
        } else resolve(received.identity);
      });
    });
  } finally { activeCopies--; }
}
async function waitForCopyAvailability(store: ProfileStore, identityId: string, deadline: number): Promise<void> {
  if (performance.now() >= deadline) throw new Error("source_copy_timeout");
  const leasePath = path.join(store.root, identityId, ".newton-browser-profile-lease");
  const storeLock = path.join(store.root, ".newton-browser-profile-store.lock");
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const watchers: ReturnType<typeof watch>[] = [];
    const end = (error?: Error) => {
      if (finished) return; finished = true; clearTimeout(timer); watchers.forEach(watcher => watcher.close());
      if (error) reject(error); else resolve();
    };
    const exists = async (filename: string) => { try { await fs.lstat(filename); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } };
    const check = () => { void Promise.all([exists(leasePath), exists(storeLock)]).then(present => { if (present.every(value => !value)) end(); }, () => end(new Error("source_copy_unavailable"))); };
    const timer = setTimeout(() => end(new Error("source_copy_timeout")), Math.max(1, deadline - performance.now()));
    try {
      for (const directory of [store.root, path.join(store.root, identityId)]) {
        const watcher = watch(directory, check); watcher.on("error", () => end(new Error("source_copy_unavailable"))); watchers.push(watcher);
      }
      check();
    } catch { end(new Error("source_copy_unavailable")); }
  });
}
