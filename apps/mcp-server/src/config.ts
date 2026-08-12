import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type BrowserHostPolicyManifest, normalizeHttpOrigin } from "@newton-browser/core";

export type BrowserPreference = "auto" | "chrome" | "edge";
export type DirectConfiguration = Readonly<{
  browser: BrowserPreference;
  hostPolicies: readonly BrowserHostPolicyManifest[];
}>;

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_CONFIG_KEYS = 64;
const CONFIG_KEYS = new Set(["browser", "hostPolicies"]);

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
    throw new Error("direct_config_invalid");
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Error("direct_config_invalid");
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
    throw new Error("direct_config_invalid");
  }
  return resolved;
}

export function profileStoreDirectory(
  env: NodeJS.ProcessEnv = process.env,
  directory: string = configDirectory(env),
): string {
  const configured = env.NEWTON_BROWSER_PROFILE_STORE_DIR;
  if (configured !== undefined && (!configured || configured.length > 32_768 || configured.includes("\0") || !path.isAbsolute(configured))) {
    throw new Error("direct_config_invalid");
  }
  const resolved = path.resolve(configured ?? path.join(resolveConfigDirectory(directory), "identities"));
  if (resolved === path.parse(resolved).root) throw new Error("direct_config_invalid");
  return resolved;
}

export function loadBrowserPreference(input: { directory?: string; env?: NodeJS.ProcessEnv } = {}): BrowserPreference {
  return loadDirectConfiguration(input).browser;
}

export function loadDirectConfiguration(input: { directory?: string; env?: NodeJS.ProcessEnv } = {}): DirectConfiguration {
  const env = input.env ?? process.env;
  const directory = resolveConfigDirectory(input.directory ?? configDirectory(env));
  const file = path.join(directory, "config.json");
  const configured = readConfigObject(directory);
  const override = env.NEWTON_BROWSER_BROWSER;
  const browser = override === undefined
    ? configured.browser === undefined ? "auto" : parseBrowserPreference(configured.browser, "config.json browser")
    : parseBrowserPreference(override, "NEWTON_BROWSER_BROWSER");
  const hostPolicies = normalizeHostPolicies(configured.hostPolicies, file);
  return Object.freeze({ browser, hostPolicies: Object.freeze(hostPolicies) });
}

export function writeBrowserPreference(input: {
  directory?: string;
  browser: "chrome" | "edge";
}): Readonly<{ browser: "chrome" | "edge" }> {
  if (input.browser !== "chrome" && input.browser !== "edge") throw new Error("direct_config_invalid");
  const directory = resolveConfigDirectory(input.directory ?? configDirectory());
  ensureConfigDirectory(directory);
  const current = readConfigObject(directory);
  const hostPolicies = normalizeHostPolicies(current.hostPolicies, path.join(directory, "config.json"));
  const next = Object.freeze({
    ...(hostPolicies.length ? { hostPolicies } : {}),
    browser: input.browser,
  });
  if (Object.keys(next).length > MAX_CONFIG_KEYS) throw new Error("direct_config_invalid");
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_CONFIG_BYTES) throw new Error("direct_config_invalid");
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
    throw new Error("direct_config_write_failed");
  }
  return Object.freeze({ browser: input.browser });
}

export function loadHostPolicies(input: { directory?: string } = {}): BrowserHostPolicyManifest[] {
  return [...loadDirectConfiguration(input).hostPolicies];
}

function normalizeHostPolicies(entries: unknown, file: string): BrowserHostPolicyManifest[] {
  if (entries === undefined) return [];
  if (!Array.isArray(entries) || entries.length > 64) throw new Error(`invalid_config: ${file} hostPolicies must be a bounded array`);
  const policies = entries.map((entry, index) => validateHostPolicy(entry, `${file} hostPolicies[${index}]`));
  const origins = policies.flatMap((policy) => policy.origins);
  if (new Set(origins).size !== origins.length) throw new Error(`invalid_config: ${file} hostPolicies contain an overlapping origin`);
  return policies;
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
    throw new Error("direct_config_invalid");
  }
}

function validateHostPolicy(value: unknown, label: string): BrowserHostPolicyManifest {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as BrowserHostPolicyManifest).origins)) {
    throw new Error(`invalid_config: ${label} must contain origins`);
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["origins", "commitRules", "sensitiveZones"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error(`invalid_config: ${label} contains an unsupported field`);
  const rawOrigins = input.origins as unknown[];
  if (rawOrigins.length === 0 || rawOrigins.length > 32) throw new Error(`invalid_config: ${label} contains an invalid origin`);
  const origins = rawOrigins.map(normalizeHttpOrigin);
  if (origins.some((origin) => !origin) || new Set(origins).size !== origins.length) throw new Error(`invalid_config: ${label} contains an invalid origin`);
  const commitRules = normalizeCommitRules(input.commitRules, label);
  const sensitiveZones = normalizeSensitiveZones(input.sensitiveZones, label);
  return {
    origins,
    ...(commitRules.length ? { commitRules } : {}),
    ...(sensitiveZones.length ? { sensitiveZones } : {}),
  };
}

function normalizeCommitRules(value: unknown, label: string): NonNullable<BrowserHostPolicyManifest["commitRules"]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new Error(`invalid_config: ${label} contains an invalid commit rule`);
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`invalid_config: ${label} contains an invalid commit rule`);
    const rule = entry as Record<string, unknown>;
    if (Object.keys(rule).some((key) => !["match", "effect", "reason"].includes(key))
      || (rule.effect !== "commit" && rule.effect !== "external_effect")
      || !rule.match || typeof rule.match !== "object" || Array.isArray(rule.match)) {
      throw new Error(`invalid_config: ${label} contains an invalid commit rule`);
    }
    const rawMatch = rule.match as Record<string, unknown>;
    if (Object.keys(rawMatch).some((key) => !["role", "name", "testid", "selector"].includes(key))) {
      throw new Error(`invalid_config: ${label} contains an invalid commit rule`);
    }
    const match = Object.fromEntries(Object.entries(rawMatch).map(([key, item]) => [key, requiredBoundedString(item, 240, `${label} commit match`)]));
    if (Object.keys(match).length === 0) throw new Error(`invalid_config: ${label} contains an invalid commit rule`);
    const reason = optionalBoundedString(rule.reason, 120, `${label} commit reason`);
    return { match, effect: rule.effect, ...(reason ? { reason } : {}) };
  });
}

function normalizeSensitiveZones(value: unknown, label: string): NonNullable<BrowserHostPolicyManifest["sensitiveZones"]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new Error(`invalid_config: ${label} contains an invalid sensitive zone`);
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`invalid_config: ${label} contains an invalid sensitive zone`);
    const zone = entry as Record<string, unknown>;
    const keys = Object.keys(zone);
    if (keys.length !== 1 || !["selector", "name", "label"].includes(keys[0] ?? "")) {
      throw new Error(`invalid_config: ${label} contains an invalid sensitive zone`);
    }
    return { [keys[0]!]: requiredBoundedString(zone[keys[0]!], 240, `${label} sensitive zone`) };
  });
}

function optionalBoundedString(value: unknown, cap: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredBoundedString(value, cap, label);
}

function requiredBoundedString(value: unknown, cap: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > cap || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`invalid_config: ${label} is invalid`);
  }
  return value.trim();
}
