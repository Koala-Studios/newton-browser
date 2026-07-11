import net from "node:net";

import { configDirectory, doctorToken, loadBrowserTarget, loadHostPolicies, loadOrCreatePairingConfig, loadTransportAuthMode } from "./config.ts";
import { INSTALL_CLIENTS, type InstallClient, runInstall, serverInvocation } from "./install.ts";

export const NEWTON_BROWSER_VERSION = "0.4.0";
export const SUPPORTED_MCP_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"] as const;

// Runtime floor for the published package. The dev workspace still requires Node 24
// (see root package.json engines) because tests type-strip TypeScript sources, but the
// compiled `dist` targets Node 20 (see scripts/build-mcp.mjs) so end users on current
// LTS can run the host through npx.
export const MINIMUM_NODE_MAJOR = 20;
export const MINIMUM_NODE_RANGE = ">=20.0.0";

export async function handleUtilityCommand(args: string[]): Promise<boolean> {
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

export async function collectDoctorReport(input: { directory?: string; firstPort?: number; lastPort?: number } = {}) {
  const directory = input.directory ?? configDirectory();
  const pairing = loadOrCreatePairingConfig({ directory });
  const authMode = loadTransportAuthMode({ directory });
  const browserTarget = loadBrowserTarget({ directory });
  const policies = loadHostPolicies({ directory });
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const firstPort = input.firstPort ?? 17321;
  const lastPort = input.lastPort ?? 17340;
  const token = doctorToken(pairing.secret);
  const ports = await Promise.all(Array.from({ length: lastPort - firstPort + 1 }, (_, index) => probePort(firstPort + index, token)));
  const incumbents = ports.flatMap((entry) => entry.host ? [entry.host] : []);
  const availablePort = ports.find((entry) => entry.available)?.port ?? null;
  const extensionConnected = incumbents.some((host) => host.extensionConnected === true);
  const extensionState = extensionConnected ? "connected" : incumbents.length ? "disconnected" : "no_running_host";
  const loopbackOk = incumbents.length > 0 || availablePort !== null;
  return {
    ok: nodeMajor >= MINIMUM_NODE_MAJOR && loopbackOk,
    ready: extensionConnected,
    version: NEWTON_BROWSER_VERSION,
    configDirectory: directory,
    authMode,
    browserTarget,
    pairingState: authMode === "paired" ? "configured" : "not_required",
    ...(authMode === "paired" ? { pairingSecret: pairing.secret } : {}),
    checks: {
      node: { ok: nodeMajor >= MINIMUM_NODE_MAJOR, version: process.version, required: MINIMUM_NODE_RANGE },
      config: { ok: true, hostPolicyCount: policies.length },
      loopback: { ok: loopbackOk, range: `${firstPort}-${lastPort}`, availablePort, incumbents },
      transportAuth: { ok: true, mode: authMode, pairingRequired: authMode === "paired" },
      browserSelection: { ok: true, target: browserTarget },
      pairing: { ok: true, state: authMode === "paired" ? "configured" : "not_required" },
      protocol: { ok: true, supported: [...SUPPORTED_MCP_PROTOCOLS] },
      extension: { ok: extensionConnected, state: extensionState },
    },
    nextAction: extensionConnected
      ? "ready"
      : incumbents.length
        ? authMode === "paired" ? "load_or_pair_extension" : "load_extension"
        : "start_or_restart_mcp_client_then_check_browser_status",
    note: authMode === "paired"
      ? "Hardened pairing is enabled. Paste this secret into the extension popup once. Do not share or record it."
      : "Zero-touch local trust is enabled. Load the extension; no pairing key is required.",
  };
}

async function probePort(port: number, token: string): Promise<{ port: number; available: boolean; host: null | Record<string, unknown> }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/doctor-status`, {
      headers: { "X-Newton-Browser-Doctor": token },
      signal: AbortSignal.timeout(250),
    });
    if (response.ok) return { port, available: false, host: await response.json() as Record<string, unknown> };
  } catch {
    // A free port or an unrelated listener is resolved by the bind probe below.
  }
  return { port, available: await canBind(port), host: null };
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const finish = (available: boolean) => server.close(() => resolve(available));
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => finish(true));
  });
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
