import { createDefaultDirectBrowserHost } from "./browser-runtime/default-direct-host.ts";
import { dispatchIdentityCommand } from "./browser-runtime/identity-cli.ts";
import { createProfileSourceClosureVerifier } from "./browser-runtime/profile-closure.ts";
import { openProfileStore } from "./browser-runtime/profile-store.ts";
import {
  runDirectIdentityLogin,
  runDirectLiveDoctor,
  setupDirectBrowser,
} from "./browser-runtime/direct-setup-cli.ts";
import { configDirectory, ensureConfigDirectory, profileStoreDirectory, resolveConfigDirectory } from "./config.ts";
import { INSTALL_CLIENTS, type InstallClient, runInstall } from "./install.ts";
import { MAX_MCP_IN_FLIGHT_REQUESTS, MAX_MCP_LINE_BYTES, MODERN_MCP_PROTOCOL_VERSION } from "./modern-mcp-stdio.ts";

const PACKAGE_METADATA = packageMetadata();
export const NEWTON_BROWSER_VERSION = PACKAGE_METADATA.version;
const MINIMUM_NODE_RANGE = PACKAGE_METADATA.nodeRange;
const MINIMUM_NODE_MAJOR = PACKAGE_METADATA.nodeMajor;

export async function handleUtilityCommand(args: string[]): Promise<boolean> {
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    process.stdout.write(`${utilityHelp()}\n`);
    return true;
  }
  if (args[0] === "setup") {
    const flags = parseUtilityFlags(args.slice(1), new Set(["--browser"]));
    const browser = flags.single("--browser");
    if (browser !== "chrome" && browser !== "edge") throw utilityError("direct_setup_invalid_arguments");
    const output = setupDirectBrowser({ browserFamily: browser });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return true;
  }
  if (args[0] === "doctor") {
    if (args.length > 2 || (args.length === 2 && args[1] !== "--live")) throw utilityError("direct_doctor_invalid_arguments");
    const report = args[1] === "--live" ? await runDirectLiveDoctor() : await collectDoctorReport();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return true;
  }
  if (args[0] === "identity") {
    const identityArgs = args.slice(1);
    if (identityArgs.length === 1 && (identityArgs[0] === "--help" || identityArgs[0] === "-h" || identityArgs[0] === "help")) {
      process.stdout.write(`${identityHelp()}\n`);
      return true;
    }
    const identityDirectory = ensureConfigDirectory(configDirectory());
    if (identityArgs[0] === "login") {
      const id = identityArgs[1];
      if (!id || id.startsWith("--")) throw utilityError("identity_login_invalid_arguments");
      const flags = parseUtilityFlags(identityArgs.slice(2), new Set(["--origin", "--allow-origin"]), new Set(["--allow-origin"]));
      const origin = flags.single("--origin");
      if (!id || !origin) throw utilityError("identity_login_invalid_arguments");
      const output = await runDirectIdentityLogin({
        identityId: id,
        origin,
        allowedOrigins: flags.many("--allow-origin"),
        directory: identityDirectory,
        onReady: (receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`),
      });
      process.stdout.write(`${JSON.stringify(output)}\n`);
      return true;
    }
    const browserFamily = identityImportBrowserFamily(identityArgs);
    const output = dispatchIdentityCommand({
      store: openProfileStore(profileStoreDirectory(process.env, identityDirectory)),
      ...(browserFamily ? { sourceClosureVerifier: createProfileSourceClosureVerifier({ browserFamily }) } : {}),
      leaseRecoveryVerifier: (family) => createProfileSourceClosureVerifier({ browserFamily: family }),
    }, identityArgs);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return true;
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    process.stdout.write(`${NEWTON_BROWSER_VERSION}\n`);
    return true;
  }
  if (args[0] === "install" && args.length >= 2) {
    process.stdout.write(`${runInstallCommand(args.slice(1))}\n`);
    return true;
  }
  return false;
}

function identityHelp(): string {
  return [
    "Newton Browser identities (operator-only)",
    "",
    "  newton-browser identity create --browser <chrome|edge>",
    "  newton-browser identity list",
    "  newton-browser identity login <identity-id> --origin <origin> [--allow-origin <origin>]",
    "  newton-browser identity import --browser <chrome|edge> --user-data-root <path> --profile-directory <name>",
    "  newton-browser identity lease-inspect --id <identity-id>",
    "  newton-browser identity lease-recover --id <identity-id>",
    "  newton-browser identity delete --id <identity-id>",
  ].join("\n");
}

function utilityHelp(): string {
  return [
    `Newton Browser ${NEWTON_BROWSER_VERSION}`,
    "",
    "Optional browser preference:",
    "  newton-browser setup --browser <chrome|edge>",
    "",
    "Optional persistent identity:",
    "  newton-browser identity create --browser <chrome|edge>",
    "  newton-browser identity login <identity-id> --origin <https-origin> [--allow-origin <https-origin>]",
    "  newton-browser doctor --live",
    "",
    "MCP client setup:",
    "  newton-browser install <codex|generic> [--dry-run] [--force]",
    "",
    "Diagnostics:",
    "  newton-browser doctor [--live]",
    "  newton-browser --version",
  ].join("\n");
}

function packageMetadata(): Readonly<{ version: string; nodeRange: string; nodeMajor: number }> {
  const parsed: unknown = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const manifest = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
  const version = manifest?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error("invalid_package_version");
  }
  const engines = manifest?.engines;
  const nodeRange = engines && typeof engines === "object" && !Array.isArray(engines)
    ? (engines as Record<string, unknown>).node
    : undefined;
  const match = typeof nodeRange === "string" ? /^>=(\d+)\.0\.0$/u.exec(nodeRange) : null;
  const nodeMajor = match ? Number(match[1]) : Number.NaN;
  if (typeof nodeRange !== "string" || !match || !Number.isSafeInteger(nodeMajor) || nodeMajor < 1) throw new Error("invalid_package_node_engine");
  return Object.freeze({ version, nodeRange, nodeMajor });
}

function parseUtilityFlags(
  args: readonly string[],
  allowed: ReadonlySet<string>,
  repeated: ReadonlySet<string> = new Set(),
): Readonly<{ single(name: string): string | undefined; many(name: string): readonly string[] }> {
  if (!Array.isArray(args) || args.length > 68 || args.length % 2 !== 0) throw utilityError("utility_invalid_arguments");
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !value || !allowed.has(name) || value.length > 32_768 || value.includes("\0")) {
      throw utilityError("utility_invalid_arguments");
    }
    const current = values.get(name) ?? [];
    if (current.length > 0 && !repeated.has(name)) throw utilityError("utility_invalid_arguments");
    current.push(value);
    values.set(name, current);
  }
  return Object.freeze({
    single(name: string) {
      const current = values.get(name) ?? [];
      if (current.length > 1) throw utilityError("utility_invalid_arguments");
      return current[0];
    },
    many(name: string) { return Object.freeze([...(values.get(name) ?? [])]); },
  });
}

function utilityError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function identityImportBrowserFamily(args: readonly string[]): "chrome" | "edge" | null {
  if (args[0] !== "import") return null;
  const index = args.indexOf("--browser");
  const value = index >= 0 ? args[index + 1] : undefined;
  return value === "chrome" || value === "edge" ? value : null;
}

function runInstallCommand(args: string[]): string {
  const client = args[0] as InstallClient | undefined;
  if (!client || !INSTALL_CLIENTS.includes(client)) {
    throw new Error(`invalid_install_target: expected one of ${INSTALL_CLIENTS.join(", ")}`);
  }
  const flags = args.slice(1);
  if (flags.some((flag) => flag !== "--dry-run" && flag !== "--force") || new Set(flags).size !== flags.length) {
    throw utilityError("invalid_install_arguments");
  }
  const dryRun = flags.includes("--dry-run");
  const force = flags.includes("--force");
  const result = runInstall({ client, dryRun, force });
  const lines: string[] = [];
  if (result.action === "manual") {
    lines.push(result.message, "", result.manualCommand ?? "");
    return lines.join("\n").trimEnd();
  }
  if (result.action === "conflict") {
    lines.push(result.message);
    return lines.join("\n");
  }
  if (dryRun) {
    lines.push(`Dry run - no files changed. Planned: ${result.message}`);
    if (result.path) lines.push(`Target: ${result.path}`);
    if (result.nextContent) lines.push("", "--- proposed file ---", result.nextContent.trimEnd());
    return lines.join("\n");
  }
  lines.push(result.message);
  if (result.backupPath) lines.push(`Backed up the previous file to ${result.backupPath}.`);
  lines.push("Restart the client to pick up the new server.");
  return lines.join("\n");
}

export async function collectDoctorReport(input: { directory?: string; env?: NodeJS.ProcessEnv } = {}) {
  const env = input.env ?? process.env;
  const directory = resolveConfigDirectory(input.directory ?? configDirectory(env));
  return collectDirectDoctorReport(directory, env);
}

async function collectDirectDoctorReport(directory: string, env: NodeJS.ProcessEnv) {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  let host: ReturnType<typeof createDefaultDirectBrowserHost> | null = null;
  let runtimeErrorCode: string | null = null;
  try {
    host = createDefaultDirectBrowserHost({
      ...env,
      NEWTON_BROWSER_CONFIG_DIR: directory,
    });
  } catch (error) {
    runtimeErrorCode = safeUtilityCode(error, "direct_runtime_unavailable");
  }
  const configured = host?.getStatus().configured === true;
  if (host) await host.close().catch(() => { runtimeErrorCode = "direct_cleanup_uncertain"; });
  return {
    ok: nodeMajor >= MINIMUM_NODE_MAJOR && configured && runtimeErrorCode === null,
    ready: configured && runtimeErrorCode === null,
    version: NEWTON_BROWSER_VERSION,
    architecture: "owned_process_private_cdp",
    checks: {
      node: { ok: nodeMajor >= MINIMUM_NODE_MAJOR, version: process.version, required: MINIMUM_NODE_RANGE },
      directConfiguration: { ok: configured && runtimeErrorCode === null, ...(runtimeErrorCode ? { errorCode: runtimeErrorCode } : {}) },
      directRuntime: { checked: false, state: "not_started" },
      protocol: { ok: true, supported: [MODERN_MCP_PROTOCOL_VERSION], stateless: true },
      framing: {
        ok: true,
        mode: "newline_delimited_json",
        lineBytes: MAX_MCP_LINE_BYTES,
        inFlightRequests: MAX_MCP_IN_FLIGHT_REQUESTS,
      },
    },
    nextAction: configured && runtimeErrorCode === null ? "run_doctor_live" : "fix_direct_runtime_configuration",
    note: "Ready means Newton can start an isolated session; no browser process is kept alive while idle.",
  };
}

function safeUtilityCode(error: unknown, fallback: string): string {
  const value = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : error instanceof Error ? error.message : "";
  return /^[a-z][a-z0-9_]{0,79}$/u.test(value) ? value : fallback;
}

import fs from "node:fs";
