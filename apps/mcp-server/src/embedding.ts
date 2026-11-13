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
export type BrowserSignInAdoption = Readonly<{ cookies: number; localStorageItems: number; sessionStorageItems: number; indexedDb: "copied" | "partial" | "unsupported";
  /** Where the session's page was sent: the page the person ended on. Absent when it was reloaded instead. */
  opened?: string;
  /** Origins whose storage could not be written (their page never opened in this tab, for example a server redirect away). */
  originsLeftOut: readonly string[] }>;
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
  /** Before publishing a sign-in: give a running session the same signed-in state and open, on its selected page, the
   * page the person ended on (`opened`), so it need not restart. Carries cookies, then for each origin the sign-in
   * session's pages and frames hold its local storage, the selected page's session storage and IndexedDB (JSON-safe
   * records, best effort). An origin the session's page does not hold (a sign-in on a separate origin) is opened in
   * the session's tab first, with page scripts off until its storage is written; `originsLeftOut` lists any that
   * still could not be written. Resolves to cookie and storage item counts and `indexedDb` `copied` (every database,
   * or none to copy), `partial` (some databases, stores or records did not come across) or `unsupported` (none could
   * be read). Session storage lives only in this tab: publishing never saves it for other sessions, so a site that
   * keeps its sign-in there stays signed in only in the session that adopted it. */
  adoptSignIn(signInSessionId: string, sessionId: string): Promise<BrowserSignInAdoption>;
  /** Host-only, never a model tool: forget one site's sign-in (a site whose sign-in consent was taken back). Its cookies,
   * on the site and every subdomain, are removed, and its stored data (local storage, IndexedDB, caches, service
   * workers) cleared for each given `origins` entry on the site and for each host it held cookies for. With
   * `sessionId`, in that running session; with `sourceId`, in the login source's saved state, published as its next
   * generation (sessions already running keep their copies: forget there too, or stop them). Resolves to counts only;
   * `cleanup_uncertain` when a cookie of the site is still there afterwards. */
  forgetSite(input: Readonly<{ site: string; origins?: readonly string[] } & ({ sessionId: string; sourceId?: never } | { sourceId: string; sessionId?: never })>): Promise<{ cookies: number; origins: number; generation?: string }>;
  sessions(): readonly { sessionId: string; state: string }[];
  /** Host-only, never a model tool: fill a saved sign-in into the session's selected page as typed input. Each field's
   * frame must be on `site` or a subdomain of it (look-alike hosts and other frames are refused, `frame_off_site`); a
   * password field takes only a `secret` value and a secret value goes only into a password field (`sensitive_target`,
   * `not_password_field`). A `code` field takes a one-time sign-in code (4 to 12 letters or digits, never `secret`): into
   * one code field, one marked `one-time-code` included, or from the first box one character per box of a split code
   * input; when typing leaves the boxes short, the code is offered once more as a paste on the first box, for inputs
   * that take a code only that way (`not_code_field` for a password, payment or other non-code field). Every field is
   * checked before any is typed. The values are never returned, logged, put in an
   * error or kept in the command or its receipt; the result is the receipt plus `fields`: each field's
   * `filled` / `not_met` / `refused` / `not_started` and error code. `commandId` is the session's next command ID, as
   * for browser.act; repeating it joins the first request. */
  fillSignIn(sessionId: string, input: Readonly<{ commandId: number; site: string; fields: readonly Readonly<{ target: unknown; value: string; secret: boolean; code?: boolean }>[] }>,
    signal?: AbortSignal): Promise<BrowserToolResult>;
  /** Where a completed download of this session was saved, for the host to copy out before the session stops. */
  downloadFile(sessionId: string, downloadId: string): { path: string; filename: string; bytes: number };
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
    adoptSignIn: (signInSessionId, sessionId) => host.adoptSignIn(signInSessionId, sessionId),
    forgetSite: input => host.forgetSite(input),
    sessions: () => host.list(),
    downloadFile: (sessionId, downloadId) => host.downloadFile(sessionId, downloadId),
    fillSignIn: async (sessionId, input, signal = new AbortController().signal) => {
      try {
        signal.throwIfAborted();
        const session = host.session(sessionId);
        const { receipt, results } = session.submitSignInFill(input);
        const cancel = () => { try { session.command(input.commandId, true); } catch { /* already finished */ } };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          const { observation: _observation, ...finished } = await receipt;
          // A finished receipt, refused or not, is a result as browser.act's are.
          return { content: [{ type: "text", text: JSON.stringify({ ...finished, fields: results }) }] };
        } finally { signal.removeEventListener("abort", cancel); }
      } catch (error) {
        const code = signal.aborted ? "cancelled" : error instanceof EngineError ? error.code : "evidence_unavailable";
        return { content: [{ type: "text", text: JSON.stringify({ errorCode: code }) }], isError: true };
      }
    },
    collectOrphans: liveNamespaces => collectOrphanedSessionCopies(env, liveNamespaces),
    stop: sessionId => host.stop(sessionId),
    close: () => host.close(),
  });
}

/** A host that applies its own policy to tool arguments (file authorization, intent records) normalizes
 * them first with the same rules `call` applies, so a near-miss shape cannot pass a check it would fail. */
export { normalizeToolArguments } from "./argument-normalization.ts";
export { withNormalized } from "./engine-mcp.ts";
// Foundation and packaging checks exercise these from packed artifacts.
export { EngineHost, ownedEngineConnection } from "./browser-runtime/engine-host.ts";
export { LoginSource } from "./browser-runtime/login-source.ts";
export { connectExistingTab,discoverExistingBrowser } from "./existing-connection.ts";
export {connectNative} from './native-client.ts';
export {developmentUpdateControl} from './adapter-update-control.ts';
export {updateInstalledAdapter,recoverInstalledAdapter} from './adapter-update-transaction.ts';
export {createDefaultEngineHost} from './browser-runtime/default-engine-host.ts';
export { handleMcpMessage } from "./mcp-server.ts";
