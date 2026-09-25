import path from "node:path";

import { ensureConfigDirectory, configDirectory, loadBrowserPreference, profileStoreDirectory } from "../config.ts";
import { discoverBrowserExecutable, type BrowserFamily } from "./browser-discovery.ts";
import { collectOrphanedIdentities, openProfileStore } from "./profile-store.ts";
import fs from "node:fs";
import { LoginSource } from "./login-source.ts";
import { startEgressProxy, type EgressProxy } from "./egress-proxy.ts";
import { EngineHost, ownedEngineConnection, engineConnectionFromRuntime, type ExistingPageRequest, type LoginMaintenance } from "./engine-host.ts";
import type { BrowserDisplay } from "./chromium-process.ts";
import { connectExistingTab,createExistingTab,discoverExistingBrowser,discoverExistingDirectory,nativeAdvertisements,existingConnectionId } from "../existing-connection.ts";

export function createDefaultEngineHost(env: NodeJS.ProcessEnv = process.env): EngineHost {
  const directory = configDirectory(env);
  ensureConfigDirectory(directory);
  const browser = loadBrowserPreference({ directory, env });
  const store = openProfileStore(profileStoreDirectory(env, directory));
  const sourceRoot = path.join(directory, "login-sources");
  const configuredSource = env.NEWTON_BROWSER_LOGIN_SOURCE;
  const advertisement = env.NEWTON_BROWSER_NATIVE_ADVERTISEMENT;
  // A hosted deployment limits owned browsers to public internet addresses.
  if (env.NEWTON_BROWSER_EGRESS !== undefined && env.NEWTON_BROWSER_EGRESS !== "public") throw new Error("configured_egress_invalid");
  let egress: Promise<EgressProxy> | undefined;
  const proxyServer = async () => {
    if (env.NEWTON_BROWSER_EGRESS !== "public") return undefined;
    egress ??= startEgressProxy();
    return (await egress).proxyServer;
  };

  const connect = async (sourceId?: string, display?: BrowserDisplay) => {
    const family = resolveFamily(browser, env);
    const executable = discoverBrowserExecutable({family,...(env.NEWTON_BROWSER_BROWSER_EXECUTABLE?{explicitPath:env.NEWTON_BROWSER_BROWSER_EXECUTABLE}:{}),env});
    if(!executable)throw new Error('configured_browser_unavailable');
    const source = await LoginSource.open(store, sourceRoot, sourceId ?? configuredSource ?? "default", family);
    const clone = await source.clone();
    const proxy = await proxyServer();
    return ownedEngineConnection({
      ...(proxy ? { proxyServer: proxy } : {}),
      executablePath: executable.path,
      browserFamily: family,
      profileStore: store,
      identityId: clone.identity.id,
      ephemeralIdentity: true,
      headless: true,
      ...(display ? { display } : {}),
    });
  };

  const connectionsDirectory=path.join(directory,'tab-adapter-native','connections');
  const connectExisting = async (input: ExistingPageRequest) => {
    const files=advertisement?[advertisement]:await nativeAdvertisements(connectionsDirectory);
    const matches=input.connectionId?files.filter(file=>existingConnectionId(file)===input.connectionId):files;
    if(matches.length!==1)throw new Error(matches.length?'browser_connection_required':'browser_instance_changed');
    return input.tabId===undefined?createExistingTab(matches[0]!,input.instanceId):connectExistingTab(matches[0]!,input.tabId,input.instanceId);
  };
  // Sign-in for a shared login source runs as an ordinary session; Done publishes, anything else cancels.
  const maintenance: LoginMaintenance = { async begin(sourceId, display) {
    const family = resolveFamily(browser, env);
    const executable = discoverBrowserExecutable({family,...(env.NEWTON_BROWSER_BROWSER_EXECUTABLE?{explicitPath:env.NEWTON_BROWSER_BROWSER_EXECUTABLE}:{}),env});
    if(!executable)throw new Error('configured_browser_unavailable');
    const source = await LoginSource.open(store, sourceRoot, sourceId, family);
    const runtime = await source.beginMaintenance(executable.path, true, display, await proxyServer());
    return { connection: engineConnectionFromRuntime(runtime), async finish(publish) {
      if (!publish) { await source.cancelMaintenance(runtime); return undefined; }
      return { generation: (await source.publish(runtime)).generation };
    } };
  } };
  return new EngineHost(connect,connectExisting,advertisement?()=>discoverExistingBrowser(advertisement):()=>discoverExistingDirectory(connectionsDirectory),maintenance);
}

/**
 * Removes session copies of the shared login that a crashed host left behind. `liveNamespaces` are
 * the PID namespaces of every host that may still be running sessions on this store; login-source
 * generations are always kept. For stores used only through login sources.
 */
export function collectOrphanedSessionCopies(env: NodeJS.ProcessEnv, liveNamespaces: readonly string[]): number {
  const directory = configDirectory(env);
  const store = openProfileStore(profileStoreDirectory(env, directory));
  const keep = new Set<string>();
  const sourceRoot = path.join(directory, "login-sources");
  for (const source of fs.existsSync(sourceRoot) ? fs.readdirSync(sourceRoot, { withFileTypes: true }) : []) {
    if (!source.isDirectory() || source.isSymbolicLink()) continue;
    for (const name of fs.readdirSync(path.join(sourceRoot, source.name))) {
      if (!name.endsWith(".json")) continue;
      try {
        const metadata = JSON.parse(fs.readFileSync(path.join(sourceRoot, source.name, name), "utf8")) as { identityId?: unknown };
        if (typeof metadata.identityId === "string") keep.add(metadata.identityId);
      } catch { /* not generation metadata */ }
    }
  }
  return collectOrphanedIdentities(store, { keep, liveNamespaces: new Set(liveNamespaces), unleasedStaleAfterMs: 30 * 60_000 });
}

function resolveFamily(preference: "auto" | BrowserFamily, env: NodeJS.ProcessEnv): BrowserFamily {
  if (preference !== "auto") return preference;
  if (env.NEWTON_BROWSER_BROWSER_EXECUTABLE) throw new Error("configured_browser_family_required");
  if (discoverBrowserExecutable({ family: "chrome", env })) return "chrome";
  if (discoverBrowserExecutable({ family: "edge", env })) return "edge";
  throw new Error("configured_browser_unavailable");
}
