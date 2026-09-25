// Supported library entry for a host process that embeds the engine (for example a
// task runner). The host owns processes, credentials and the operator channel; the
// model only ever sees `call` results. Nothing here spawns a CLI.
import { EngineError } from "@newton-browser/core";
import { collectOrphanedSessionCopies, createDefaultEngineHost } from "./browser-runtime/default-engine-host.ts";
import type { EngineHost } from "./browser-runtime/engine-host.ts";
import { handleEngineMcp, ENGINE_TOOL_CATALOG } from "./engine-mcp.ts";
import type { EngineFrame, EngineFrameOptions, EngineOperatorInput, EngineSessionEvent, EngineWebAuthnCredential } from "@newton-browser/driver/session-live";

export type { EngineFrame, EngineFrameOptions, EngineOperatorInput, EngineSessionEvent, EngineWebAuthnCredential };
export type BrowserEngineOptions = Readonly<{
  /** Private directory for identities, login sources and engine state. */
  configDirectory: string;
  /** Chrome or Edge executable; discovered when omitted. */
  browserExecutable?: string;
  /** Login source every owned session clones unless the call names another. */
  loginSource?: string;
  env?: NodeJS.ProcessEnv;
}>;
export type BrowserToolResult = Readonly<{ content: readonly ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean }>;
export type BrowserSessionOptions = Readonly<{ authenticator?: readonly EngineWebAuthnCredential[]; onEvent?: (event: EngineSessionEvent) => void }>;

export type BrowserEngine = Readonly<{
  /** Model-facing owned-browser tools (existing-browser tools are host decisions, not offered here). */
  tools(): readonly { name: string; description: string; inputSchema: unknown }[];
  /** One model tool call. `browser.session.start` here cannot carry host options; use `start` for those. */
  call(name: string, args: unknown, signal?: AbortSignal): Promise<BrowserToolResult>;
  /** Start with host-only options: passkeys for this session and an event listener. Returns the model-facing result. */
  start(args: unknown, options?: BrowserSessionOptions): Promise<BrowserToolResult>;
  frames(sessionId: string, listener: (frame: EngineFrame) => void | Promise<void>, options?: EngineFrameOptions & { pageId?: string }): Promise<() => Promise<void>>;
  events(sessionId: string, listener: (event: EngineSessionEvent) => void): () => void;
  pause(sessionId: string, reason: string): Promise<void>;
  resume(sessionId: string): void;
  operatorInput(sessionId: string, input: EngineOperatorInput, pageId?: string): Promise<void>;
  /** Operator sign-in for a shared login source, as a normal session shown through frames and operator input. */
  beginSignIn(sourceId: string, args: unknown, options?: Pick<BrowserSessionOptions, "onEvent">): Promise<BrowserToolResult>;
  /** Done (publish) or cancel. Publishing makes the signed-in state the source's next generation; running sessions keep their copies. */
  finishSignIn(sessionId: string, publish: boolean): Promise<{ generation: string } | undefined>;
  sessions(): readonly { sessionId: string; state: string }[];
  /** Remove session copies left by crashed hosts; pass the PID namespaces of every host still running on this store. */
  collectOrphans(liveNamespaces: readonly string[]): number;
  stop(sessionId: string): Promise<void>;
  close(): Promise<void>;
}>;

export function createBrowserEngine(options: BrowserEngineOptions): BrowserEngine {
  const env = { ...(options.env ?? process.env), NEWTON_BROWSER_CONFIG_DIR: options.configDirectory,
    ...(options.browserExecutable ? { NEWTON_BROWSER_BROWSER_EXECUTABLE: options.browserExecutable } : {}),
    ...(options.loginSource ? { NEWTON_BROWSER_LOGIN_SOURCE: options.loginSource } : {}) };
  const host: EngineHost = createDefaultEngineHost(env);
  const tools = ENGINE_TOOL_CATALOG.filter(tool => !tool.name.startsWith("browser.existing."));
  let request = 0;
  const call = async (name: string, args: unknown, signal = new AbortController().signal): Promise<BrowserToolResult> => {
    if (!tools.some(tool => tool.name === name)) return { content: [{ type: "text", text: JSON.stringify({ errorCode: "unsupported_capability" }) }], isError: true };
    const reply = await handleEngineMcp(host, { jsonrpc: "2.0", id: ++request, method: "tools/call", params: { name, arguments: args } }, { signal });
    if (!reply || !("result" in reply)) return { content: [{ type: "text", text: JSON.stringify({ errorCode: "cancelled" }) }], isError: true };
    return reply.result as BrowserToolResult;
  };
  const started = async (run: () => Promise<unknown>): Promise<BrowserToolResult> => {
    try { return { content: [{ type: "text", text: JSON.stringify(await run()) }] }; }
    catch (error) {
      const phase = error instanceof EngineError ? error.phase : undefined;
      return { content: [{ type: "text", text: JSON.stringify({ errorCode: error instanceof Error && /^[a-z_]{1,80}$/u.test(error.message) ? error.message : "evidence_unavailable", ...(phase ? { phase } : {}) }) }], isError: true };
    }
  };
  return Object.freeze({
    tools: () => tools,
    call,
    start: (args, sessionOptions = {}) => started(() => host.start(args, sessionOptions)),
    frames: (sessionId, listener, frameOptions) => host.frames(sessionId, listener, frameOptions),
    events: (sessionId, listener) => host.events(sessionId, listener),
    pause: (sessionId, reason) => host.pause(sessionId, reason),
    resume: sessionId => host.resume(sessionId),
    operatorInput: (sessionId, input, pageId) => host.operatorInput(sessionId, input, pageId),
    beginSignIn: (sourceId, args, sessionOptions = {}) => started(() => host.start(args, { ...sessionOptions, maintenanceOf: sourceId })),
    finishSignIn: (sessionId, publish) => host.finishMaintenance(sessionId, publish),
    sessions: () => host.list(),
    collectOrphans: liveNamespaces => collectOrphanedSessionCopies(env, liveNamespaces),
    stop: sessionId => host.stop(sessionId),
    close: () => host.close(),
  });
}

// Foundation and packaging checks exercise these from packed artifacts.
export { EngineHost, ownedEngineConnection } from "./browser-runtime/engine-host.ts";
export { LoginSource } from "./browser-runtime/login-source.ts";
export { connectExistingTab,discoverExistingBrowser } from "./existing-connection.ts";
export {connectNative} from './native-client.ts';
export {developmentUpdateControl} from './adapter-update-control.ts';
export {updateInstalledAdapter,recoverInstalledAdapter} from './adapter-update-transaction.ts';
export {createDefaultEngineHost} from './browser-runtime/default-engine-host.ts';
export { handleMcpMessage } from "./mcp-server.ts";
