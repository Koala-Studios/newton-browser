import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type BrowserPreference = "auto" | "chrome" | "edge";

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_CONFIG_KEYS = 64;
const CONFIG_KEYS = new Set(["browser"]);

export function configDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NEWTON_BROWSER_CONFIG_DIR !== undefined) return resolveConfigDirectory(env.NEWTON_BROWSER_CONFIG_DIR);
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (process.platform === "win32") {
    return resolveConfigDirectory(path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "NewtonBrowser"));
  }
  if (process.platform === "darwin") return resolveConfigDirectory(path.join(home, "Library", "Application Support", "NewtonBrowser"));
  return resolveConfigDirectory(path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "newton-browser"));
}

export function resolveConfigDirectory(value: string): string {
  if (typeof value !== "string" || !value || value.length > 32_768 || value.includes("\0") || !path.isAbsolute(value)) {
    throw new Error("config_invalid");
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Error("config_invalid");
  return resolved;
}

export function ensureConfigDirectory(directory: string = configDirectory()): string {
  const resolved = resolveConfigDirectory(directory);
  try {
    if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    fs.chmodSync(resolved, 0o700);
  } catch {
    throw new Error("config_invalid");
  }
  return resolved;
}

export function profileStoreDirectory(
  env: NodeJS.ProcessEnv = process.env,
  directory: string = configDirectory(env),
): string {
  const configured = env.NEWTON_BROWSER_PROFILE_STORE_DIR;
  if (configured !== undefined && (!configured || configured.length > 32_768 || configured.includes("\0") || !path.isAbsolute(configured))) {
    throw new Error("config_invalid");
  }
  const resolved = path.resolve(configured ?? path.join(resolveConfigDirectory(directory), "identities"));
  if (resolved === path.parse(resolved).root) throw new Error("config_invalid");
  return resolved;
}

export function loadBrowserPreference(input: { directory?: string; env?: NodeJS.ProcessEnv } = {}): BrowserPreference {
  const env = input.env ?? process.env;
  const directory = resolveConfigDirectory(input.directory ?? configDirectory(env));
  const override = env.NEWTON_BROWSER_BROWSER;
  if (override !== undefined) return parseBrowserPreference(override, "NEWTON_BROWSER_BROWSER");
  const configured = readConfigObject(directory).browser;
  return configured === undefined ? "auto" : parseBrowserPreference(configured, "config.json browser");
}

export function writeBrowserPreference(input: {
  directory?: string;
  browser: "chrome" | "edge";
}): Readonly<{ browser: "chrome" | "edge" }> {
  if (input.browser !== "chrome" && input.browser !== "edge") throw new Error("config_invalid");
  const directory = resolveConfigDirectory(input.directory ?? configDirectory());
  ensureConfigDirectory(directory);
  readConfigObject(directory);
  writeConfigObject(directory, Object.freeze({ browser: input.browser }));
  return Object.freeze({ browser: input.browser });
}

function writeConfigObject(directory: string, next: Readonly<Record<string, unknown>>): void {
  if (Object.keys(next).length > MAX_CONFIG_KEYS) throw new Error("config_invalid");
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_CONFIG_BYTES) throw new Error("config_invalid");
  const file = path.join(directory, "config.json");
  const temporary = path.join(directory, `.config.${process.pid}.${randomBytes(16).toString("hex")}.tmp`);
  const displaced = path.join(directory, `.config.${process.pid}.${randomBytes(16).toString("hex")}.old`);
  let handle: number | undefined;
  let displacedExisting = false;
  try {
    handle = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(handle, serialized, "utf8");
    fs.fsyncSync(handle);
    fs.fchmodSync(handle, 0o600);
    fs.closeSync(handle);
    handle = undefined;
    if (fs.existsSync(file)) {
      fs.renameSync(file, displaced);
      displacedExisting = true;
    }
    fs.renameSync(temporary, file);
    if (displacedExisting) {
      fs.rmSync(displaced);
      displacedExisting = false;
    }
  } catch {
    if (handle !== undefined) try { fs.closeSync(handle); } catch { /* cleanup below */ }
    try { fs.rmSync(temporary, { force: true }); } catch { /* bounded caller error */ }
    if (displacedExisting && fs.existsSync(displaced)) {
      if (fs.existsSync(file)) {
        try { fs.rmSync(file); } catch { /* restoration attempted below */ }
      }
      if (!fs.existsSync(file)) {
        try { fs.renameSync(displaced, file); } catch { /* bounded caller error */ }
      }
    }
    throw new Error("config_write_failed");
  }
}

function parseBrowserPreference(value: unknown, label: string): BrowserPreference {
  if (value === "auto" || value === "chrome" || value === "edge") return value;
  throw new Error(`invalid_config: ${label} must be auto, chrome, or edge`);
}

function readConfigObject(directory: string): Record<string, unknown> {
  const file = path.join(directory, "config.json");
  if (!fs.existsSync(file)) return {};
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_CONFIG_BYTES) throw new Error();
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > MAX_CONFIG_KEYS
      || Object.keys(value).some((key) => !CONFIG_KEYS.has(key))) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error("config_invalid");
  }
}
