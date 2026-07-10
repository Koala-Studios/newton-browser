import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_BROWSER_HOST_POLICIES, type BrowserHostPolicyManifest, normalizeOrigin } from "@newton-browser/core";

export type PairingConfig = {
  version: 1;
  secret: string;
};

export type TransportAuthMode = "local_trust" | "paired";
export type BrowserTarget = "auto" | "chrome" | "edge";

export function configDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NEWTON_BROWSER_CONFIG_DIR) return path.resolve(env.NEWTON_BROWSER_CONFIG_DIR);
  if (process.platform === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, "NewtonBrowser");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "NewtonBrowser");
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "newton-browser");
}

export function loadOrCreatePairingConfig(input: { directory?: string } = {}): PairingConfig {
  const directory = path.resolve(input.directory ?? configDirectory());
  const file = path.join(directory, "pairing.json");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) return parsePairingConfig(fs.readFileSync(file, "utf8"), file);
  const value: PairingConfig = { version: 1, secret: randomBytes(32).toString("base64url") };
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (!fs.existsSync(file)) throw error;
    return parsePairingConfig(fs.readFileSync(file, "utf8"), file);
  }
  return value;
}

export function doctorToken(secret: string): string {
  return createHmac("sha256", secret).update("newton-browser-doctor-v1").digest("base64url");
}

export function validDoctorToken(secret: string, value: unknown): boolean {
  if (typeof value !== "string") return false;
  const expected = Buffer.from(doctorToken(secret));
  const actual = Buffer.from(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function loadTransportAuthMode(input: { directory?: string; env?: NodeJS.ProcessEnv } = {}): TransportAuthMode {
  const env = input.env ?? process.env;
  const override = env.NEWTON_BROWSER_AUTH_MODE;
  if (override !== undefined) return parseTransportAuthMode(override, "NEWTON_BROWSER_AUTH_MODE");
  const directory = path.resolve(input.directory ?? configDirectory(env));
  const file = path.join(directory, "config.json");
  if (!fs.existsSync(file)) return "local_trust";
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`invalid_config: ${file} is not valid JSON`);
  }
  const configured = (raw as { transportAuth?: unknown })?.transportAuth;
  return configured === undefined ? "local_trust" : parseTransportAuthMode(configured, `${file} transportAuth`);
}

export function loadBrowserTarget(input: { directory?: string; env?: NodeJS.ProcessEnv } = {}): BrowserTarget {
  const env = input.env ?? process.env;
  const override = env.NEWTON_BROWSER_BROWSER;
  if (override !== undefined) return parseBrowserTarget(override, "NEWTON_BROWSER_BROWSER");
  const directory = path.resolve(input.directory ?? configDirectory(env));
  const file = path.join(directory, "config.json");
  if (!fs.existsSync(file)) return "auto";
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`invalid_config: ${file} is not valid JSON`);
  }
  const configured = (raw as { browserTarget?: unknown })?.browserTarget;
  return configured === undefined ? "auto" : parseBrowserTarget(configured, `${file} browserTarget`);
}

export function loadHostPolicies(input: { directory?: string } = {}): BrowserHostPolicyManifest[] {
  const directory = path.resolve(input.directory ?? configDirectory());
  const file = path.join(directory, "config.json");
  if (!fs.existsSync(file)) return DEFAULT_BROWSER_HOST_POLICIES;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`invalid_config: ${file} is not valid JSON`);
  }
  const entries = (raw as { hostPolicies?: unknown })?.hostPolicies;
  if (entries === undefined) return DEFAULT_BROWSER_HOST_POLICIES;
  if (!Array.isArray(entries)) throw new Error(`invalid_config: ${file} hostPolicies must be an array`);
  const custom = entries.map((entry, index) => validateHostPolicy(entry, `${file} hostPolicies[${index}]`));
  const merged = new Map(DEFAULT_BROWSER_HOST_POLICIES.map((policy) => [policy.label ?? policy.origins.join("|"), policy]));
  for (const policy of custom) merged.set(policy.label ?? policy.origins.join("|"), policy);
  return [...merged.values()];
}

function parsePairingConfig(text: string, file: string): PairingConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`invalid_config: ${file} is not valid JSON`);
  }
  if (!value || typeof value !== "object" || (value as PairingConfig).version !== 1 || !/^[A-Za-z0-9_-]{43}$/.test((value as PairingConfig).secret)) {
    throw new Error(`invalid_config: ${file} does not contain a valid v1 pairing secret`);
  }
  return value as PairingConfig;
}

function parseTransportAuthMode(value: unknown, label: string): TransportAuthMode {
  if (value === "local_trust" || value === "paired") return value;
  throw new Error(`invalid_config: ${label} must be local_trust or paired`);
}

function parseBrowserTarget(value: unknown, label: string): BrowserTarget {
  if (value === "auto" || value === "chrome" || value === "edge") return value;
  throw new Error(`invalid_config: ${label} must be auto, chrome, or edge`);
}

function validateHostPolicy(value: unknown, label: string): BrowserHostPolicyManifest {
  if (!value || typeof value !== "object" || !Array.isArray((value as BrowserHostPolicyManifest).origins)) {
    throw new Error(`invalid_config: ${label} must contain origins`);
  }
  const input = value as BrowserHostPolicyManifest;
  const origins = input.origins.map((origin) => normalizeOrigin(origin)).filter(Boolean);
  if (origins.length === 0 || origins.length !== input.origins.length) throw new Error(`invalid_config: ${label} contains an invalid origin`);
  const commitRules = Array.isArray(input.commitRules) ? input.commitRules.filter((rule) =>
    rule && typeof rule === "object" && ["commit", "external_effect"].includes(rule.effect),
  ) : [];
  if (commitRules.length !== (input.commitRules?.length ?? 0)) throw new Error(`invalid_config: ${label} contains an invalid commit rule`);
  const sensitiveZones = Array.isArray(input.sensitiveZones) ? input.sensitiveZones.filter((zone) =>
    zone && typeof zone === "object" && [zone.selector, zone.name, zone.label].some((item) => typeof item === "string" && item.trim()),
  ) : [];
  if (sensitiveZones.length !== (input.sensitiveZones?.length ?? 0)) throw new Error(`invalid_config: ${label} contains an invalid sensitive zone`);
  return { ...input, origins, commitRules, sensitiveZones };
}
