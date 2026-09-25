import { randomUUID } from "node:crypto";
import { EngineError, boundedInteger, boundedString, exactObject, normalizeEngineUrl } from "@newton-browser/core";
import { SessionEngine } from "@newton-browser/driver/session-engine";
import { PageExecutor } from "@newton-browser/driver/page-executor";
import type { EngineConnection } from "@newton-browser/driver/connection";
import { launchOwnedBrowserRuntime, type LaunchOwnedBrowserRuntimeOptions } from "./owned-browser-runtime.ts";
import type {ExistingDiscovery} from '../existing-connection.ts';
export type ExistingPageRequest={connectionId?:string;tabId?:number;instanceId:string};

export async function ownedEngineConnection(options: LaunchOwnedBrowserRuntimeOptions): Promise<EngineConnection> {
  const runtime = await launchOwnedBrowserRuntime({ ...options, headless: true });
  const bootstrap = runtime.claimDriverBootstrap();
  const controller = new AbortController();
  void runtime.unavailable.then(() => controller.abort());
  return { ownsBrowser: true, wire: bootstrap.transport, rootTargetId: bootstrap.rootTargetId, epoch: randomUUID(), claimGeneration: 1, signal: controller.signal, close: () => runtime.close() };
}

/** Injectable replacement host until the full catalog cutover. No legacy result translation. */
export class EngineHost {
  readonly kind = "session_engine";
  private readonly connect: (sourceId?: string) => Promise<EngineConnection>;
  private readonly connectExisting: ((input: ExistingPageRequest) => Promise<EngineConnection>) | undefined;
  private readonly sessions = new Map<string, SessionEngine>();
  private readonly executors = new Map<string, PageExecutor>();
  private closing = false;
  private readonly starts = new Set<Promise<unknown>>();
  private readonly discoverExisting:(()=>Promise<ExistingDiscovery>)|undefined;
  constructor(connect: (sourceId?: string) => Promise<EngineConnection>, connectExisting?: (input: ExistingPageRequest) => Promise<EngineConnection>,discoverExisting?:()=>Promise<ExistingDiscovery>) {
    this.connect = connect; this.connectExisting = connectExisting;this.discoverExisting=discoverExisting;
  }
  async start(raw: unknown) {
    const args = exactObject(raw, ["mode", "url", "sourceId", "target", "connectionId"]);
    const mode = args.mode === undefined ? "owned" : args.mode;
    let url: string | undefined;
    let connect: () => Promise<EngineConnection>;
    if (mode === "owned") {
      exactObject(args, ["mode", "url", "sourceId"]);
      url = normalizeEngineUrl(args.url);
      const sourceId = args.sourceId === undefined ? undefined : boundedString(args.sourceId, 120);
      connect = () => this.connect(sourceId);
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
      const connection = await connect();
      const executor = new PageExecutor(connection);
      try {
        if (this.closing) throw new EngineError("session_closed");
        const observation = await executor.start(url);
        if (this.closing) throw new EngineError("session_closed");
        const sessionId = `engine_${randomUUID()}`;
        const engine = new SessionEngine(sessionId, executor);
        this.sessions.set(sessionId, engine);
        this.executors.set(sessionId, executor);
        return { sessionId, mode, capabilities: ["fill", "type", "clear", "edit", "click", "hover", "move", "click_at", "select", "press", "scroll", "navigate", "back", "forward", "reload", "wait_for", "dialog_accept", "dialog_dismiss", "set_files", ...(connection.ownsBrowser ? ['resize'] : []), "sequence", "records", "document", "screenshot"], nextCommandId: 1, page: executor.bindPage(), observation };
      } catch (error) { await executor.close(); throw error; }
    })();
    this.starts.add(start);
    try { return await start; } finally { this.starts.delete(start); }
  }
  session(id: unknown): SessionEngine {
    const session = this.sessions.get(boundedString(id, 120));
    if (!session) throw new EngineError("session_closed");
    return session;
  }
  pages(id: unknown) {
    const sessionId = boundedString(id, 120);
    const executor = this.executors.get(sessionId);
    if (!executor) throw new EngineError("session_closed");
    return executor.pages();
  }
  list() {
    return [...this.sessions.keys()].map(sessionId => ({ sessionId, state: this.sessions.get(sessionId)!.state, nextCommandId: this.sessions.get(sessionId)!.nextCommandId }));
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
    executor.directory.select(page);
    return this.sessions.get(sessionId)!.observe({ pageId: page, maxBytes: 8192, timeoutMs: 10000 });
  }
  screenshot(id: unknown, options: { pageId?: string; maxBytes?: number; timeoutMs?: number; options?: unknown }) {
    return this.session(id).screenshot(options);
  }
  async stop(id: unknown): Promise<void> { const session = this.session(id); await session.stop(); this.sessions.delete(session.sessionId); this.executors.delete(session.sessionId); }
  async stopAll(): Promise<void> {
    this.closing = true;
    const results = await Promise.allSettled([...this.sessions.values()].map(session => session.stop()));
    await Promise.allSettled(this.starts);
    if (results.some(result => result.status === "rejected")) throw new EngineError("cleanup_uncertain");
    this.sessions.clear(); this.executors.clear();
  }
  close(): Promise<void> { return this.stopAll(); }
}
