import { pathToFileURL } from "node:url";

import { handleUtilityCommand } from "./cli.ts";
import { startBrowserBridgeMcpServer } from "./mcp-server.ts";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (!(await handleUtilityCommand(process.argv.slice(2)))) {
    const configuredPort = process.env.BROWSER_BRIDGE_PORT ? Number(process.env.BROWSER_BRIDGE_PORT) : undefined;
    await startBrowserBridgeMcpServer({
      port: Number.isFinite(configuredPort) ? configuredPort : undefined,
      host: "127.0.0.1",
    });
  }
}
