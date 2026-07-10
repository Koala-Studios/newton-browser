import { pathToFileURL } from "node:url";

import { handleUtilityCommand } from "./cli.ts";
import { startNewtonBrowserMcpServer } from "./mcp-server.ts";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let handled = false;
  try {
    handled = await handleUtilityCommand(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  if (!handled) {
    const configuredPort = process.env.NEWTON_BROWSER_PORT ? Number(process.env.NEWTON_BROWSER_PORT) : undefined;
    await startNewtonBrowserMcpServer({
      port: Number.isFinite(configuredPort) ? configuredPort : undefined,
      host: "127.0.0.1",
    });
  }
}
