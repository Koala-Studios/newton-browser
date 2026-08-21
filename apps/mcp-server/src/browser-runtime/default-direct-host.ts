import { configDirectory, ensureConfigDirectory, loadDirectConfiguration, profileStoreDirectory } from "../config.ts";
import { discoverBrowserExecutable, type BrowserFamily } from "./browser-discovery.ts";
import { createConfiguredDirectBrowserHost } from "./configured-direct-host.ts";
import { createIdentityLeaseClosureVerifier } from "./identity-lease-closure.ts";

export function createDefaultDirectBrowserHost(env: NodeJS.ProcessEnv = process.env) {
  const directory = configDirectory(env);
  ensureConfigDirectory(directory);
  const configuration = loadDirectConfiguration({ directory, env });
  const explicitPath = env.NEWTON_BROWSER_BROWSER_EXECUTABLE;
  const browserFamily = resolveBrowserFamily(configuration.browser, explicitPath, env);
  return createConfiguredDirectBrowserHost({
    env,
    profileStoreRoot: profileStoreDirectory(env, directory),
    browserFamily,
    hostPolicies: configuration.hostPolicies,
    identityBindings: configuration.identityBindings,
    identityLeaseRecoveryVerifier: (family) => createIdentityLeaseClosureVerifier({ browserFamily: family }),
    ...(explicitPath ? { executablePath: explicitPath } : {}),
  });
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
