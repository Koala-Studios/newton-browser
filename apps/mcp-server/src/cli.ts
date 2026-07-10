import { configDirectory, loadOrCreatePairingConfig } from "./config.ts";

export const BROWSER_BRIDGE_VERSION = "0.1.0";
export const SUPPORTED_MCP_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-11-25"] as const;

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
    const pairing = loadOrCreatePairingConfig();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      version: BROWSER_BRIDGE_VERSION,
      node: process.version,
      configDirectory: configDirectory(),
      pairingState: "configured",
      pairingSecret: pairing.secret,
      note: "Paste this secret into the extension popup once. Do not share or record it.",
    }, null, 2)}\n`);
    return true;
  }
  return false;
}

function printConfig(target: string | undefined): string {
  const command = "npx";
  const args = ["--yes", `browser-bridge-mcp@${BROWSER_BRIDGE_VERSION}`];
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
