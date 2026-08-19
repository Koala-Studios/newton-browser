import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { handleUtilityCommand, NEWTON_BROWSER_VERSION } from "./cli.ts";
import { startNewtonBrowserMcpServer } from "./mcp-server.ts";

if (isMainModule(import.meta.url, process.argv[1])) {
  const expectedVersion = process.env.NEWTON_BROWSER_EXPECTED_VERSION;
  if (expectedVersion !== undefined && expectedVersion !== NEWTON_BROWSER_VERSION) {
    process.stderr.write("newton_browser_version_mismatch\n");
    process.exit(1);
  }
  let handled = false;
  try {
    handled = await handleUtilityCommand(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  if (!handled) await startNewtonBrowserMcpServer();
}

function isMainModule(moduleUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  try {
    return moduleUrl === pathToFileURL(fs.realpathSync(argvEntry)).href;
  } catch {
    return moduleUrl === pathToFileURL(argvEntry).href;
  }
}
