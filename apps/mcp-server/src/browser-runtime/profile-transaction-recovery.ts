import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { listNewtonIdentities, ownerIsLive, type ProfileStore } from "./profile-store.ts";

export const STORE_TRANSACTION_STALE_MS = 120_000;

/** Recover a dead copy/create transaction from metadata only; never inspect browser files. */
export function recoverProfileTransaction(store: ProfileStore): "available" | "busy" | "recovered" {
  listNewtonIdentities(store); // Validates the registered store capability and its marker.
  const filename = path.join(store.root, ".newton-browser-profile-store.lock");
  if (!fs.existsSync(filename)) return "available";
  const stat = fs.lstatSync(filename, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 4096n) throw new Error("profile_transaction_invalid");
  const lock = JSON.parse(fs.readFileSync(filename, "utf8"));
  const owner = JSON.parse(fs.readFileSync(path.join(store.root, ".newton-browser-profile-store"), "utf8"));
  if (lock.version !== 1 || !Number.isSafeInteger(lock.pid) || lock.pid <= 0 || !/^[a-f0-9]{64}$/.test(lock.nonce) || lock.storeNonce !== owner.nonce) throw new Error("profile_transaction_invalid");
  // Store transactions are short and a copy is killed after 60 s, so another sandbox's lock older than
  // STORE_TRANSACTION_STALE_MS belongs to a dead host. A same-namespace owner is probed by PID.
  if (ownerIsLive({ pid: lock.pid, pidNamespace: lock.pidNamespace, createdAt: lock.createdAt ?? new Date(Number(stat.mtimeMs)).toISOString() }, STORE_TRANSACTION_STALE_MS)) return "busy";
  const claimed = path.join(store.root, `.recovering-${randomUUID()}`);
  fs.renameSync(filename, claimed);
  const after = fs.lstatSync(claimed, { bigint: true });
  if (after.dev !== stat.dev || after.ino !== stat.ino || JSON.parse(fs.readFileSync(claimed, "utf8")).nonce !== lock.nonce) throw new Error("profile_transaction_changed");
  // Only staging identities with this exact dead creator and this store's marker qualify.
  for (const name of fs.readdirSync(store.root)) {
    if (!/^\.staging-nbi_[a-f0-9]{32}-[a-zA-Z0-9]+$/.test(name)) continue;
    const directory = path.join(store.root, name), markerFile = path.join(directory, ".newton-browser-profile-identity");
    const directoryStat = fs.lstatSync(directory, { bigint: true });
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !fs.existsSync(markerFile)) continue;
    const markerStat = fs.lstatSync(markerFile);
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1 || markerStat.size > 4096) continue;
    const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
    if (marker.ownerPid !== lock.pid || (marker.ownerPidNamespace ?? null) !== (lock.pidNamespace ?? null) || marker.storeNonce !== owner.nonce || marker.type !== "identity"
      || marker.dev !== String(directoryStat.dev) || marker.ino !== String(directoryStat.ino)) continue;
    if (path.dirname(fs.realpathSync.native(directory)) !== store.root) throw new Error("profile_transaction_path_changed");
    fs.rmSync(directory, { recursive: true });
  }
  fs.unlinkSync(claimed);
  return "recovered";
}
