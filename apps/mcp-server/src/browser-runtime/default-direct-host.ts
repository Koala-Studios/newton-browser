import fs from "node:fs";
import path from "node:path";

import { configDirectory, loadBrowserTarget, loadDirectBrowserConfig } from "../config.ts";
import { discoverBrowserExecutable, type BrowserFamily } from "./browser-discovery.ts";
import { createConfiguredDirectBrowserHost } from "./configured-direct-host.ts";

export function createDefaultDirectBrowserHost(env: NodeJS.ProcessEnv = process.env) {
  const directory = configDirectory(env);
  ensurePlainConfigDirectory(directory);
  const target = loadBrowserTarget({ directory, env });
  const configured = loadDirectBrowserConfig({ directory, env });
  const explicitPath = env.NEWTON_BROWSER_BROWSER_EXECUTABLE;
  const browserFamily = resolveBrowserFamily(target, explicitPath, env);
  return createConfiguredDirectBrowserHost({
    env,
    profileStoreRoot: env.NEWTON_BROWSER_PROFILE_STORE_DIR || path.join(directory, "identities"),
    browserFamily,
    ...(configured ? { identityId: configured.identityId } : {}),
    ...(explicitPath ? { executablePath: explicitPath } : {}),
  });
}

function ensurePlainConfigDirectory(directory: string): void {
  try {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid");
    fs.chmodSync(directory, 0o700);
  } catch {
    throw Object.assign(new Error("configured_profile_store_invalid"), { code: "configured_profile_store_invalid" });
  }
}

function resolveBrowserFamily(
  target: "auto" | BrowserFamily,
  explicitPath: string | undefined,
  env: NodeJS.ProcessEnv,
): BrowserFamily {
  if (target !== "auto") return target;
  if (explicitPath) {
    throw Object.assign(new Error("configured_browser_family_required"), { code: "configured_browser_family_required" });
  }
  if (discoverBrowserExecutable({ family: "chrome", env })) return "chrome";
  if (discoverBrowserExecutable({ family: "edge", env })) return "edge";
  throw Object.assign(new Error("configured_browser_unavailable"), { code: "configured_browser_unavailable" });
}
