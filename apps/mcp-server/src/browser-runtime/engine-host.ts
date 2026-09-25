import { randomUUID } from "node:crypto";
import { EngineError, boundedInteger, boundedString, exactObject, normalizeEngineUrl } from "@newton-browser/core";
import { SessionEngine } from "@newton-browser/driver/session-engine";
import { PageExecutor } from "@newton-browser/driver/page-executor";
import type { EngineConnection } from "@newton-browser/driver/connection";
import type { EngineFrame, EngineFrameOptions, EngineOperatorInput, EngineSessionEvent, EngineWebAuthnCredential } from "@newton-browser/driver/session-live";
import { launchOwnedBrowserRuntime, type LaunchOwnedBrowserRuntimeOptions, type OwnedBrowserRuntime } from "./owned-browser-runtime.ts";
import type {ExistingDiscovery} from '../existing-connection.ts';
import { DEFAULT_BROWSER_DISPLAY, type BrowserDisplay } from "./chromium-process.ts";
export type ExistingPageRequest={connectionId?:string;tabId?:number;instanceId:string};
/** Sign-in maintenance of a shared login source: an ordinary engine session whose closure can publish a new generation. */
export type LoginMaintenance = { begin(sourceId: string, display: BrowserDisplay): Promise<{ connection: EngineConnection; finish(publish: boolean): Promise<{ generation: string } | undefined> }> };

export async function ownedEngineConnection(options: LaunchOwnedBrowserRuntimeOptions): Promise<EngineConnection> {
  return engineConnectionFromRuntime(await launchOwnedBrowserRuntime({ ...options, headless: true }));
}

export function engineConnectionFromRuntime(runtime: OwnedBrowserRuntime): EngineConnection {
  const bootstrap = runtime.claimDriverBootstrap();
  const controller = new AbortController();
  void runtime.unavailable.then(() => controller.abort());
  return { ownsBrowser: true, wire: bootstrap.transport, rootTargetId: bootstrap.rootTargetId, epoch: randomUUID(), claimGeneration: 1, signal: controller.signal, close: () => runtime.close() };
}

/** Injectable replacement host until the full catalog cutover. No legacy result translation. */
export class EngineHost {
  readonly kind = "session_engine";
  static START_STOP_BOUND_MS = 15_000;
  private readonly connect: (sourceId?: string, display?: BrowserDisplay) => Promise<EngineConnection>;
  private readonly connectExisting: ((input: ExistingPageRequest) => Promise<EngineConnection>) | undefined;
  private readonly sessions = new Map<string, SessionEngine>();
  private readonly executors = new Map<string, PageExecutor>();
  private closing = false;
  private readonly starts = new Set<Promise<unknown>>();
  private readonly discoverExisting:(()=>Promise<ExistingDiscovery>)|undefined;
  private readonly maintenance: LoginMaintenance | undefined;
  private readonly maintenanceFinish = new Map<string, (publish: boolean) => Promise<{ generation: string } | undefined>>();
  constructor(connect: (sourceId?: string, display?: BrowserDisplay) => Promise<EngineConnection>, connectExisting?: (input: ExistingPageRequest) => Promise<EngineConnection>,discoverExisting?:()=>Promise<ExistingDiscovery>, maintenance?: LoginMaintenance) {
    this.connect = connect; this.connectExisting = connectExisting;this.discoverExisting=discoverExisting;this.maintenance=maintenance;
  }
  /** `host` options come only from the embedding process, never from model arguments. */
  async start(raw: unknown, host: { authenticator?: readonly EngineWebAuthnCredential[]; onEvent?: (event: EngineSessionEvent) => void; maintenanceOf?: string } = {}) {
    const args = exactObject(raw, ["mode", "url", "sourceId", "target", "connectionId", "viewport", "locale", "timezone", "collect", "timeoutMs"]);
    const mode = args.mode === undefined ? "owned" : args.mode;
    let url: string | undefined;
    let connect: () => Promise<EngineConnection>;
    let display: BrowserDisplay | undefined;
    let finish: ((publish: boolean) => Promise<{ generation: string } | undefined>) | undefined;
    let timezone: string | undefined;
    const collect = parseCollect(args.collect);
    const timeoutMs = args.timeoutMs === undefined ? 30_000 : boundedInteger(args.timeoutMs, 1_000, 120_000);
    if (mode === "owned") {
      exactObject(args, ["mode", "url", "sourceId", "viewport", "locale", "timezone", "collect", "timeoutMs"]);
      url = normalizeEngineUrl(args.url);
      const sourceId = args.sourceId === undefined ? undefined : boundedString(args.sourceId, 120);
      const viewport = args.viewport === undefined ? DEFAULT_BROWSER_DISPLAY : exactObject(args.viewport, ["width", "height"]);
      const locale = args.locale === undefined ? undefined : boundedString(args.locale, 35);
      if (locale !== undefined && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(locale)) throw new EngineError("invalid_arguments");
      display = { width: boundedInteger(viewport.width, 320, 3840), height: boundedInteger(viewport.height, 240, 2160), ...(locale ? { locale } : {}) };
      if (args.timezone !== undefined) {
        timezone = boundedString(args.timezone, 64);
        if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/u.test(timezone)) throw new EngineError("invalid_arguments");
      }
      const requested = display;
      if (host.maintenanceOf !== undefined) {
        if (!this.maintenance || sourceId !== undefined) throw new EngineError("unsupported_capability");
        const maintenance = this.maintenance, source = boundedString(host.maintenanceOf, 120);
        connect = async () => { const begun = await maintenance.begin(source, requested); finish = begun.finish; return begun.connection; };
      } else connect = () => this.connect(sourceId, requested);
    } else if (mode === "existing" && this.connectExisting) {
      exactObject(args, ["mode", "target", "connectionId"]);
      const target = exactObject(args.target, ["kind", "tabId", "instanceId", "url"]);
      if (target.kind !== "tab"&&target.kind!=='new_tab') throw new EngineError("unsupported_capability");
      exactObject(target,target.kind==='tab'?['kind','tabId','instanceId']:['kind','url','instanceId']);
      if(target.kind==='new_tab')url=normalizeEngineUrl(target.url);
      const input:ExistingPageRequest = { ...(target.kind==='tab'?{tabId:boundedInteger(target.tabId,1,Number.MAX_SAFE_INTEGER)}:{}), instanceId: boundedString(target.instanceId, 120),
        ...(args.connectionId === undefined ? {} : { connectionId: boundedString(args.connectionId, 120) }) };
      connect = () => this.connectExisting!(input);
    } else throw new EngineError("unsupported_capability");
    if (this.closing) throw new EngineError("session_closed");
    if (this.sessions.size + this.starts.size >= 16) throw new EngineError("work_limit");
    const start = (async () => {
      const connection = await connect().catch(launchFailure);
      const executor = new PageExecutor(connection);
      const unsubscribe = host.onEvent ? executor.subscribeEvents(host.onEvent) : undefined;
      try {
        if (this.closing) throw new EngineError("session_closed");
        const observation = await executor.start(url, { timeoutMs, ...(host.authenticator ? { authenticator: host.authenticator } : {}), ...(display ? { viewport: { width: display.width, height: display.height } } : {}), ...(timezone ? { timezone } : {}), ...(collect.length ? { collect } : {}) });
        if (this.closing) throw new EngineError("session_closed");
        const sessionId = `engine_${randomUUID()}`;
        const engine = new SessionEngine(sessionId, executor);
        this.sessions.set(sessionId, engine);
        this.executors.set(sessionId, executor);
        if (finish) this.maintenanceFinish.set(sessionId, finish);
        return { sessionId, mode, capabilities: ["fill", "type", "clear", "edit", "click", "hover", "move", "click_at", "select", "press", "scroll", "navigate", "back", "forward", "reload", "wait_for", "dialog_accept", "dialog_dismiss", "set_files", ...(connection.ownsBrowser ? ['resize'] : []), "sequence", "records", "document", "screenshot"], nextCommandId: 1, page: executor.bindPage(), observation };
      } catch (error) { unsubscribe?.(); await executor.close(); await finish?.(false).catch(() => undefined); throw error; }
    })();
    this.starts.add(start);
    try { return await start; } finally { this.starts.delete(start); }
  }
  session(id: unknown): SessionEngine {
    const session = this.sessions.get(boundedString(id, 120));
    if (!session) throw new EngineError("session_closed");
    return session;
  }
  consoleRecords(id: unknown, options: Parameters<PageExecutor["consoleRecords"]>[0]) { return this.executor(id).consoleRecords(options); }
  networkRecords(id: unknown, options: Parameters<PageExecutor["networkRecords"]>[0]) { return this.executor(id).networkRecords(options); }
  pages(id: unknown) {
    const sessionId = boundedString(id, 120);
    const executor = this.executors.get(sessionId);
    if (!executor) throw new EngineError("session_closed");
    return executor.pages();
  }
  list() {
    return [...this.sessions.keys()].map(sessionId => ({ sessionId, state: this.sessions.get(sessionId)!.state, nextCommandId: this.sessions.get(sessionId)!.nextCommandId }));
  }
  private executor(id: unknown): PageExecutor {
    const executor = this.executors.get(boundedString(id, 120));
    if (!executor) throw new EngineError("session_closed");
    return executor;
  }
  events(id: unknown, listener: (event: EngineSessionEvent) => void): () => void { return this.executor(id).subscribeEvents(listener); }
  frames(id: unknown, listener: (frame: EngineFrame) => void | Promise<void>, options: EngineFrameOptions & { pageId?: string } = {}) { return this.executor(id).subscribeFrames(listener, options); }
  /** Operator takeover: model actions fail with operator_control until resume; the page and sign-in state stay. */
  async pause(id: unknown, reason: string): Promise<void> { await this.session(id).pause(reason); }
  resume(id: unknown): void { this.session(id).resume(); }
  async operatorInput(id: unknown, input: EngineOperatorInput, pageId?: string): Promise<void> {
    if (this.session(id).operatorControl === undefined) throw new EngineError("operator_control");
    await this.executor(id).operatorInput(input, pageId);
  }
  async existingStatus():Promise<ExistingDiscovery> {
    if(this.closing)throw new EngineError('session_closed');
    try{if(this.discoverExisting)return await this.discoverExisting();}
    catch(error){return {mode:'existing',available:false,trust:'untrusted_page_content',tabs:[],incomplete:false,errorCode:error instanceof Error&&/^[a-z_]{1,80}$/.test(error.message)?error.message:'adapter_unavailable'};}
    return {mode:'existing',available:false,trust:'untrusted_page_content',tabs:[],incomplete:false,errorCode:'adapter_not_configured'};
  }
  async existingSetup() {
    const status=await this.existingStatus();return {...status,state:status.available?'ready':'not_ready'};
  }
  async select(id: unknown, pageId: unknown) {
    const sessionId = boundedString(id, 120);
    const executor = this.executors.get(sessionId);
    if (!executor) throw new EngineError("session_closed");
    const page = boundedString(pageId, 120);
    // Selection changes in the session lane, after actions queued before it.
    return this.sessions.get(sessionId)!.observe({ pageId: page, maxBytes: 8192, timeoutMs: 10000, beforeRead: () => executor.directory.select(page) });
  }
  screenshot(id: unknown, options: { pageId?: string; maxBytes?: number; timeoutMs?: number; options?: unknown }) {
    return this.session(id).screenshot(options);
  }
  /** Close a sign-in maintenance session; publish makes its login state the source's new generation. */
  async finishMaintenance(id: unknown, publish: boolean): Promise<{ generation: string } | undefined> {
    const sessionId = boundedString(id, 120), finish = this.maintenanceFinish.get(sessionId);
    if (!finish) throw new EngineError("session_closed");
    this.maintenanceFinish.delete(sessionId);
    try { await this.stop(sessionId); } catch (error) { await finish(false).catch(() => undefined); throw error; }
    return finish(publish);
  }
  async stop(id: unknown): Promise<void> {
    const session = this.session(id); await session.stop(); this.sessions.delete(session.sessionId); this.executors.delete(session.sessionId);
    // Stopping a sign-in session any other way abandons that sign-in.
    const finish = this.maintenanceFinish.get(session.sessionId);
    if (finish) { this.maintenanceFinish.delete(session.sessionId); await finish(false); }
  }
  async stopAll(): Promise<void> {
    this.closing = true;
    const results: PromiseSettledResult<unknown>[] = await Promise.allSettled([...this.sessions.values()].map(session => session.stop()));
    const abandoned = [...this.maintenanceFinish.values()]; this.maintenanceFinish.clear();
    results.push(...await Promise.allSettled(abandoned.map(finish => finish(false))));
    // A start whose connection never resolves must not hold shutdown forever.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startsSettled = await Promise.race([Promise.allSettled(this.starts).then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), EngineHost.START_STOP_BOUND_MS); })]);
    clearTimeout(timer);
    if (!startsSettled || results.some(result => result.status === "rejected")) throw new EngineError("cleanup_uncertain");
    this.sessions.clear(); this.executors.clear();
  }
  close(): Promise<void> { return this.stopAll(); }
}

function parseCollect(raw: unknown): ("console" | "network")[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 2 || raw.some(kind => kind !== "console" && kind !== "network")) throw new EngineError("invalid_arguments");
  return [...new Set(raw as ("console" | "network")[])];
}

/** Browser launch failures keep their phase instead of reading as missing evidence. */
function launchFailure(error: unknown): never {
  if (error instanceof EngineError) throw error;
  const failure = error as { name?: unknown; phase?: unknown; launchPhase?: unknown } | null;
  if (failure?.name === "OwnedBrowserRuntimeError" || failure?.name === "ChromiumLaunchError") {
    const phase = typeof failure.launchPhase === "string" ? failure.launchPhase : typeof failure.phase === "string" ? failure.phase : undefined;
    throw new EngineError("browser_launch_failed", phase);
  }
  if (error instanceof Error && /^[a-z_]{1,80}$/u.test(error.message)) throw new EngineError("browser_launch_failed", error.message);
  throw error;
}
