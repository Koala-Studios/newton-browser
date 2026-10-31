import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { handleUtilityCommand, NEWTON_BROWSER_VERSION } from "./cli.ts";
import { startNewtonBrowserMcpServer } from "./mcp-server.ts";

if (isMainModule(import.meta.url, process.argv[1])) {
  // Registrations from 0.7.23 and earlier pin the version they were made with. An in-place upgrade
  // left that pin stale and the server used to exit before the handshake, so the client only saw
  // "connection closed". The package that runs is the one installed at the registered path; a stale
  // pin is reported and the server starts.
  const registeredVersion = process.env.NEWTON_BROWSER_EXPECTED_VERSION;
  if (registeredVersion !== undefined && registeredVersion !== NEWTON_BROWSER_VERSION) {
    process.stderr.write(`newton_browser_registration_stale: registered with ${registeredVersion}, running ${NEWTON_BROWSER_VERSION}; rerun install <client> --force to refresh it\n`);
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
