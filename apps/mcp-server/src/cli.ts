import path from "node:path";

import { createDefaultDirectBrowserHost } from "./browser-runtime/default-direct-host.ts";
import { dispatchIdentityCommand } from "./browser-runtime/identity-cli.ts";
import { createProfileSourceClosureVerifier } from "./browser-runtime/profile-closure.ts";
import { openProfileStore } from "./browser-runtime/profile-store.ts";
import {
  runDirectIdentityLogin,
  runDirectLiveDoctor,
  setupDirectBrowser,
} from "./browser-runtime/direct-setup-cli.ts";
import { configDirectory } from "./config.ts";
import { INSTALL_CLIENTS, type InstallClient, runInstall, serverInvocation } from "./install.ts";
import { MAX_MCP_BODY_BYTES, MAX_MCP_BUFFER_BYTES, MAX_MCP_HEADER_BYTES } from "./mcp-frame-parser.ts";

export const NEWTON_BROWSER_VERSION = "0.4.5";
export const SUPPORTED_MCP_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"] as const;

// Runtime floor for the published package. The dev workspace still requires Node 24
// (see root package.json engines) because tests type-strip TypeScript sources, but the
// compiled `dist` targets Node 20 (see scripts/build-mcp.mjs) so end users on current
// LTS can run the host through npx.
export const MINIMUM_NODE_MAJOR = 20;
export const MINIMUM_NODE_RANGE = ">=20.0.0";

export async function handleUtilityCommand(args: string[]): Promise<boolean> {
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    process.stdout.write(`${utilityHelp()}\n`);
    return true;
  }
  if (args[0] === "setup") {
    const flags = parseUtilityFlags(args.slice(1), new Set(["--browser", "--identity"]));
    const browser = flags.single("--browser");
    if (browser !== "chrome" && browser !== "edge") throw utilityError("direct_setup_invalid_arguments");
    const identityId = flags.single("--identity");
    const output = setupDirectBrowser({ browserFamily: browser, ...(identityId ? { identityId } : {}) });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return true;
  }
  if (args[0] === "doctor") {
    if (args.length !== 2 || args[1] !== "--live") throw utilityError("direct_doctor_invalid_arguments");
    process.stdout.write(`${JSON.stringify(await runDirectLiveDoctor(), null, 2)}\n`);
    return true;
  }
  if (args[0] === "identity") {
    const identityArgs = args.slice(1);
    if (identityArgs.length === 1 && (identityArgs[0] === "--help" || identityArgs[0] === "-h" || identityArgs[0] === "help")) {
      process.stdout.write(`${identityHelp()}\n`);
      return true;
    }
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
        onReady: (receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`),
      });
      process.stdout.write(`${JSON.stringify(output)}\n`);
      return true;
    }
    const browserFamily = identityImportBrowserFamily(identityArgs);
    const output = dispatchIdentityCommand({
      store: openProfileStore(path.join(configDirectory(), "identities")),
      ...(browserFamily ? { sourceClosureVerifier: createProfileSourceClosureVerifier({ browserFamily }) } : {}),
      leaseRecoveryVerifier: (family) => createProfileSourceClosureVerifier({ browserFamily: family }),
    }, identityArgs);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return true;
  }
  if (args.includes("--version")) {
    process.stdout.write(`${NEWTON_BROWSER_VERSION}\n`);
    return true;
  }
  const configIndex = args.indexOf("--print-config");
  if (configIndex >= 0) {
    const target = args[configIndex + 1];
    process.stdout.write(`${printConfig(target)}\n`);
    return true;
  }
  if (args.includes("--doctor")) {
    process.stdout.write(`${JSON.stringify(await collectDoctorReport(), null, 2)}\n`);
    return true;
  }
  const installIndex = args.indexOf("--install");
  if (installIndex >= 0) {
    process.stdout.write(`${runInstallCommand(args, installIndex)}\n`);
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
    "Newton Browser 0.4.5",
    "",
    "Direct browser runtime:",
    "  newton-browser setup --browser <chrome|edge> [--identity <identity-id>]",
    "  newton-browser identity login <identity-id> --origin <https-origin> [--allow-origin <https-origin>]",
    "  newton-browser doctor --live",
    "",
    "MCP client setup:",
    "  newton-browser --install <codex|claude-desktop|claude-code> [--dry-run] [--force]",
    "  newton-browser --print-config <codex|claude-desktop|claude-code|generic>",
    "",
    "Diagnostics:",
    "  newton-browser --doctor",
    "  newton-browser --version",
  ].join("\n");
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

function runInstallCommand(args: string[], installIndex: number): string {
  const client = args[installIndex + 1] as InstallClient | undefined;
  if (!client || !INSTALL_CLIENTS.includes(client)) {
    throw new Error(`invalid_install_target: expected one of ${INSTALL_CLIENTS.join(", ")}`);
  }
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
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
    lines.push(`Dry run — no files changed. Planned: ${result.message}`);
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
  const directory = input.directory ?? configDirectory(env);
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
    ready: false,
    version: NEWTON_BROWSER_VERSION,
    architecture: "owned_process_private_cdp",
    checks: {
      node: { ok: nodeMajor >= MINIMUM_NODE_MAJOR, version: process.version, required: MINIMUM_NODE_RANGE },
      config: { ok: true },
      directConfiguration: { ok: configured && runtimeErrorCode === null, ...(runtimeErrorCode ? { errorCode: runtimeErrorCode } : {}) },
      directRuntime: { checked: false, state: "not_started" },
      protocol: { ok: true, supported: [...SUPPORTED_MCP_PROTOCOLS] },
      framing: {
        ok: true,
        headerBytes: MAX_MCP_HEADER_BYTES,
        bodyBytes: MAX_MCP_BODY_BYTES,
        bufferBytes: MAX_MCP_BUFFER_BYTES,
        bufferedBytes: 0,
      },
    },
    nextAction: configured && runtimeErrorCode === null ? "start_direct_session_to_verify_runtime" : "fix_direct_runtime_configuration",
    note: "Direct configuration is valid. Runtime readiness is established only after an owned browser session starts.",
  };
}

function safeUtilityCode(error: unknown, fallback: string): string {
  const value = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : error instanceof Error ? error.message : "";
  return /^[a-z][a-z0-9_]{0,79}$/u.test(value) ? value : fallback;
}

function printConfig(target: string | undefined): string {
  const { command, args } = serverInvocation();
  if (target === "codex") {
    return [
      "[mcp_servers.newton-browser]",
      `command = ${JSON.stringify(command)}`,
      `args = [${args.map((value) => JSON.stringify(value)).join(", ")}]`,
    ].join("\n");
  }
  const server = { command, args };
  if (target === "generic") return JSON.stringify(server, null, 2);
  if (target === "claude-desktop" || target === "claude-code") {
    return JSON.stringify({ mcpServers: { "newton-browser": server } }, null, 2);
  }
  throw new Error("invalid_config_target: expected codex, claude-desktop, claude-code, or generic");
}
