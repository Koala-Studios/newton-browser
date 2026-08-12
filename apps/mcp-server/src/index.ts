import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { handleUtilityCommand } from "./cli.ts";
import { startNewtonBrowserMcpServer } from "./mcp-server.ts";
import { runPersistentMcpClient, runPersistentMcpDaemon } from "./persistent-mcp.ts";

if (isMainModule(import.meta.url, process.argv[1])) {
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
    if (!handled) await startNewtonBrowserMcpServer();
  }
}

function isMainModule(moduleUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  try {
    return moduleUrl === pathToFileURL(fs.realpathSync(argvEntry)).href;
  } catch {
    return moduleUrl === pathToFileURL(argvEntry).href;
  }
}
