import http from "node:http";

import { createConfiguredDirectBrowserHost } from "../../apps/mcp-server/src/browser-runtime/configured-direct-host.ts";
import { launchOwnedBrowserRuntime } from "../../apps/mcp-server/src/browser-runtime/owned-browser-runtime.ts";

const family = process.env.NEWTON_BROWSER_QA_BROWSER === "edge" ? "edge" : "chrome";
const storeRoot = process.env.NEWTON_BROWSER_PROFILE_STORE_DIR;
if (!storeRoot) throw new Error("direct_hard_crash_store_required");

const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>Crash guardian fixture</title><main>guardian-ready</main>");
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("direct_hard_crash_fixture_failed");
const origin = `http://127.0.0.1:${address.port}`;
let browserPid = 0;
let ephemeralIdentity = false;
const host = createConfiguredDirectBrowserHost({
  profileStoreRoot: storeRoot,
  browserFamily: family,
  headless: false,
  launchRuntime: async (options) => {
    ephemeralIdentity = options.ephemeralIdentity === true;
    const runtime = await launchOwnedBrowserRuntime(options);
    browserPid = runtime.receipt.pid;
    return runtime;
  },
});
const created = host.createSession({
  origin,
  allowedOrigins: [origin],
});
await host.waitForSessionReady(created.sessionId, 30_000);
if (!Number.isSafeInteger(browserPid) || browserPid <= 0 || !ephemeralIdentity) throw new Error("direct_hard_crash_pid_missing");
process.send?.({ type: "ready", browserPid, ephemeralIdentity: true });

// The parent deliberately terminates this process without invoking host.close().
// The open IPC channel and fixture server keep the worker alive until then.
