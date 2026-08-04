import { pathToFileURL } from "node:url";

import { handleUtilityCommand } from "./cli.ts";
import { startNewtonBrowserMcpServer } from "./mcp-server.ts";
import { runPersistentMcpClient, runPersistentMcpDaemon } from "./persistent-mcp.ts";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const daemonIndex = process.argv.indexOf("--daemon-socket");
  const clientIndex = process.argv.indexOf("--connect-socket");
  if (daemonIndex >= 0 && clientIndex >= 0) throw new Error("persistent_mcp_mode_conflict");
  if (daemonIndex >= 0) {
    await runPersistentMcpDaemon(process.argv[daemonIndex + 1] ?? "");
  } else if (clientIndex >= 0) {
    await runPersistentMcpClient(process.argv[clientIndex + 1] ?? "");
  } else {
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
}
