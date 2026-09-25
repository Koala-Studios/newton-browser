import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Unix socket paths are capped by sun_path (104 bytes on macOS, 108 on Linux,
 * including the terminator). The configuration directory is too deep for that
 * on both, so endpoints live in the user's private runtime directory. The
 * advertisement file, which carries the authentication token, stays in config. */
const SUN_PATH_BYTES = process.platform === "darwin" ? 104 : 108;

export async function nativeSocketEndpoint(epoch: string): Promise<string> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(epoch)) throw new Error("native_advertisement_invalid");
  if (process.platform === "win32") return `\\\\.\\pipe\\newton-browser-${epoch}`;
  const endpoint = path.join(await privateRuntimeDirectory(), `nb-${epoch.replaceAll("-", "")}.sock`);
  if (Buffer.byteLength(endpoint) >= SUN_PATH_BYTES) throw new Error("native_endpoint_path_too_long");
  return endpoint;
}

async function privateRuntimeDirectory(): Promise<string> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("native_directory_invalid");
  const runtime = process.platform === "linux" ? process.env.XDG_RUNTIME_DIR : undefined;
  if (runtime && path.isAbsolute(runtime)) return verifiedPrivateDirectory(runtime, uid);
  if (process.platform === "darwin") return verifiedPrivateDirectory(os.tmpdir(), uid);
  const fallback = path.join("/tmp", `newton-browser-${uid}`);
  await fs.mkdir(fallback, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  return verifiedPrivateDirectory(fallback, uid);
}

async function verifiedPrivateDirectory(candidate: string, uid: number): Promise<string> {
  const real = await fs.realpath(candidate);
  const stat = await fs.lstat(real);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) throw new Error("native_directory_invalid");
  return real;
}
