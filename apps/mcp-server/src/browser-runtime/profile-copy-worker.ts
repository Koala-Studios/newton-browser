import { acquireNewtonIdentityLease, importOpaqueProfile, listNewtonIdentities, openProfileStore, prepareOpaqueProfileSource, releaseNewtonIdentityLease, validateNewtonIdentityLease } from "./profile-store.ts";
import { watch, existsSync } from "node:fs";
import path from "node:path";

// Retry only failure to acquire the store mutex: the operation has not run yet.
// In particular, retain the lease capability until release actually succeeds.
export async function withAvailableStore<T>(root: string, operation: () => T): Promise<T> {
  const deadline = performance.now() + 55_000;
  for (;;) {
    try { return operation(); } catch (error) {
      if (!(error instanceof Error) || error.message !== "profile_store_busy") throw error;
      if (performance.now() >= deadline) throw new Error("profile_store_timeout");
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => { clearTimeout(timer); watcher.close(); error ? reject(error) : resolve(); };
        const check = () => { if (!existsSync(path.join(root, ".newton-browser-profile-store.lock"))) finish(); };
        const watcher = watch(root, check);
        const timer = setTimeout(() => finish(new Error("profile_store_timeout")), Math.max(1, deadline - performance.now()));
        watcher.on("error", finish);
        check();
      });
    }
  }
}

// Receives only identity IDs and store paths, never profile values. All copying stays opaque.
if (process.send) process.once("message", async (raw: unknown) => {
  const workerData = raw as { storeRoot: string; identityId: string };
  try {
    const store = openProfileStore(workerData.storeRoot);
    const identity = listNewtonIdentities(store).find(value => value.id === workerData.identityId);
    if (!identity) throw new Error("profile_identity_missing");
    const lease = await withAvailableStore(store.root, () => acquireNewtonIdentityLease(store, identity.id));
    let copied;
    try {
      const source = prepareOpaqueProfileSource({ browserFamily: identity.browserFamily, userDataRoot: identity.path, profileDirectory: "Default",
        verifyClosed: input => input.userDataRoot === identity.path && input.profileDirectory === "Default" && validateNewtonIdentityLease(lease, identity.path) });
      copied = await withAvailableStore(store.root, () => importOpaqueProfile(store, { source }));
    } finally { await withAvailableStore(store.root, () => releaseNewtonIdentityLease(lease)); }
    process.send!({ ok: true, identity: copied });
  } catch (error) {
    const busy = error instanceof Error && ["profile_identity_busy", "profile_store_busy"].includes(error.message);
    process.send!({ ok: false, errorCode: busy ? "profile_copy_busy" : "profile_copy_failed" });
  }
  finally { process.disconnect(); }
});
