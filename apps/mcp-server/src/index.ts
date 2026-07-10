import { pathToFileURL } from "node:url";

import { handleUtilityCommand } from "./cli.ts";
import { startNewtonBrowserMcpServer } from "./mcp-server.ts";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (!(await handleUtilityCommand(process.argv.slice(2)))) {
    const configuredPort = process.env.NEWTON_BROWSER_PORT ? Number(process.env.NEWTON_BROWSER_PORT) : undefined;
    await startNewtonBrowserMcpServer({
      port: Number.isFinite(configuredPort) ? configuredPort : undefined,
      host: "127.0.0.1",
    });
  }
}
