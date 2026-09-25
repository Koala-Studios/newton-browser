import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { configDirectory, ensureConfigDirectory, loadBrowserPreference, resolveConfigDirectory, writeBrowserPreference } from "../config.ts";
import { createBrowserEngine } from "../embedding.ts";
import { discoverBrowserExecutable, type BrowserFamily } from "./browser-discovery.ts";

export type BrowserSetupReceipt = Readonly<{ configured: true; browserFamily: BrowserFamily; transport: "stdio"; nextAction: "start_session" }>;
export type LiveDoctorReceipt = Readonly<{ configured: true; runtimeVerified: true; cleanupConfirmed: true; browserFamily: BrowserFamily; transport: "private_cdp_pipe" }>;

/** Records which installed browser owned sessions use. */
export function setupBrowser(input: { browserFamily: BrowserFamily; directory?: string; env?: NodeJS.ProcessEnv }): BrowserSetupReceipt {
  const env = input.env ?? process.env;
  const directory = resolveConfigDirectory(input.directory ?? configDirectory(env));
  if (input.browserFamily !== "chrome" && input.browserFamily !== "edge") fail("setup_invalid_arguments");
  try { ensureConfigDirectory(directory); } catch { fail("setup_failed"); }
  executableFor(input.browserFamily, env);
  try { writeBrowserPreference({ directory, browser: input.browserFamily }); } catch { fail("setup_failed"); }
  return Object.freeze({ configured: true, browserFamily: input.browserFamily, transport: "stdio", nextAction: "start_session" });
}

/** Starts one engine session on a loopback page in a throwaway store, observes it and proves cleanup. */
export async function runLiveDoctor(input: { directory?: string; env?: NodeJS.ProcessEnv } = {}): Promise<LiveDoctorReceipt> {
  const env = input.env ?? process.env;
  const directory = resolveConfigDirectory(input.directory ?? configDirectory(env));
  const preference = loadBrowserPreference({ directory, env });
  const browserFamily: BrowserFamily = preference === "auto" ? (discoverBrowserExecutable({ family: "chrome", env }) ? "chrome" : "edge") : preference;
  const executable = executableFor(browserFamily, env);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-doctor-"));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Newton Browser live doctor</title><main>ready</main>");
  });
  let cleanupConfirmed = false;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") fail("live_doctor_failed");
    writeBrowserPreference({ directory: root, browser: browserFamily });
    const engine = createBrowserEngine({ configDirectory: root, browserExecutable: executable, env: { ...env, NEWTON_BROWSER_EGRESS: undefined } });
    try {
      const started = json(await engine.start({ url: `http://127.0.0.1:${address.port}/` }));
      if (typeof started.sessionId !== "string") fail("live_doctor_start_failed");
      const observed = json(await engine.call("browser.observe", { sessionId: started.sessionId }));
      if (observed.errorCode) fail("live_doctor_observe_failed");
      await engine.stop(started.sessionId);
      if (engine.sessions().length !== 0) fail("live_doctor_session_residue");
    } finally { await engine.close(); }
    cleanupConfirmed = true;
  } catch (error) {
    throw error instanceof Error && /^[a-z][a-z0-9_]{0,79}$/u.test(error.message) ? error : new Error("live_doctor_failed");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (cleanupConfirmed) fs.rmSync(root, { recursive: true, force: true });
  }
  return Object.freeze({ configured: true, runtimeVerified: true, cleanupConfirmed: true, browserFamily, transport: "private_cdp_pipe" });
}

function executableFor(family: BrowserFamily, env: NodeJS.ProcessEnv): string {
  const executable = discoverBrowserExecutable({ family, ...(env.NEWTON_BROWSER_BROWSER_EXECUTABLE ? { explicitPath: env.NEWTON_BROWSER_BROWSER_EXECUTABLE } : {}), env });
  if (!executable) fail("browser_unavailable");
  return executable.path;
}

function json(result: { content: readonly { type: string; text?: string }[] }): Record<string, unknown> {
  const text = result.content.at(-1)?.text;
  try { return text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { return {}; }
}

function fail(code: string): never { throw new Error(code); }
