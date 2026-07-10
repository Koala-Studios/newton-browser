import net from "node:net";

import { configDirectory, doctorToken, loadBrowserTarget, loadHostPolicies, loadOrCreatePairingConfig, loadTransportAuthMode } from "./config.ts";

export const BROWSER_BRIDGE_VERSION = "0.3.0";
export const SUPPORTED_MCP_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"] as const;

export async function handleUtilityCommand(args: string[]): Promise<boolean> {
  if (args.includes("--version")) {
    process.stdout.write(`${BROWSER_BRIDGE_VERSION}\n`);
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
  return false;
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
    ok: nodeMajor >= 24 && loopbackOk,
    ready: extensionConnected,
    version: BROWSER_BRIDGE_VERSION,
    configDirectory: directory,
    authMode,
    browserTarget,
    pairingState: authMode === "paired" ? "configured" : "not_required",
    ...(authMode === "paired" ? { pairingSecret: pairing.secret } : {}),
    checks: {
      node: { ok: nodeMajor >= 24, version: process.version, required: ">=24.0.0" },
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
      headers: { "X-Browser-Bridge-Doctor": token },
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
  const command = "npx";
  const packageSpec = process.env.BROWSER_BRIDGE_PACKAGE_SPEC || `browser-bridge-mcp@${BROWSER_BRIDGE_VERSION}`;
  const args = ["--yes", "--package", packageSpec, "browser-bridge-mcp"];
  if (target === "codex") {
    return [
      "[mcp_servers.browser-bridge]",
      `command = ${JSON.stringify(command)}`,
      `args = [${args.map((value) => JSON.stringify(value)).join(", ")}]`,
    ].join("\n");
  }
  const server = { command, args };
  if (target === "generic") return JSON.stringify(server, null, 2);
  if (target === "claude-desktop" || target === "claude-code") {
    return JSON.stringify({ mcpServers: { "browser-bridge": server } }, null, 2);
  }
  throw new Error("invalid_config_target: expected codex, claude-desktop, claude-code, or generic");
}
