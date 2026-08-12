import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_BROWSER_HOST_POLICIES, type BrowserHostPolicyManifest, normalizeHttpOrigin } from "@newton-browser/core";

export type BrowserTarget = "auto" | "chrome" | "edge";

export type DirectBrowserConfig = Readonly<{
  browserTarget: "chrome" | "edge";
  identityId: string;
}>;

const IDENTITY_PATTERN = /^nbi_[a-f0-9]{32}$/u;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_CONFIG_KEYS = 64;

export function configDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NEWTON_BROWSER_CONFIG_DIR) return path.resolve(env.NEWTON_BROWSER_CONFIG_DIR);
  if (process.platform === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, "NewtonBrowser");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "NewtonBrowser");
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "newton-browser");
}

export function loadBrowserTarget(input: { directory?: string; env?: NodeJS.ProcessEnv } = {}): BrowserTarget {
  const env = input.env ?? process.env;
  const override = env.NEWTON_BROWSER_BROWSER;
  if (override !== undefined) return parseBrowserTarget(override, "NEWTON_BROWSER_BROWSER");
  const directory = path.resolve(input.directory ?? configDirectory(env));
  const configured = readConfigObject(directory).browserTarget;
  return configured === undefined ? "auto" : parseBrowserTarget(configured, "config.json browserTarget");
}

export function loadDirectBrowserConfig(input: { directory?: string; env?: NodeJS.ProcessEnv } = {}): DirectBrowserConfig | null {
  const env = input.env ?? process.env;
  const directory = path.resolve(input.directory ?? configDirectory(env));
  const config = readConfigObject(directory);
  const browserTarget = env.NEWTON_BROWSER_BROWSER ?? config.browserTarget;
  const identityId = env.NEWTON_BROWSER_IDENTITY_ID ?? config.identityId;
  if (identityId === undefined) return null;
  if ((browserTarget !== "chrome" && browserTarget !== "edge")
    || typeof identityId !== "string" || !IDENTITY_PATTERN.test(identityId)) {
    throw new Error("direct_config_invalid");
  }
  return Object.freeze({ browserTarget, identityId });
}

export function writeDirectBrowserConfig(input: {
  directory?: string;
  browserTarget: "chrome" | "edge";
  identityId: string;
}): DirectBrowserConfig {
  if ((input.browserTarget !== "chrome" && input.browserTarget !== "edge")
    || !IDENTITY_PATTERN.test(input.identityId)) throw new Error("direct_config_invalid");
  const directory = path.resolve(input.directory ?? configDirectory());
  ensurePlainConfigDirectory(directory);
  const current = readConfigObject(directory);
  const next = Object.freeze({
    ...(current.hostPolicies !== undefined ? { hostPolicies: current.hostPolicies } : {}),
    browserTarget: input.browserTarget,
    identityId: input.identityId,
  });
  if (Object.keys(next).length > MAX_CONFIG_KEYS) throw new Error("direct_config_invalid");
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_CONFIG_BYTES) throw new Error("direct_config_invalid");
  const file = path.join(directory, "config.json");
  const temporary = path.join(directory, `.config.${process.pid}.${randomBytes(16).toString("hex")}.tmp`);
  let handle: number | undefined;
  try {
    handle = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(handle, serialized, "utf8");
    fs.fsyncSync(handle);
    fs.fchmodSync(handle, 0o600);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temporary, file);
  } catch {
    if (handle !== undefined) try { fs.closeSync(handle); } catch { /* cleanup below */ }
    try { fs.rmSync(temporary, { force: true }); } catch { /* bounded caller error */ }
    throw new Error("direct_config_write_failed");
  }
  return Object.freeze({ browserTarget: input.browserTarget, identityId: input.identityId });
}

export function loadHostPolicies(input: { directory?: string } = {}): BrowserHostPolicyManifest[] {
  const directory = path.resolve(input.directory ?? configDirectory());
  const file = path.join(directory, "config.json");
  const entries = readConfigObject(directory).hostPolicies;
  if (entries === undefined) return DEFAULT_BROWSER_HOST_POLICIES;
  if (!Array.isArray(entries) || entries.length > 64) throw new Error(`invalid_config: ${file} hostPolicies must be a bounded array`);
  const custom = entries.map((entry, index) => validateHostPolicy(entry, `${file} hostPolicies[${index}]`));
  const merged = new Map(DEFAULT_BROWSER_HOST_POLICIES.map((policy) => [policy.label ?? policy.origins.join("|"), policy]));
  for (const policy of custom) merged.set(policy.label ?? policy.origins.join("|"), policy);
  return [...merged.values()];
}

function parseBrowserTarget(value: unknown, label: string): BrowserTarget {
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
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > MAX_CONFIG_KEYS) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error("direct_config_invalid");
  }
}

function ensurePlainConfigDirectory(directory: string): void {
  try {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    fs.chmodSync(directory, 0o700);
  } catch {
    throw new Error("direct_config_invalid");
  }
}

function validateHostPolicy(value: unknown, label: string): BrowserHostPolicyManifest {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as BrowserHostPolicyManifest).origins)) {
    throw new Error(`invalid_config: ${label} must contain origins`);
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["origins", "label", "routeClass", "defaultForUnmatched", "commitRules", "sensitiveZones"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error(`invalid_config: ${label} contains an unsupported field`);
  const rawOrigins = input.origins as unknown[];
  if (rawOrigins.length === 0 || rawOrigins.length > 32) throw new Error(`invalid_config: ${label} contains an invalid origin`);
  const origins = rawOrigins.map(normalizeHttpOrigin);
  if (origins.some((origin) => !origin) || new Set(origins).size !== origins.length) throw new Error(`invalid_config: ${label} contains an invalid origin`);
  const policyLabel = optionalBoundedString(input.label, 120, `${label} label`);
  const routeClass = input.routeClass;
  if (routeClass !== undefined && !["app", "auth_wall", "billing", "editor"].includes(String(routeClass))) {
    throw new Error(`invalid_config: ${label} contains an invalid route class`);
  }
  const defaultForUnmatched = input.defaultForUnmatched;
  if (defaultForUnmatched !== undefined && defaultForUnmatched !== "conservative" && defaultForUnmatched !== "agentic") {
    throw new Error(`invalid_config: ${label} contains an invalid default`);
  }
  const commitRules = normalizeCommitRules(input.commitRules, label);
  const sensitiveZones = normalizeSensitiveZones(input.sensitiveZones, label);
  return {
    origins,
    ...(policyLabel ? { label: policyLabel } : {}),
    ...(routeClass ? { routeClass: routeClass as "app" | "auth_wall" | "billing" | "editor" } : {}),
    ...(defaultForUnmatched ? { defaultForUnmatched: defaultForUnmatched as "conservative" | "agentic" } : {}),
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
