import { createHash } from "node:crypto";
import { ENGINE_ERRORS, EngineError, asObservationBudget, type EngineControlQuery, type EngineErrorCode, type EngineObservationBudget, type EngineClickAt, type EngineInputAction, type EngineObservation, type EnginePageStamp, type EnginePostcondition, type EngineTarget, type EngineWaitFor } from "@newton-browser/core";
import { CommandContext } from "./command-context.ts";
import type { EngineConnection } from "./connection.ts";
import { PageDirectory, type NodeBinding } from "./page-directory.ts";
import { TargetResolver } from "./target-resolver.ts";
import { NativeInput } from "./native-input.ts";
import { DOCUMENT_READ_FUNCTION, FRAME_SCOPE_FUNCTION, documentChunk, boundDocumentUtf8 } from "./document-reader.ts";
import { readAXControls } from "./control-reader.ts";
import { readAXSnapshot } from "./ax-snapshot.ts";
import { readStructuredRecords } from './structured-reader.ts';
import {ReadonlyWorlds} from './readonly-world.ts';
import {prepareUploadFiles} from './upload-files.ts';
import {resolveTextEditRange} from './text-edit-range.ts';
import {nativeSelectionCommands,EDIT_SELECTION_READ} from './native-edit-selection.ts';
import type {EngineEdit} from '@newton-browser/core';
import type {TargetResolverFacts} from './target-resolver.ts';
import type {EngineRecordShape,EngineFieldView} from '@newton-browser/core';
import { maskCapturedPng, MAX_RASTER_PIXELS } from "./raster-mask.ts";
import {nativeSensitiveRegions} from './native-sensitive-regions.ts';
import type { EngineExecutor } from "./session-engine.ts";
import { SessionDiagnostics, type ConsoleEntry, type DiagnosticKind } from "./session-diagnostics.ts";
import { SessionLive, type EngineFrame, type EngineFrameOptions, type EngineOperatorInput, type EngineSessionEvent, type EngineWebAuthnCredential } from "./session-live.ts";

type RecordValue = Record<string, unknown>;
const DOCUMENT_WORK_CHARS = 262_144;
const DOCUMENT_WORK_NODES = 50_000;
const DOCUMENT_CACHE_BYTES = 512 * 1024;
const DOCUMENT_TTL_MS = 300_000;
function object(value: unknown): RecordValue { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function array(value: unknown): RecordValue[] { return Array.isArray(value) ? value.map(object) : []; }
type CaptureSpatialState = Readonly<{
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  pageX: number;
  pageY: number;
  scale: number;
  deviceScaleFactor: number;
}>;
type CaptureRecord = Readonly<{
  captureBeyondViewport?:boolean;
  pageId: string;
  documentGeneration: number;
  clip: { x: number; y: number; width: number; height: number };
  spatial: CaptureSpatialState;
  regions: readonly { x: number; y: number; width: number; height: number }[];
  maskedDigest: string;
}>;

/** Shared reader/resolver/input vertical. Connections only route and own lifecycle. */
export class PageExecutor implements EngineExecutor {
  readonly directory: PageDirectory;
  private readonly connection: EngineConnection;
  private readonly routes = new Map<string, string>();
  private readonly routeParents = new Map<string, string>();
  // Frames seen attaching but not yet committed, with when they were first seen.
  private readonly pendingFrames = new Map<string, number>();
  // Page/frame work skipped under limits or after a child attachment failure: observations say incomplete.
  private degraded = false;
  private readonly pendingAttachments = new Set<Promise<void>>();
  private readonly actionPages=new WeakMap<CommandContext,Set<string>>();
  private readonly attachingPages = new Set<string>();
  private readonly pageAttachments = new Map<string,{controller:AbortController;route:string|undefined}>();
  private unsubscribe: (() => void) | undefined;
  private fault: unknown;
  private closed = false;
  private input: NativeInput | undefined;
  private localField: NodeBinding | undefined;
  private localFileNames: readonly string[] | undefined;
  private readonly resolver: TargetResolver;
  private readonly readonlyWorlds:ReadonlyWorlds;
  private readonly live:SessionLive;
  private readonly diagnostics=new SessionDiagnostics();
  private readonly lifecycle = new Map<string, Set<string>>();
  private readonly lifecycleWaiters = new Set<() => void>();
  private readonly conditionWaiters = new Set<() => void>();
  private readonly domRevisions = new Map<string,number>();
  private readonly documents = new Map<string, { page: EnginePageStamp; participants?:EnginePageStamp[]; ownerGeneration: number; text: string; bytes: number; complete: boolean; expiresAt: number }>();
  private readonly captures = new Map<string, CaptureRecord>();
  private readonly pointerDocuments = new Map<string, number>();
  private readonly viewportFrames = new Map<string, Promise<void>>();
  private timezone: string | undefined;
  // Main-frame document navigations requested but not yet committed or stopped, per page.
  private readonly pendingNavigations = new Map<string, string>();
  private readonly captureObservations = new Set<string>();
  private documentBytes = 0;
  private nextDocumentSnapshot = 1;
  private nextCapture = 1;
  private nextDialog = 1;
  private readonly dialogWaiters = new Set<(pageId: string) => void>();
  private readonly suspendedInputs = new Set<NativeInput>();
  private readonly dialogs = new Map<string, { id: string; pageId: string; route: string; type: "alert" | "confirm" | "prompt" | "beforeunload"; message: string }>();
  constructor(connection: EngineConnection) {
    this.connection = connection;
    this.directory = new PageDirectory(connection.epoch, connection.claimGeneration);
    this.readonlyWorlds=new ReadonlyWorlds(this.directory,connection.wire);
    this.live=new SessionLive(connection.wire,this.directory,connection.ownsBrowser===true);
    this.resolver = new TargetResolver({
      directory: this.directory,
      send: (binding, method, params) => this.send(binding, method, params),
      pendingAttachments: () => this.pendingAttachments.size,
      pendingFrames: () => this.pendingFrames.size,
    });
    connection.signal.addEventListener("abort", () => { this.closed = true; this.unsubscribe?.(); }, { once: true });
  }
  async start(url?: string, options: { timeoutMs?: number; viewport?: { width: number; height: number }; timezone?: string; authenticator?: readonly EngineWebAuthnCredential[]; collect?: readonly DiagnosticKind[] } = {}): Promise<EngineObservation> {
    this.timezone = options.timezone;
    // Collection asked for at start covers the first document too: each route enables it as it attaches.
    for (const kind of options.collect ?? []) await this.diagnostics.enable(kind, []);
    if (options.authenticator) this.live.useAuthenticator(options.authenticator);
    this.unsubscribe = this.connection.wire.onEvent(event => {
      // Do not return an async handler to a transport that serializes event delivery.
      try {
        this.live.handle(event, route => this.routes.get(route));
        this.diagnostics.handle(event, route => this.routes.get(route));
        if (event.method === "Target.targetCreated" && (this.connection.ownsBrowser||this.connection.tracksOwnedPages)) {
          const info = object(event.params.targetInfo),pageId=string(info.targetId);
          if(info.type==='page'&&pageId&&pageId!==this.connection.rootTargetId&&!this.attachingPages.has(pageId)) {
            if(this.attachingPages.size>=31){this.degraded=true;return;}
            this.attachingPages.add(pageId);
            this.directory.addPage(pageId,string(info.openerId));
            this.live.emit({type:'page_opened',pageId,...(string(info.openerId)?{openerPageId:string(info.openerId)}:{})});
            const attachment={controller:new AbortController(),route:undefined as string|undefined};
            this.pageAttachments.set(pageId,attachment);
            const operation=(async()=>{
              const result=await this.connection.wire.send('Target.attachToTarget',{targetId:pageId,flatten:true});
              if(!this.attachingPages.has(pageId))return;
              const route=string(result.sessionId);if(!route)throw new EngineError('connection_lost');
              attachment.route=route;
              await this.attach(pageId,route,true,undefined,attachment.controller.signal);
            })();
            const job=new Promise<void>((resolve,reject)=>{
              const abort=()=>reject(new EngineError('unknown_page'));
              attachment.controller.signal.addEventListener('abort',abort,{once:true});
              void operation.then(resolve,reject).finally(()=>attachment.controller.signal.removeEventListener('abort',abort));
            });
            // A popup that cannot be attached is dropped; the session and its other pages continue.
            const settled=job.catch(()=>{if(this.attachingPages.has(pageId)){this.attachingPages.delete(pageId);this.directory.removePage(pageId);this.degraded=true;}});
            // A popup that closes during attachment cannot poison the parent
            // observation or be resurrected by a late attachment response.
            this.pendingAttachments.add(settled);
            void settled.finally(()=>{this.pendingAttachments.delete(settled);this.pageAttachments.delete(pageId);});
          }
        } else if (event.method === "Page.javascriptDialogOpening") {
          const route = event.sessionId ?? ""; const pageId = this.routes.get(route);
          const type = string(event.params.type);
          if (pageId && ["alert", "confirm", "prompt", "beforeunload"].includes(type)) {
            this.dialogs.set(route, { id: `dialog${this.nextDialog++}`, pageId, route, type: type as "alert" | "confirm" | "prompt" | "beforeunload", message: string(event.params.message).slice(0, 512) });
            this.dialogWaiters.forEach(wake => wake(pageId));
            this.conditionWaiters.forEach(wake => wake());
          }
        } else if (event.method === "Page.javascriptDialogClosed") {
          this.dialogs.delete(event.sessionId ?? ""); this.conditionWaiters.forEach(wake => wake());
        } else if (event.method === "Target.attachedToTarget") {
          const info = object(event.params.targetInfo); const route = string(event.params.sessionId);
          if (!event.sessionId && info.type === "page") return; // Explicit root attachment is initialized by start().
          if ((info.type === "page" || info.type === "iframe") && route) {
            const pageId = info.type === "page" ? string(info.targetId) : this.routes.get(event.sessionId ?? "");
            if (pageId) {
              const job = this.attach(pageId, route, info.type === "page", string(info.parentFrameId));
              this.pendingAttachments.add(job);
              // Only the root page's own attachment is essential; a child frame or popup failing degrades the view.
              void job.catch(error => { if (pageId === this.connection.rootTargetId && info.type === "page") this.fault = error; else this.degraded = true; }).finally(() => this.pendingAttachments.delete(job));
            }
          }
        } else if (event.method === "Page.lifecycleEvent") {
          const loader = string(event.params.loaderId);
          if (!this.lifecycle.has(loader)) {
            if (this.lifecycle.size >= 128) this.lifecycle.delete(this.lifecycle.keys().next().value!);
            this.lifecycle.set(loader, new Set());
          }
          this.lifecycle.get(loader)!.add(string(event.params.name));
          this.lifecycleWaiters.forEach(wake => wake());
          this.conditionWaiters.forEach(wake => wake());
        } else if (event.method === "Target.detachedFromTarget") {
          const route = string(event.params.sessionId),pageId=this.routes.get(route);
          if(pageId&&this.pageAttachments.get(pageId)?.route===route){this.attachingPages.delete(pageId);this.pageAttachments.get(pageId)!.controller.abort();this.directory.removePage(pageId);}
          this.directory.detachRoute(route); this.diagnostics.forgetRoute(route); this.routes.delete(route); this.routeParents.delete(route); this.dialogs.delete(route);
        } else if (event.method === "Page.frameAttached") {
          this.prunePendingFrames();
          if (this.pendingFrames.size >= 128) { this.pendingFrames.delete(this.pendingFrames.keys().next().value!); this.degraded = true; }
          this.pendingFrames.set(string(event.params.frameId), performance.now());
        } else if (event.method === "Page.frameRequestedNavigation" || event.method === "Page.frameStartedNavigating") {
          const pageId = this.routes.get(event.sessionId ?? "");
          const sameDocument = event.method === "Page.frameStartedNavigating" && /^(sameDocument|historySameDocument)$/u.test(string(event.params.navigationType));
          if (pageId && event.params.frameId === pageId && !sameDocument && (event.params.disposition === undefined || event.params.disposition === "currentTab")) {
            this.pendingNavigations.set(pageId, string(event.params.url).slice(0, 2048));
          }
        } else if (event.method === "Page.frameStoppedLoading") {
          const pageId = this.routes.get(event.sessionId ?? "");
          if (pageId && event.params.frameId === pageId && this.pendingNavigations.delete(pageId)) this.conditionWaiters.forEach(wake => wake());
        } else if (event.method === "Page.frameNavigated") {
          const pageId = this.routes.get(event.sessionId ?? "");
          if (pageId && object(event.params.frame).id === pageId) { this.pendingNavigations.delete(pageId); if (pageId === this.connection.rootTargetId) this.degraded = false; }
          if (pageId) this.frame(pageId, object(event.params.frame), event.sessionId!);
          this.conditionWaiters.forEach(wake => wake());
        } else if (event.method === "Page.frameDetached") {
          const pageId = this.routes.get(event.sessionId ?? "");
          if (pageId) this.directory.detachFrame(pageId, string(event.params.frameId), event.sessionId!);
          if (event.params.reason === "remove") this.pendingFrames.delete(string(event.params.frameId));
          this.conditionWaiters.forEach(wake => wake());
        } else if (event.method === 'Page.navigatedWithinDocument') {
          const pageId=this.routes.get(event.sessionId??'');
          if(pageId){const page=this.directory.stamp(pageId);if(page.frameId===event.params.frameId)this.directory.describe(page,{url:string(event.params.url)});}
          this.conditionWaiters.forEach(wake => wake());
        } else if (event.method === "Target.targetDestroyed") {
          const pageId=string(event.params.targetId);
          this.directory.removePage(pageId);this.domRevisions.delete(pageId);this.attachingPages.delete(pageId);this.pendingNavigations.delete(pageId);
          this.pageAttachments.get(pageId)?.controller.abort();
          for(const [route,owner] of this.routes)if(owner===pageId){this.directory.detachRoute(route);this.routes.delete(route);this.routeParents.delete(route);this.dialogs.delete(route);}
          this.conditionWaiters.forEach(wake => wake());
        }
        if (event.method.startsWith("DOM.") || event.method === "Target.attachedToTarget" || event.method === "Target.detachedFromTarget") {
          if(event.method==='DOM.documentUpdated'){
            const pageId=this.routes.get(event.sessionId??'');
            if(pageId)this.domRevisions.set(pageId,(this.domRevisions.get(pageId)??0)+1);
          }
          this.conditionWaiters.forEach(wake => wake());
        }
      } catch (error) { this.fault = error; }
    });
    if(this.connection.ownsBrowser)await this.connection.wire.send('Target.setDiscoverTargets',{discover:true});
    const result = await this.connection.wire.send("Target.attachToTarget", { targetId: this.connection.rootTargetId, flatten: true });
    const route = string(result.sessionId);
    if (!route) throw new EngineError("connection_lost");
    await this.attach(this.connection.rootTargetId, route, true);
    const context = new CommandContext(options.timeoutMs ?? 30_000);
    try {
      if (options.viewport && this.connection.ownsBrowser) {
        // The launch window size includes platform chrome; set the page area exactly.
        const window = await this.connection.wire.send('Browser.getWindowForTarget', { targetId: this.connection.rootTargetId });
        if (Number.isSafeInteger(window.windowId)) await this.connection.wire.send('Browser.setContentsSize', { windowId: window.windowId, ...options.viewport });
      }
      if (url) {
        const before = this.directory.stamp(this.connection.rootTargetId).documentGeneration;
        const navigation = await this.connection.wire.send("Page.navigate", { url }, route);
        if (navigation.errorText) throw new EngineError("navigation_failed");
        if (navigation.loaderId) await this.waitForDocument(context, string(navigation.loaderId), this.connection.rootTargetId, before);
        const tree = await this.connection.wire.send("Page.getFrameTree", {}, route);
        this.frameTree(this.connection.rootTargetId, object(tree.frameTree), route);
      }
      const initialPage=this.bindPage();
      try{return await this.observe(context,initialPage,8192);}
      catch(error){
        const current=this.bindPage(initialPage.pageId);
        if(!(error instanceof EngineError)||error.code!=='stale_target'||current.documentGeneration===initialPage.documentGeneration)throw error;
        // A document may commit during initial discovery. One read of the new
        // generation is safe; startup navigation is never repeated.
        return await this.observe(context,current,8192);
      }
    } catch (error) {
      if (error instanceof EngineError && error.code === "dialog_opened") return this.observe(context, this.bindPage(), 8192);
      throw error;
    } finally { context.dispose(); }
  }
  bindPage(pageId?: string): EnginePageStamp {
    if (this.closed) throw new EngineError("session_closed");
    if (this.fault) throw new EngineError("evidence_unavailable");
    return this.directory.stamp(pageId);
  }
  async pages():Promise<ReturnType<PageDirectory['inventory']>>{
    const context=new CommandContext(10_000);
    try{
      // A popup can begin attaching during the preceding observation. Listing
      // pages must await that known work instead of reporting an empty child list.
      while(this.pendingAttachments.size)await context.read(()=>Promise.all([...this.pendingAttachments]));
      if(this.closed)throw new EngineError('session_closed');
      if(this.fault)throw new EngineError('evidence_unavailable');
      return this.directory.inventory();
    }finally{context.dispose();}
  }
  async act(context: CommandContext, page: EnginePageStamp, action: EngineInputAction): Promise<EnginePostcondition> {
    if(!this.actionPages.has(context))this.actionPages.set(context,new Set(this.directory.inventory().map(item=>item.pageId)));
    if (this.input) throw new EngineError("queue_full");
    this.localField = undefined;
    this.localFileNames = undefined;
    const input = new NativeInput(context, {
      route: binding => this.directory.route(binding),
      send: (binding, method, params) => this.send(binding, method, params),
      release: (route, method, params) => {
        if (this.closed) throw new EngineError("session_closed");
        const operation = this.connection.wire.send(method, params, route);
        return this.dialogAware(operation, this.routes.get(route) ?? page.pageId);
      },
    });
    this.input = input;
    try { return await this.performAction(context, page, action); }
    catch (error) {
      if (error instanceof EngineError && error.code === "dialog_opened") return { state: "unknown", kind: action.kind==='set_files'?'files':action.kind==='resize'?'viewport':'visible' };
      throw error;
    } finally {
      try {
        // A modal can withhold an input acknowledgement until it is answered.
        // Preserve only its held releases; ordinary actions are fenced below.
        if ([...this.dialogs.values()].some(dialog => dialog.pageId === page.pageId)) {
          if (input.pending) this.suspendedInputs.add(input);
        } else await input.finish();
      } finally { if (this.input === input) this.input = undefined; }
    }
  }
  private async performAction(context: CommandContext, page: EnginePageStamp, action: EngineInputAction): Promise<EnginePostcondition> {
    if (!this.dialogs.size) {
      for (const held of this.suspendedInputs) { await held.finish(); this.suspendedInputs.delete(held); }
    }
    if (this.suspendedInputs.size >= 32) throw new EngineError("work_limit");
    if (action.kind === "dialog_accept" || action.kind === "dialog_dismiss") {
      const dialog = [...this.dialogs.values()].find(item => item.pageId === page.pageId && item.id === action.dialogId);
      if (!dialog) throw new EngineError("stale_target");
      if (action.promptText !== undefined && dialog.type !== "prompt") throw new EngineError("invalid_arguments");
      await context.input(() => this.connection.wire.send("Page.handleJavaScriptDialog", { accept: action.kind === "dialog_accept", ...(action.promptText === undefined ? {} : { promptText: action.promptText }) }, dialog.route));
      if (!this.dialogs.size) {
        for (const held of this.suspendedInputs) { await held.finish(); this.suspendedInputs.delete(held); }
      }
      return { state: this.dialogs.get(dialog.route)?.id === dialog.id ? "unknown" : "met", kind: "visible" };
    }
    if ([...this.dialogs.values()].some(dialog => dialog.pageId === page.pageId)) throw new EngineError("target_not_editable");
    if (action.kind === "press" && action.keys) this.input!.preflight(action.keys, action.text === undefined ? 1 : 2);
    if (action.kind === "navigate") return this.navigate(context, page, action.url);
    if (action.kind === "click_at" || action.kind === "move") return this.clickAt(context, page, action);
    if (action.kind === "back" || action.kind === "forward" || action.kind === "reload") return this.history(context, page, action.kind);
    if (action.kind === "scroll") return this.scroll(context, page, action.x, action.y, action.target);
    if (action.kind === "wait_for") return this.waitFor(context, page, action.waitFor);
    if (action.kind === 'resize') return this.resize(context,page,action.width,action.height);
    if (action.kind === "press" && !action.target) return this.pressGlobal(context, page, action.keys, action.text);
    if (!("target" in action)) throw new EngineError("unsupported_capability");
    const binding = await this.resolver.resolve(context, page, action.target);
    if (action.kind === 'set_files') return this.setFiles(context,binding,action.files);
    if (action.kind === "click" || action.kind === "hover") await this.preparePointerDocument(context, binding);
    const requiresEditable = action.kind === "fill" || action.kind === "type" || action.kind === "clear" || action.kind === "select" || action.kind === 'edit';
    if (requiresEditable) this.localField = binding;
    const initial = await this.resolver.inspect(context, binding, { editable: requiresEditable, pointer: action.kind === "click" || action.kind === "hover" });
    if(action.kind==='edit')return this.edit(context,binding,initial,action);
    if (!initial.focused && requiresEditable && action.kind !== "select") {
      await context.input(() => this.send(binding, "DOM.focus", { backendNodeId: binding.backendNodeId }));
    }
    if (action.kind === "click" || action.kind === "hover") return this.click(context, binding, initial, action.waitFor, action.kind === "hover" ? undefined : { button: action.button ?? "left", count: action.clickCount ?? 1 });
    if (action.kind === "press") return this.press(context, binding, action.keys, action.text);
    if (action.kind === "select") return this.select(context, binding, initial, action.value);
    if (action.kind !== "fill" && action.kind !== "type" && action.kind !== "clear") throw new EngineError("unsupported_capability");
    const focused = await this.focusedFacts(context, binding, true);
      if (action.kind === "type") {
        const previous = focused;
        if (action.value) await context.input(() => this.send(binding, "Input.insertText", { text: action.value }));
        const after = await this.resolver.inspect(context, binding);
        const expected = expectedTypedValue(previous, action.value);
        return { state: expected === undefined ? "unknown" : after.value === expected ? "met" : "not_met", kind: "value" };
      }
      if (action.kind === "clear") {
        await this.clear(binding, context);
        const after = await this.resolver.inspect(context, binding);
        return { state: after.value ? "not_met" : "met", kind: "value" };
      }
      await this.selectAll(context, binding);
      await this.focusedFacts(context, binding, true);
      if (action.value) await context.input(() => this.send(binding, "Input.insertText", { text: action.value }));
      else await this.deleteSelection(context, binding);
      const after = await this.resolver.inspect(context, binding);
      return { state: after.value === action.value ? "met" : "not_met", kind: "value" };
  }

  private async edit(context:CommandContext,binding:NodeBinding,initial:TargetResolverFacts,action:EngineEdit):Promise<EnginePostcondition>{
    if(initial.value===undefined||initial.tag==='select')throw new EngineError('target_not_editable');
    const range=resolveTextEditRange(initial.value,action);
    const commands=nativeSelectionCommands(initial.value,range.start,range.end);
    context.ensureInputCapacity(6);
    if(!initial.focused)await context.input(()=>this.send(binding,'DOM.focus',{backendNodeId:binding.backendNodeId}));
    const before=await this.focusedFacts(context,binding,true);
    if(before.value!==initial.value)throw new EngineError('stale_target');
    await this.input!.selectRange(binding,commands);
    const selected=await this.focusedFacts(context,binding,true);
    if(selected.value!==initial.value)throw new EngineError('stale_target');
    const resolved=await context.read(()=>this.send(binding,'DOM.resolveNode',{backendNodeId:binding.backendNodeId}));
    const objectId=string(object(resolved.object).objectId);
    if(!objectId)throw new EngineError('stale_target');
    try{
      const result=await context.read(()=>this.send(binding,'Runtime.callFunctionOn',{objectId,functionDeclaration:EDIT_SELECTION_READ,arguments:[{value:initial.value}],returnByValue:true,silent:true}));
      const selection=object(object(result.result).value);
      if(selection.valid===false)throw new EngineError('stale_target');
      if(result.exceptionDetails||selection.start!==range.start||selection.end!==range.end)throw new EngineError('unsupported_structure');
    }finally{void this.send(binding,'Runtime.releaseObject',{objectId}).catch(()=>undefined);}
    // No composition or temporary replacement text exists to recover. Between
    // selection and this one mutation, cancellation leaves the field untouched.
    if(action.replacement)await context.input(()=>this.send(binding,'Input.insertText',{text:action.replacement}));
    else await this.deleteSelection(context,binding);
    const after=await this.resolver.inspect(context,binding);
    return {state:after.value===range.expected?'met':'not_met',kind:'value'};
  }

  private async setFiles(context:CommandContext,binding:NodeBinding,paths:readonly string[]):Promise<EnginePostcondition>{
    const checkFile=<T>(operation:()=>T):T=>{try{return operation();}catch(error){const code=error instanceof Error?error.message:'';throw new EngineError((ENGINE_ERRORS as readonly string[]).includes(code)?code as EngineErrorCode:'invalid_arguments');}};
    const prepared=checkFile(()=>prepareUploadFiles(paths));
    try{
      const facts=await this.resolver.inspect(context,binding,{editable:false,actionable:false});
      // Styled upload buttons commonly use a hidden native file input. The
      // explicit unique target and input type are sufficient; no focus/click is
      // fabricated and the site's file-change handling runs normally.
      if(facts.tag!=='input'||facts.type!=='file'||facts.disabled||(!facts.multiple&&paths.length>1))throw new EngineError('target_not_editable');
      checkFile(()=>prepared.assertUnchanged());
      await context.input(()=>this.send(binding,'DOM.setFileInputFiles',{backendNodeId:binding.backendNodeId,files:prepared.paths}));
      checkFile(()=>prepared.assertUnchanged());
      const resolved=await context.read(()=>this.send(binding,'DOM.resolveNode',{backendNodeId:binding.backendNodeId}));
      const objectId=string(object(resolved.object).objectId);if(!objectId)throw new EngineError('stale_target');
      let names:string[];
      try{
        const result=await context.read(()=>this.send(binding,'Runtime.callFunctionOn',{objectId,functionDeclaration:"function(){if(this.localName!=='input'||this.type!=='file'||!this.isConnected)return null;const count=this.files.length;return {count,names:count>8?[]:Array.from(this.files).map(file=>file.name.slice(0,1024))};}",returnByValue:true,silent:true}));
        if(result.exceptionDetails)throw new EngineError('evidence_unavailable');
        const accepted=object(object(result.result).value);
        if(!Array.isArray(accepted.names)||!accepted.names.every(name=>typeof name==='string')||accepted.count!==accepted.names.length)throw new EngineError('evidence_unavailable');
        names=accepted.names as string[];
      }finally{void Promise.resolve().then(()=>this.send(binding,'Runtime.releaseObject',{objectId})).catch(()=>{});}
      this.localField=binding;this.localFileNames=[...names];
      return {state:JSON.stringify(names)===JSON.stringify(prepared.names)?'met':'not_met',kind:'files'};
    }finally{prepared.close();}
  }
  private async resize(context:CommandContext,page:EnginePageStamp,width:number,height:number):Promise<EnginePostcondition>{
    if(!this.connection.ownsBrowser)throw new EngineError('unsupported_capability');
    const root=this.directory.binding(page,1);
    const window=await context.read(()=>this.connection.wire.send('Browser.getWindowForTarget',{targetId:page.pageId}));
    if(!Number.isSafeInteger(window.windowId))throw new EngineError('unsupported_capability');
    this.directory.route(root);
    await context.input(()=>this.dialogAware(this.connection.wire.send('Browser.setContentsSize',{windowId:window.windowId,width,height}),page.pageId));
    // Real window sizing, with observed renderer dimensions; never device emulation.
    for(;;){
      const current=this.directory.binding(this.directory.stamp(page.pageId),1);
      const metrics=await context.read(()=>this.send(current,'Page.getLayoutMetrics',{}));
      const viewport=object(metrics.cssLayoutViewport);
      if(viewport.clientWidth===width&&viewport.clientHeight===height)return {state:'met',kind:'viewport'};
      await this.waitForCondition(context,context.deadline);
    }
  }
  private async click(context: CommandContext, binding: NodeBinding, facts: Awaited<ReturnType<TargetResolver["inspect"]>>, waitFor?: EngineWaitFor, press?: { button: "left" | "right" | "middle"; count: number }): Promise<EnginePostcondition> {
    context.ensureInputCapacity(1 + (press ? press.count * 2 : 0) + (facts.pointerInView === false ? 1 : 0));
    if (facts.pointerInView === false) {
      await context.input(() => this.send(binding,"DOM.scrollIntoViewIfNeeded",{backendNodeId:binding.backendNodeId}));
      facts = await this.resolver.inspect(context,binding,{editable:false,pointer:true});
      if (!facts.pointerInView) throw new EngineError("target_not_editable");
    }
    const box = facts.bbox;
    if (!box || box.width <= 0 || box.height <= 0) throw new EngineError("target_not_editable");
    await this.verifyHit(context, binding, box.x + box.width / 2, box.y + box.height / 2);
    const { x, y } = await this.pointerPoint(context, binding);
    await context.input(() => this.send(binding, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", clickCount: 0 }));
    if (press) {
      const verify = async () => { const current = await this.pointerPoint(context, binding); if (current.x !== x || current.y !== y) throw new EngineError("target_moved"); };
      await verify();
      await this.input!.click(binding, x, y, press.button, press.count, verify);
    }
    if (waitFor) await this.waitFor(context, { pageId: binding.pageId, frameId: binding.frameId, documentGeneration: binding.documentGeneration }, waitFor);
    return waitFor ? { state: "met", kind: "visible" } : { state: "not_requested" };
  }

  private async press(context: CommandContext, binding: NodeBinding, keys: readonly string[] | undefined, text: string | undefined): Promise<EnginePostcondition> {
    // Text-only insertion has the same useful next state as type/fill. Chords can
    // submit, move focus or open controls, so keep broader feedback for those.
    if(text!==undefined&&!keys?.length)this.localField=binding;
    await context.input(() => this.send(binding, "DOM.focus", { backendNodeId: binding.backendNodeId }));
    await this.focusedFacts(context, binding, text !== undefined);
    if (text !== undefined) await context.input(() => this.send(binding, "Input.insertText", { text }));
    if (keys) await this.input!.chord(binding, keys, async () => { await this.focusedFacts(context, binding, false); });
    return { state: "not_requested" };
  }

  private async pressGlobal(context: CommandContext, page: EnginePageStamp, keys: readonly string[] | undefined, text: string | undefined): Promise<EnginePostcondition> {
    const binding = await this.resolver.focused(context, page);
    return this.press(context, binding, keys, text);
  }

  private async select(context: CommandContext, binding: NodeBinding, facts: Awaited<ReturnType<TargetResolver["inspect"]>>, value: string): Promise<EnginePostcondition> {
    if (facts.tag === "select") {
      if (facts.multiple) throw new EngineError("unsupported_capability");
      const resolved = await context.read(() => this.send(binding, "DOM.resolveNode", { backendNodeId: binding.backendNodeId }));
      const objectId = string(object(resolved.object).objectId);
      if (!objectId) throw new EngineError("stale_target");
      try {
        const option = await context.read(() => this.send(binding, "Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: "function(value){if(!this.options||this.options.length>4096)return {limited:true};const options=[];for(let index=0;index<this.options.length;index++){const option=this.options[index],label=String(option.textContent||'').trim(),candidate=String(option.value);if(label.length>65536||candidate.length>65536)return {limited:true};options.push({index,value:candidate,label,disabled:!!option.disabled||(option.parentElement?.localName==='optgroup'&&option.parentElement.disabled)});}return {matches:options.filter(option=>option.value===value||option.label===value),enabled:options.filter(option=>!option.disabled).map(option=>({index:option.index,label:option.label}))};}",
          arguments: [{ value }], returnByValue: true, silent: true, throwOnSideEffect: true,
        }));
        const details = object(object(option.result).value);
        if(option.exceptionDetails)throw new EngineError('evidence_unavailable');
        if(details.limited===true)throw new EngineError('search_incomplete');
        const matches = array(details.matches);
        if (matches.length > 1) throw new EngineError("ambiguous");
        const selected = matches[0];
        if (!selected) throw new EngineError("not_found");
        if (selected.disabled === true) throw new EngineError("target_not_editable");
        const enabled = array(details.enabled);
        const enabledIndex = enabled.findIndex(candidate => Number(candidate.index) === Number(selected.index));
        if (enabledIndex < 0) throw new EngineError("target_not_editable");
        if (process.platform === "darwin") {
          // macOS menu-list selects ignore arrow keys while closed and open a
          // popup instead; the platform's native keyboard path is type-ahead.
          const label = String(selected.label ?? "");
          const folded = label.toLocaleLowerCase();
          if (!/^[\x20-\x7e]{1,256}$/.test(label) || label.startsWith(" ")) throw new EngineError("unsupported_capability");
          if (enabled.some(candidate => Number(candidate.index) !== Number(selected.index) && String(candidate.label ?? "").toLocaleLowerCase().startsWith(folded))) throw new EngineError("ambiguous");
          context.ensureInputCapacity(1 + label.length * 3);
          await context.input(() => this.send(binding, "DOM.focus", { backendNodeId: binding.backendNodeId }));
          for (const character of label) await this.key(context, binding, character);
        } else {
          context.ensureInputCapacity(1 + 2 + enabledIndex * 2 + 3);
          await context.input(() => this.send(binding, "DOM.focus", { backendNodeId: binding.backendNodeId }));
          await this.key(context, binding, "Home");
          for (let step = 0; step < enabledIndex; step += 1) await this.key(context, binding, "ArrowDown");
          await this.key(context, binding, "Enter");
        }
        const after = await this.resolver.inspect(context, binding, { editable: false });
        return { state: after.value === String(selected.value) ? "met" : "not_met", kind: "value" };
      } finally { void this.send(binding, "Runtime.releaseObject", { objectId }).catch(() => undefined); }
    }
    throw new EngineError("unsupported_capability");
  }

  private async key(context: CommandContext, binding: NodeBinding, key: string): Promise<void> {
    context.checkpoint();
    await this.input!.chord(binding, [key], async () => { await this.focusedFacts(context, binding, false); });
  }

  private async navigate(context: CommandContext, page: EnginePageStamp, url: string): Promise<EnginePostcondition> {
    const root = this.directory.binding(page, 1);
    const before = this.directory.stamp(page.pageId).documentGeneration;
    const result = await context.input(() => this.send(root, "Page.navigate", { url }));
    if (result.errorText) throw new EngineError("navigation_failed");
    const loaderId = string(result.loaderId);
    if (loaderId) {
      await this.waitForDocument(context, loaderId, page.pageId, before);
      await this.waitForGeneration(context, page.pageId, before);
    } else {
      // A fragment navigation does not create a new document generation.
      const location = await context.read(() => this.send(root, "Runtime.evaluate", { expression: "location.href", returnByValue: true, silent: true }));
      if (object(location.result).value !== url) throw new EngineError("navigation_failed");
    }
    return { state: "met", kind: "navigation" };
  }

  private async history(context: CommandContext, page: EnginePageStamp, kind: "back" | "forward" | "reload"): Promise<EnginePostcondition> {
    const root = this.directory.binding(page, 1);
    const before = this.directory.stamp(page.pageId).documentGeneration;
    if (kind === "reload") {
      const result = await context.input(() => this.send(root, "Page.reload", {}));
      if (result.errorText) throw new EngineError("navigation_failed");
      await this.waitForGeneration(context, page.pageId, before);
      return { state: "met", kind: "navigation" };
    }
    const history = await context.read(() => this.send(root, "Page.getNavigationHistory", {}));
    const entries = array(history.entries); const current = Number(history.currentIndex);
    if (!Number.isSafeInteger(current) || current < 0 || current >= entries.length) throw new EngineError("evidence_unavailable");
    const targetIndex = kind === "back" ? current - 1 : current + 1;
    if (targetIndex < 0 || targetIndex >= entries.length) return { state: "not_met", kind: "navigation" };
    const targetEntry = object(entries[targetIndex]);
    // Chromium keeps the bootstrap about:blank entry in the page history even
    // after the required initial URL is loaded. It is not an operator page and
    // cannot be navigated to reliably through the attached page session.
    if (targetIndex === 0 && string(targetEntry.url) === "about:blank") return { state: "not_met", kind: "navigation" };
    const beforeEntry = object(entries[current]);
    const beforeGeneration = page.documentGeneration;
    const crossDocument = documentUrl(string(beforeEntry.url)) !== documentUrl(string(targetEntry.url));
    const entryId = Number(targetEntry.id);
    if (!Number.isSafeInteger(entryId)) throw new EngineError("evidence_unavailable");
    const result = await context.input(() => this.send(root, "Page.navigateToHistoryEntry", { entryId }));
    if (result.errorText) throw new EngineError("navigation_failed");
    await this.waitForHistoryIndex(context, page.pageId, targetIndex);
    if (crossDocument) await this.waitForGeneration(context, page.pageId, beforeGeneration);
    return { state: "met", kind: "navigation" };
  }

  private async scroll(context: CommandContext, page: EnginePageStamp, x: number, y: number, target?: EngineTarget): Promise<EnginePostcondition> {
    const binding = target ? await this.resolver.resolve(context, page, target) : this.directory.binding(page, 1);
    if (target) {
      await this.preparePointerDocument(context,binding);
      const facts=await this.resolver.inspect(context,binding,{editable:false,pointer:true});
      if(facts.pointerInView===false){
        await context.input(()=>this.send(binding,'DOM.scrollIntoViewIfNeeded',{backendNodeId:binding.backendNodeId}));
        const current=await this.resolver.inspect(context,binding,{editable:false,pointer:true});
        if(!current.pointerInView)throw new EngineError('target_not_editable');
      }
    }
    const point = target ? await this.pointerPoint(context, binding) : { x: 1, y: 1 };
    let objectId: string | undefined;
    try {
      if (target) {
        const resolved = await context.read(() => this.send(binding, "DOM.resolveNode", { backendNodeId: binding.backendNodeId }));
        objectId = string(object(resolved.object).objectId);
        if (!objectId) throw new EngineError("stale_target");
      }
      const offset = async () => {
        const result = await context.read(() => this.send(binding, objectId ? "Runtime.callFunctionOn" : "Runtime.evaluate", objectId
          ? { objectId, functionDeclaration: "function(){return {x:this.scrollLeft,y:this.scrollTop,connected:this.isConnected,visibility:this.ownerDocument.visibilityState};}", returnByValue: true, silent: true, throwOnSideEffect: true }
          : { expression: "({x:scrollX,y:scrollY,visibility:document.visibilityState})", returnByValue: true, silent: true }));
        const point = object(object(result.result).value);
        if (objectId && point.connected !== true) throw new EngineError("stale_target");
        if (!finiteNumber(point.x) || !finiteNumber(point.y)) throw new EngineError("evidence_unavailable");
        if (point.visibility !== "hidden" && point.visibility !== "visible") throw new EngineError("evidence_unavailable");
        return { x: point.x, y: point.y, visibility: point.visibility };
      };
      const before = await offset();
      const wheel = context.input(() => this.send(binding, "Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: x, deltaY: y, button: "none" }));
      // Chromium's wheel dispatch waits on a compositor visual-state callback.
      // Hidden tabs have no periodic frames. A viewport observation allows
      // that callback to run without activating the tab or emulating visibility.
      // Do not retry input; the one wheel remains the only effectful operation.
      const frame = before.visibility === "hidden" ? this.observeViewportFrame(context, page.pageId) : Promise.resolve();
      // The wheel acknowledgement and its actual offset decide the receipt.
      // Another tab's native modal can withhold screenshot completion even after
      // this tab scrolled; an optional observation must not stall verified input.
      void frame.catch(() => undefined);
      await wheel;
      // Wheel acknowledgement precedes compositor scroll application. Observe the
      // actual offset transition; do not label an immediate unchanged sample a failure.
      const deadline = Math.min(context.deadline, performance.now() + 250);
      for (;;) {
        const after = await offset();
        if (before.x !== after.x || before.y !== after.y) return { state: "met", kind: "visible" };
        if (performance.now() >= deadline) return { state: "unknown", kind: "visible" };
        try { await this.waitForCondition(context, deadline, 16); }
        catch (error) { if (!context.cancellation && error instanceof EngineError && error.code === "timed_out") return { state: "unknown", kind: "visible" }; throw error; }
      }
    } finally { if (objectId) void this.send(binding, "Runtime.releaseObject", { objectId }).catch(() => undefined); }
  }

  private async observeViewportFrame(context: CommandContext, pageId: string): Promise<void> {
    const pending = this.viewportFrames.get(pageId);
    if (pending) return context.read(() => pending);
    const root = this.directory.binding(this.directory.stamp(pageId), 1);
    // Pixels are neither retained nor exposed. A full viewport is necessary:
    // a 1px clip does not reliably commit off-clip scroll-layer updates.
    const operation = context.read(() => this.send(root, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).then(() => { this.directory.route(root); });
    this.viewportFrames.set(pageId, operation);
    try { await operation; }
    finally { if (this.viewportFrames.get(pageId) === operation) this.viewportFrames.delete(pageId); }
  }

  private async preparePointerDocument(context: CommandContext, binding: NodeBinding): Promise<void> {
    if (this.pointerDocuments.get(binding.frameId) === binding.documentGeneration) return;
    const root = this.directory.binding(this.directory.stamp(binding.pageId), 1);
    const result = await context.read(() => this.send(root, "Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true, silent: true }));
    const visibility = object(result.result).value;
    if (visibility !== "hidden" && visibility !== "visible") throw new EngineError("evidence_unavailable");
    // Newly loaded hidden headed tabs can acknowledge but discard mouse presses
    // before first paint. Observe that frame once per document before any press.
    if (visibility === "hidden") await this.observeViewportFrame(context, binding.pageId);
    this.directory.route(binding);
    this.pointerDocuments.set(binding.frameId, binding.documentGeneration);
    while (this.pointerDocuments.size > 256) this.pointerDocuments.delete(this.pointerDocuments.keys().next().value!);
  }

  private async waitFor(context: CommandContext, page: EnginePageStamp, waitFor: EngineWaitFor): Promise<EnginePostcondition> {
    const deadline = Math.min(context.deadline, performance.now() + (waitFor.timeoutMs ?? 10_000));
    for (;;) {
      context.checkpoint();
      if (performance.now() > deadline) throw new EngineError("timed_out");
      const current = this.directory.stamp(page.pageId);
      const revision=this.domRevisions.get(page.pageId);
      try {
        if (await this.waitFact(context, current, waitFor)) return { state: "met", kind: "visible" };
      } catch (error) {
        // Navigation can replace the document between two read-only probes. It
        // invalidates the probe, not the already-dispatched click. Re-evaluate
        // the requested condition against the new document; never replay input.
        // Chromium can invalidate frontend DOM IDs again after frameNavigated,
        // without another document generation. That event also invalidates the
        // read probe, and only that probe is retried.
        if (this.directory.stamp(page.pageId).documentGeneration === current.documentGeneration&&this.domRevisions.get(page.pageId)===revision) throw error;
        continue;
      }
      await this.waitForCondition(context, deadline);
    }
    throw new EngineError("timed_out");
  }

  private async waitFact(context: CommandContext, page: EnginePageStamp, waitFor: EngineWaitFor): Promise<boolean> {
    const root = this.directory.binding(page, 1);
    if (waitFor.url || waitFor.title) {
      const result = await context.read(() => this.send(root, "Runtime.evaluate", { expression: "({url:location.href,title:document.title})", returnByValue: true, silent: true }));
      const current = object(object(result.result).value);
      if (waitFor.url && !string(current.url).includes(waitFor.url)) return false;
      if (waitFor.title && !string(current.title).includes(waitFor.title)) return false;
    }
    if (waitFor.text) {
      let matched = false,incomplete=false,remainingNodes=DOCUMENT_WORK_NODES,remainingChars=DOCUMENT_WORK_CHARS;
      const pending=[...this.directory.frames(page.pageId)],included=new Map<string,NodeBinding>();
      // Admit children only after their visible owner in the parent document.
      // This excludes entire hidden frame families, including remote renderers.
      for(let pass=0;pass<16&&pending.length&&!matched;pass++)for(let index=0;index<pending.length;){
        const frame=pending[index]!,parent=this.directory.parent(frame);
        if(parent&&!included.has(parent.frameId)){index++;continue;}
        pending.splice(index,1);
        if(remainingNodes<=0||remainingChars<=0){incomplete=true;break;}
        if(parent&&!await this.frameWithinScope(context,included.get(parent.frameId)!,frame,false,false))continue;
        const document = await this.resolver.document(context, frame);
        included.set(frame.frameId,document);
        const read=await this.readBoundText(context,document,remainingChars,remainingNodes,false,false,waitFor.text);
        remainingNodes-=read.visited??remainingNodes;
        remainingChars-=read.characters??remainingChars;
        incomplete||=read.truncated&&!read.loading;
        if(read.matched){matched=true;break;}
      }
      incomplete||=pending.some(frame=>{const parent=this.directory.parent(frame);return !parent||included.has(parent.frameId);});
      if(!matched&&incomplete)throw new EngineError('search_incomplete');
      if (!matched) return false;
    }
    const target = waitTarget(waitFor);
    if (!target) return true;
    try {
      const binding = await this.resolver.resolve(context, page, target);
      if (!waitFor.state || waitFor.state === "attached") return true;
      const facts = await this.resolver.inspect(context, binding, { editable: false, actionable: false, allowSensitive: true });
      if (waitFor.state === "hidden") return !facts.visible;
      if (waitFor.state === "visible") return facts.visible;
      if (waitFor.state === "checked") return facts.checked === true;
      if (waitFor.state === "unchecked") return facts.checked === false;
      if (waitFor.state === "value") return facts.value === waitFor.value;
      return waitFor.state !== "detached";
    } catch (error) {
      if ((error as { code?: string }).code === "not_found" || (error as { code?: string }).code === "stale_target") return waitFor.state === "detached" || waitFor.state === "hidden";
      throw error;
    }
  }
  private async waitForCondition(context: CommandContext, deadline: number, fallbackMs = 250): Promise<void> {
    context.checkpoint();
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new EngineError("timed_out");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
      const wake = () => {
        if (settled) return;
        settled = true;
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (fallbackTimer) clearTimeout(fallbackTimer);
        this.conditionWaiters.delete(wake);
        resolve();
      };
      deadlineTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        this.conditionWaiters.delete(wake);
        reject(new EngineError("timed_out"));
      }, remaining);
      fallbackTimer = setTimeout(wake, Math.min(fallbackMs, remaining));
      this.conditionWaiters.add(wake);
    });
    context.checkpoint();
  }
  async observeAfterAction(context: CommandContext, page: EnginePageStamp, budgetValue: number | EngineObservationBudget): Promise<EngineObservation> {
    const budget=asObservationBudget(budgetValue);
    // An action that started a document navigation reports the committed
    // document, not the one being replaced. Keep part of the budget for the read.
    const navigated = await this.awaitCommittedNavigation(context, page);
    if (navigated) { page = navigated; this.localField = undefined; this.localFileNames = undefined; }
    if (this.pendingNavigations.has(page.pageId)) { this.localField = undefined; this.localFileNames = undefined; return this.pendingNavigationView(page); }
    let observed:EngineObservation;
    try{observed=await this.observeLocalFeedback(context,page,budget);}
    catch(error){
      // Navigation may commit while optional action feedback is being read. Refresh
      // the same page once; never replay input or wait for arbitrary page settling.
      if(!(error instanceof EngineError)||error.code!=='stale_target')throw error;
      const current=this.directory.stamp(page.pageId);
      if(current.documentGeneration===page.documentGeneration)throw error;
      observed=await this.observe(context,current,budget);
    }
    const before=this.actionPages.get(context);
    if(!before||(observed.state!=='available'&&observed.state!=='incomplete'))return observed;
    while(this.pendingAttachments.size)await context.read(()=>Promise.all([...this.pendingAttachments]));
    const discovered=this.directory.inventory().filter(item=>!before.has(item.pageId));
    if(!discovered.length)return observed;
    const newPages=discovered.slice(0,8).map(item=>({...item,...(item.title?{title:item.title.slice(0,128)}:{}),...(item.url?{url:item.url.slice(0,256)}:{})}));
    let pagesLimited=discovered.length>newPages.length||discovered.some(item=>(item.title?.length??0)>128||(item.url?.length??0)>256);
    let limited=pagesLimited;
    const nodes=[...observed.nodes];
    const view=():EngineObservation=>({...observed,nodes,newPages,...(pagesLimited?{newPagesIncomplete:true}:{}),...(limited?{state:'incomplete',incompleteReason:'output_limit'}:{})});
    // Keep actual page identities in the same exact receipt budget. Omitted local
    // controls or candidate metadata are explicit, with no second browser read.
    while(!budget.fits(view())&&nodes.length){nodes.pop();limited=true;}
    while(!budget.fits(view())&&newPages.length){newPages.pop();pagesLimited=true;limited=true;}
    if(!budget.fits(view()))throw new EngineError('output_budget');
    return view();
  }
  /**
   * A page whose renderer stopped answering is replaced: a new page in the same browser (same
   * identity and sign-ins) opens its last address, and the hung page is closed. Owned browsers only.
   */
  async recover(page: EnginePageStamp): Promise<{ pageId: string; url?: string } | undefined> {
    if (this.closed || !this.connection.ownsBrowser) return undefined;
    const url = this.directory.inventory().find(item => item.pageId === page.pageId)?.url;
    const created = await this.connection.wire.send("Target.createTarget", { url: "about:blank" });
    const pageId = string(created.targetId);
    if (!pageId) return undefined;
    const deadline = performance.now() + 10_000;
    while (!this.directory.inventory().some(item => item.pageId === pageId)) {
      if (this.closed || performance.now() > deadline) return undefined;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await this.connection.wire.send("Target.closeTarget", { targetId: page.pageId }).catch(() => undefined);
    // The hung action's calls went to the closed page and may never settle; it no longer holds input.
    this.input = undefined;
    this.directory.removePage(page.pageId);
    this.pendingNavigations.delete(page.pageId);
    this.directory.select(pageId);
    const route = [...this.routes].find(([, owner]) => owner === pageId)?.[0];
    if (url && route) await this.connection.wire.send("Page.navigate", { url }, route).catch(() => undefined);
    return { pageId, ...(url ? { url } : {}) };
  }
  /** Console records since collection began; the first read starts collecting. */
  async consoleRecords(options: { pageId?: string; level?: ConsoleEntry["level"]; pattern?: string; limit: number; clear?: boolean }) {
    const started = await this.collect("console");
    return { ...(started ? { collecting: "started" as const } : {}), ...this.diagnostics.readConsole({ ...options, ...(options.pageId ? { pageId: this.bindPage(options.pageId).pageId } : {}) }) };
  }
  /** Request metadata since collection began, or one current-origin text body. */
  async networkRecords(options: { pageId?: string; urlPattern?: string; failedOnly?: boolean; requestId?: string; limit: number; maxBytes: number }) {
    const started = await this.collect("network");
    if (options.requestId === undefined) return { ...(started ? { collecting: "started" as const } : {}), ...this.diagnostics.readNetwork({ ...options, ...(options.pageId ? { pageId: this.bindPage(options.pageId).pageId } : {}) }) };
    const page = this.directory.inventory().find(item => item.pageId === this.bindPage(options.pageId).pageId);
    let origin = "";
    try { origin = page?.url ? new URL(page.url).origin : ""; } catch { /* no current origin */ }
    return { response: await this.diagnostics.responseBody(options.requestId, origin, options.maxBytes, (route, method, params) => this.connection.wire.send(method, params, route)) };
  }
  private async collect(kind: DiagnosticKind): Promise<boolean> {
    if (this.closed) throw new EngineError("session_closed");
    if (this.diagnostics.isEnabled(kind)) return false;
    return this.diagnostics.enable(kind, [...this.routes.keys()].map(route => [route, (method: string, params: RecordValue = {}) => this.connection.wire.send(method, params, route)] as [string, (method: string, params?: RecordValue) => Promise<RecordValue>]));
  }
  /** Host-only: events for the embedding process (never the model). */
  subscribeEvents(listener: (event: EngineSessionEvent) => void): () => void { return this.live.subscribe(listener); }
  /** Host-only: live JPEG frames of a page (the selected one by default). */
  async subscribeFrames(listener: (frame: EngineFrame) => void | Promise<void>, options: EngineFrameOptions & { pageId?: string } = {}): Promise<() => Promise<void>> {
    if (this.closed) throw new EngineError("session_closed");
    const page = this.bindPage(options.pageId);
    await this.front(page);
    return this.live.subscribeFrames(page.pageId, listener, options);
  }
  /** Host-only: operator input on the same page, used while the session is paused for the operator. */
  async operatorInput(input: EngineOperatorInput, pageId?: string): Promise<void> {
    if (this.closed) throw new EngineError("session_closed");
    const page = this.bindPage(pageId);
    if ((input.type === "mouse" && input.action === "down") || (input.type === "key" && input.action === "down") || input.type === "text") await this.front(page);
    await this.live.operatorInput(this.directory.route(this.directory.binding(page, 1)), input);
  }
  /**
   * Chrome paints, screencasts and fully runs only the tab in front. A tab the site opens takes the front while the
   * session may keep working on another page, whose reads then stall and whose live view goes blank.
   */
  private async front(page: EnginePageStamp): Promise<void> {
    if (!this.connection.ownsBrowser) return; // Never move the tabs of a person's own browser.
    let route: string;
    try { route = this.directory.route(this.directory.binding(page, 1)); } catch { return; }
    await this.connection.wire.send("Page.bringToFront", {}, route).catch(() => undefined);
  }
  async readyPage(context: CommandContext, page: EnginePageStamp): Promise<{ page: EnginePageStamp } | { observation: EngineObservation }> {
    await this.front(page);
    if (!this.pendingNavigations.has(page.pageId)) return { page };
    const committed = await this.awaitCommittedNavigation(context, page);
    return this.pendingNavigations.has(page.pageId) && !committed ? { observation: this.pendingNavigationView(page) } : { page: committed ?? page };
  }
  // Chromium stalls accessibility reads of a document whose replacement is
  // still loading. Report the pending navigation; the next read gets the new page.
  private pendingNavigationView(page: EnginePageStamp): EngineObservation {
    const url = this.pendingNavigations.get(page.pageId);
    return { state: "incomplete", trust: "untrusted_page_content", scope: "page", page, nodes: [], incompleteReason: "evidence_unavailable",
      navigation: { state: "pending", ...(url ? { url: url.slice(0, 256) } : {}) } };
  }
  private async awaitCommittedNavigation(context: CommandContext, page: EnginePageStamp): Promise<EnginePageStamp | undefined> {
    if (!this.pendingNavigations.has(page.pageId)) {
      const current = this.directory.stamp(page.pageId);
      return current.documentGeneration === page.documentGeneration ? undefined : current;
    }
    const remaining = context.deadline - performance.now();
    const deadline = performance.now() + Math.max(0, remaining - Math.min(2_000, remaining / 4));
    while (this.pendingNavigations.has(page.pageId) && this.directory.stamp(page.pageId).documentGeneration === page.documentGeneration) {
      if ([...this.dialogs.values()].some(dialog => dialog.pageId === page.pageId) || performance.now() >= deadline) return undefined;
      try { await this.waitForCondition(context, deadline); } catch (error) { if (error instanceof EngineError && error.code === "timed_out") return undefined; throw error; }
    }
    const current = this.directory.stamp(page.pageId);
    if (current.documentGeneration === page.documentGeneration) return undefined;
    // Give the new document a bounded moment to parse; read it as it is after that.
    const loader = this.directory.loader(current), parsed = Math.min(deadline, performance.now() + 1_000);
    while (!this.lifecycle.get(loader)?.has("DOMContentLoaded") && performance.now() < parsed) {
      try { await this.waitForCondition(context, parsed); } catch (error) { if (error instanceof EngineError && error.code === "timed_out") break; throw error; }
    }
    return this.directory.stamp(page.pageId);
  }
  private async observeLocalFeedback(context: CommandContext, page: EnginePageStamp, budgetValue: number | EngineObservationBudget): Promise<EngineObservation> {
    const budget=asObservationBudget(budgetValue);
    const binding = this.localField; this.localField = undefined;
    const fileNames=this.localFileNames;this.localFileNames=undefined;
    if (!binding || [...this.dialogs.values()].some(dialog => dialog.pageId === page.pageId)) return this.observe(context, page, budget);
    this.directory.route(binding);
    const facts = await this.resolver.inspect(context, binding, { actionable: false, editable: false, allowSensitive: true });
    const tree = await context.read(() => this.send(binding, "Accessibility.getPartialAXTree", { backendNodeId: binding.backendNodeId, fetchRelatives: true }));
    // Error relationships need not include text in a partial AX tree. Read only
    // those explicitly related containers through the same bounded document reader.
    const rawField = array(tree.nodes).find(candidate => candidate.backendDOMNodeId === binding.backendNodeId);
    const errors = array(object(array(rawField?.properties).find(property => property.name === "errormessage")?.value).relatedNodes);
    let validationIncomplete = errors.length > 4;
    for (const related of errors.slice(0,4)) {
      if (typeof related.text === "string" && related.text) continue;
      try {
        const errorBinding = this.directory.binding(binding, Number(related.backendDOMNodeId));
        const read = await this.readBoundText(context,errorBinding,1024,256,true);
        related.text = read.text; validationIncomplete ||= read.truncated;
      } catch(error) { if(context.cancellation)throw error;validationIncomplete=true; }
    }
    const projected = readAXControls(array(tree.nodes));
    const control = projected.controls.find(candidate => candidate.backendNodeId === binding.backendNodeId)??(fileNames&&facts.type==='file'?{view:{role:'button',name:'File input',readonly:false,disabled:facts.disabled}}:undefined);
    if (!control) throw new EngineError("evidence_unavailable");
    const view:Omit<EngineFieldView,'ref'> = { ...control.view,
      ...(facts.readonly ? { readonly: true } : {}), ...(facts.disabled ? { disabled: true } : {}), ...(facts.value === undefined ? {} : { value: facts.value }),...(fileNames&&facts.type==='file'?{fileNames,fileCount:fileNames.length}:{}) };
    // Select the complete public view before allocating its actionable reference.
    const preview=(node:typeof view):EngineObservation=>({state:"incomplete",trust:"untrusted_page_content",scope:"target",page,snapshotId:"s9007199254740991",expiredSnapshots:["s9007199254740991","s9007199254740991"],incompleteReason:"output_limit",nodes:[{...node,ref:"e9007199254740991"}]});
    let selected=view,limited=false;
    if(!budget.fits(preview(selected))){const {value:_value,...withoutValue}=selected;selected=withoutValue;limited=true;}
    if(!budget.fits(preview(selected))){const {fileNames:_fileNames,...withoutNames}=selected;selected=withoutNames;limited=true;}
    if(!budget.fits(preview(selected))){const {context:_context,description:_description,validation:_validation,...essential}=selected;selected=essential;limited=true;}
    if(!budget.fits(preview(selected)))throw new EngineError("output_budget");
    const feedback=[selected],bindings=[binding];
    let relatedIncomplete=false;
    // Only native AX relationships authorize widening an edit's feedback. An
    // ordinary text field keeps its cheap local read; an expanded combobox can
    // return the options needed for the next decision without a page-wide scan.
    const properties=array(rawField?.properties);
    const expanded=object(properties.find(property=>property.name==='expanded')?.value).value;
    if(expanded===true){
      const related=new Set<number>();
      for(const property of properties)if(property.name==='controls'||property.name==='owns'){
        for(const node of array(object(property.value).relatedNodes))if(Number.isSafeInteger(node.backendDOMNodeId)&&Number(node.backendDOMNodeId)>0)related.add(Number(node.backendDOMNodeId));
      }
      relatedIncomplete=related.size>4;
      for(const backendNodeId of [...related].slice(0,4)){
        const relatedBinding=this.directory.binding(binding,backendNodeId);
        try{
          const ax=await readAXSnapshot((method,params)=>context.read(()=>this.send(relatedBinding,method,params)),binding.frameId,backendNodeId,{maxNodes:256,maxExpansionCalls:8});
          const controls=readAXControls(ax.nodes,backendNodeId);
          relatedIncomplete ||= ax.incomplete||controls.incomplete||!controls.foundScope;
          for(const item of controls.controls){
            if(bindings.some(existing=>existing.backendNodeId===item.backendNodeId))continue;
            if(feedback.length>=33){relatedIncomplete=true;break;}
            const candidate={...item.view};
            const proposed={...preview(selected),nodes:[...feedback,candidate].map(node=>({...node,ref:'e9007199254740991'}))};
            if(!budget.fits(proposed)){limited=true;continue;}
            feedback.push(candidate);bindings.push(this.directory.binding(binding,item.backendNodeId));
          }
        }catch(error){
          if(context.cancellation||error instanceof EngineError&&error.code==='stale_target')throw error;
          relatedIncomplete=true;
        }
      }
    }
    const published = this.directory.publish(bindings);
    const incomplete=projected.incomplete||validationIncomplete||relatedIncomplete;
    return { state: !limited && !incomplete ? "available" : "incomplete", trust: "untrusted_page_content", scope: "target", page, snapshotId: published.snapshotId,
      ...(limited?{incompleteReason:"output_limit" as const}:incomplete?{incompleteReason:"work_limit" as const}:{}),expiredSnapshots: published.expiredSnapshots, nodes: feedback.map((node,index)=>({...node,ref:published.refs[index]!})) };
  }
  async observe(context: CommandContext, page: EnginePageStamp, budgetValue: number | EngineObservationBudget, recordMode = false, scope?: EngineTarget, query?: EngineControlQuery): Promise<EngineObservation> {
    const budget=asObservationBudget(budgetValue);
    context.checkpoint();
    const dialog = [...this.dialogs.values()].find(item => item.pageId === page.pageId);
    if (dialog) {
      const view=(end:number):EngineObservation=>({state:end===dialog.message.length?"available":"incomplete",trust:"untrusted_page_content",scope:"dialog",page,nodes:[],...(end===dialog.message.length?{}:{incompleteReason:"output_limit" as const}),dialog:{dialogId:dialog.id,type:dialog.type,message:dialog.message.slice(0,end)}});
      if(budget.fits(view(dialog.message.length)))return view(dialog.message.length);
      let low=0,high=dialog.message.length;
      while(low<high){const middle=Math.ceil((low+high)/2);if(budget.fits(view(middle)))low=middle;else high=middle-1;}
      if(!budget.fits(view(low)))throw new EngineError("output_budget");
      return view(low);
    }
    // Wait for known attachment work, not arbitrary page/network quietness.
    if (this.pendingAttachments.size) await context.read(() => Promise.all([...this.pendingAttachments]));
    const scoped = scope ? await this.resolver.resolve(context, page, scope) : undefined;
    const candidates: { view: ReturnType<typeof readAXControls>["controls"][number]["view"]; binding: NodeBinding; primary: boolean }[] = [];
    this.prunePendingFrames();
    let incomplete = this.pendingAttachments.size > 0 || this.pendingFrames.size > 0 || this.degraded;
    let readFailed=false;
    let visited = 0;
    // Lifecycle metadata belongs to this document even when its AX tree is not
    // ready yet. Never borrow metadata from a different generation.
    const metadata=this.directory.inventory().find(item=>item.pageId===page.pageId&&item.documentGeneration===page.documentGeneration);
    let title: string | undefined=metadata?.title;
    let url: string | undefined=metadata?.url;
    const includedScopes=new Map<string,NodeBinding>();
    if(scoped){
      includedScopes.set(scoped.frameId,scoped);
      const pending=this.directory.frames(page.pageId).filter(frame=>frame.frameId!==scoped.frameId);
      for(let pass=0;pass<16&&pending.length;pass++){
        let progressed=false;
        for(let index=0;index<pending.length;){
          const frame=pending[index]!,parent=this.directory.parent(frame),container=parent&&includedScopes.get(parent.frameId);
          if(!container){index++;continue;}
          pending.splice(index,1);progressed=true;
          if(includedScopes.size>=17){incomplete=true;continue;}
          if(await this.frameWithinScope(context,container,frame))includedScopes.set(frame.frameId,await this.resolver.document(context,frame));
        }
        if(!progressed)break;
      }
      if(pending.some(frame=>{const parent=this.directory.parent(frame);return parent&&includedScopes.has(parent.frameId);}))incomplete=true;
    }
    for (const frame of this.directory.frames(page.pageId)) {
      if (scoped && !includedScopes.has(frame.frameId)) continue;
      const scopeNode=scoped?.frameId===frame.frameId?scoped.backendNodeId:undefined;
      try {
        const binding = this.directory.binding(frame, 1);
        let result = await readAXSnapshot((method, params) => context.read(() => this.send(binding, method, params)), frame.frameId, scopeNode);
        // A committed document can precede an observable AX root. Refresh only
        // after a proven loading transition, using the existing deadline. Pages
        // with usable controls never acquire a global load/settle wait.
        if(!scoped&&frame.frameId===page.frameId&&!readAXControls(result.nodes).controls.length){
          const ready=await context.read(()=>this.send(binding,'Runtime.evaluate',{expression:'document.readyState',returnByValue:true,silent:true}));
          if(object(ready.result).value==='loading'){
            await this.waitForDocument(context,this.directory.loader(frame),page.pageId);
            result=await readAXSnapshot((method,params)=>context.read(()=>this.send(binding,method,params)),frame.frameId);
          }
        }
        incomplete ||= result.incomplete;
        const raw = array(result.nodes); visited += raw.length;
        if (frame.frameId === page.frameId) {
          const root = raw.find(node => object(node.role).value === "RootWebArea");
          if (root) {
            title = string(object(root.name).value).slice(0, 256);
            const location = string(object(array(root.properties).find(property => property.name === "url")?.value).value);
            if (location && location.length <= 1024) url = location;
          }
        }
        if (visited > 20_000) { incomplete = true; break; }
        const projection = readAXControls(raw, scopeNode);
        if (!projection.foundScope) throw new EngineError("evidence_unavailable");
        incomplete ||= projection.incomplete;
        for (const {backendNodeId,view} of projection.controls) candidates.push({ view, binding: this.directory.binding(frame, backendNodeId), primary: result.primary.has(backendNodeId) });
      } catch(error) {
        if(scoped||context.cancellation)throw error;
        if(error instanceof EngineError&&error.code==='stale_target'){
          // A child committing during discovery invalidates its own results,
          // not the root document. Root identity must still be current.
          this.directory.binding(page,1);
          if(frame.frameId===page.frameId)throw error;
          incomplete=true;continue;
        }
        incomplete=true;readFailed=true;
      }
    }
    // D29/D4: controls the accessibility tree misses (script-driven clickables) and a layer covering the page.
    let cover: { text: string } | undefined;
    const coverIds = new Set<number>();
    if (!scoped && !readFailed) {
      try {
        const extras = await this.discoverPageExtras(context, page);
        const known = new Set(candidates.filter(item => item.binding.frameId === page.frameId).map(item => item.binding.backendNodeId));
        for (const item of [...extras.cover, ...extras.clickables]) {
          if (known.has(item.backendNodeId)) continue;
          known.add(item.backendNodeId);
          candidates.push({ view: { role: "clickable", name: item.name }, binding: this.directory.binding(page, item.backendNodeId), primary: false });
        }
        for (const item of extras.cover) coverIds.add(item.backendNodeId);
        if (extras.coverText !== undefined) cover = { text: extras.coverText };
        incomplete ||= extras.incomplete;
      } catch (error) { if (context.cancellation || error instanceof EngineError && error.code === "stale_target") throw error; }
    }
    const nodes: ReturnType<typeof readAXControls>["controls"][number]["view"][] = [];
    const bindings: NodeBinding[] = [];
    let outputLimited=false;
    const preview=(views:typeof nodes):EngineObservation=>({state:"incomplete",trust:"untrusted_page_content",scope:scoped?"target":"page",page,...(title===undefined?{}:{title}),...(url===undefined?{}:{url}),snapshotId:"s9007199254740991",expiredSnapshots:["s9007199254740991","s9007199254740991"],incompleteReason:"rendered_subset",nodes:views.map(view=>({...view,ref:"e9007199254740991"}))});
    if(!budget.fits(preview([])))throw new EngineError("output_budget");
    // Keep edit/search controls discoverable under a compact default budget. DOM
    // order is retained within each class; navigation-link chrome must not crowd
    // every field out of the initial state.
    // A dialog's controls come first: it covers the page and must be handled.
    const priority = (view: { role: string; context?: readonly { role: string }[] }, binding?: NodeBinding) => {
      if (view.context?.some(item => item.role === "dialog" || item.role === "alertdialog")) return -1;
      if (binding && binding.frameId === page.frameId && coverIds.has(binding.backendNodeId)) return -1;
      return ["textbox", "searchbox", "combobox", "spinbutton", "textarea", "listbox"].includes(view.role) ? 0
        : ["button", "checkbox", "radio", "switch", "slider", "tab"].includes(view.role) ? 1 : 2;
    };
    if (query) {
      const needle = query.text?.toLocaleLowerCase();
      const matches = (view: typeof candidates[number]["view"]) => (!query.role || view.role === query.role)
        && (!needle || [view.name, view.description ?? "", ...(view.context ?? []).map(item => item.name)].some(value => value.toLocaleLowerCase().includes(needle)));
      for (let index = candidates.length - 1; index >= 0; index--) if (!matches(candidates[index]!.view)) candidates.splice(index, 1);
    }
    candidates.sort((left, right) => priority(left.view, left.binding) - priority(right.view, right.binding) || Number(right.primary) - Number(left.primary));
    for (const { view: projected, binding } of candidates.slice(0, 512)) {
      try{this.directory.route(binding);}catch(error){
        if(scoped||binding.frameId===page.frameId)throw error;
        this.directory.binding(page,1);incomplete=true;continue;
      }
      const identity = recordMode ? { recordId: 'n' + createHash('sha256').update(JSON.stringify(binding)).digest('hex').slice(0, 32), kind: "control" as const } : {};
      const view = { ...identity, ...projected };
      if(!budget.fits(preview([...nodes,view]))){outputLimited=true;continue;}
      nodes.push(view); bindings.push(binding);
    }
    context.checkpoint();
    this.directory.describe(page,{title,url});
    const published = this.directory.publish(bindings);
    return { state: incomplete || nodes.length < candidates.length ? "incomplete" : "available", trust: "untrusted_page_content", scope: scoped ? "target" : "page",
      page, ...(title === undefined ? {} : { title }), ...(url === undefined ? {} : { url }), ...(cover ? { cover } : {}),
      ...(outputLimited?{incompleteReason:"output_limit" as const}:readFailed?{incompleteReason:"evidence_unavailable" as const}:incomplete?{incompleteReason:"rendered_subset" as const}:nodes.length<candidates.length?{incompleteReason:"work_limit" as const}:{}),
      snapshotId: published.snapshotId, expiredSnapshots: published.expiredSnapshots,
      nodes: nodes.map((node, i) => ({ ...node, ref: published.refs[i]! })) };
  }
  /** One bounded read-only page query. Role-less elements that act like buttons (pointer cursor, onclick or
   * tabindex, a visible label, no interactive child), and a fixed layer covering the viewport centre with its controls. */
  private async discoverPageExtras(context: CommandContext, page: EnginePageStamp): Promise<{
    clickables: { backendNodeId: number; name: string }[]; cover: { backendNodeId: number; name: string }[]; coverText?: string; incomplete: boolean }> {
    const binding = this.directory.binding(page, 1);
    const send = (method: string, params: Record<string, unknown>) => context.read(() => this.send(binding, method, params));
    const group = "newton-browser-discovery";
    try {
      const evaluated = object(await send("Runtime.evaluate", { expression: PAGE_EXTRAS_SCRIPT, returnByValue: false, silent: true, objectGroup: group }));
      const resultId = string(object(evaluated.result).objectId);
      if (!resultId) return { clickables: [], cover: [], incomplete: false };
      const fields = array(object(await send("Runtime.getProperties", { objectId: resultId, ownProperties: true })).result);
      const field = (name: string) => object(object(fields.find(item => item.name === name)).value);
      const elements = async (name: string, max: number) => {
        const listId = string(field(name).objectId);
        if (!listId) return [];
        const entries = array(object(await send("Runtime.getProperties", { objectId: listId, ownProperties: true })).result)
          .filter(item => /^[0-9]+$/u.test(string(item.name))).sort((a, b) => Number(a.name) - Number(b.name)).slice(0, max);
        const found: { backendNodeId: number; name: string }[] = [];
        for (const entry of entries) {
          const pair = array(object(await send("Runtime.getProperties", { objectId: string(object(entry.value).objectId), ownProperties: true })).result);
          const elementId = string(object(object(pair.find(item => item.name === "0")).value).objectId);
          const label = string(object(object(pair.find(item => item.name === "1")).value).value).slice(0, 120);
          if (!elementId || !label) continue;
          const node = object(object(await send("DOM.describeNode", { objectId: elementId })).node);
          if (Number.isSafeInteger(node.backendNodeId) && Number(node.backendNodeId) > 0) found.push({ backendNodeId: Number(node.backendNodeId), name: label });
        }
        return found;
      };
      const coverTextValue = field("coverText").value;
      return { clickables: await elements("clickables", 24), cover: await elements("cover", 16),
        ...(typeof coverTextValue === "string" ? { coverText: coverTextValue.slice(0, 160) } : {}), incomplete: field("incomplete").value === true };
    } finally {
      await send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => undefined);
    }
  }
  async readRecords(context:CommandContext,page:EnginePageStamp,budget:EngineObservationBudget,shape:EngineRecordShape,scope?:EngineTarget):Promise<EngineObservation>{
    if(shape==='controls'||[...this.dialogs.values()].some(dialog=>dialog.pageId===page.pageId))return this.observe(context,page,budget,true,scope);
    return readStructuredRecords(context,page,budget,shape,scope,{directory:this.directory,resolver:this.resolver,send:(binding,method,params)=>this.send(binding,method,params)});
  }
  async readDocument(context: CommandContext, page: EnginePageStamp, budgetValue: number | EngineObservationBudget, cursor?: string, scope?: EngineTarget): Promise<EngineObservation> {
    const budget=asObservationBudget(budgetValue);
    if ([...this.dialogs.values()].some(dialog => dialog.pageId === page.pageId)) return this.observe(context, page, budget);
    for (const [id,snapshot] of this.documents) if(snapshot.expiresAt<=performance.now()) {this.documentBytes-=snapshot.bytes;this.documents.delete(id);}
    let snapshotId: string;
    let offset = 0;
    if (cursor) {
      const match = /^doc:(d[1-9][0-9]*):([0-9]+)$/u.exec(cursor);
      const snapshot = match ? this.documents.get(match[1]!) : undefined;
      if (!snapshot || snapshot.page.pageId !== page.pageId || snapshot.ownerGeneration !== page.documentGeneration) throw new EngineError("cursor_expired");
      try { this.directory.binding(snapshot.page,1); } catch { throw new EngineError("cursor_expired"); }
      try { for(const frame of snapshot.participants??[])this.directory.binding(frame,1); } catch { throw new EngineError('cursor_expired'); }
      snapshotId = match![1]!; offset = Number(match![2]);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.text.length) throw new EngineError("cursor_expired");
    } else {
      let root: NodeBinding;
      let extracted: Awaited<ReturnType<PageExecutor['readBoundText']>>;
      for (;;) {
        context.checkpoint();
        root = scope ? await this.resolver.resolve(context,page,scope) : await this.resolver.document(context,page);
        extracted = await this.readBoundText(context,root,DOCUMENT_WORK_CHARS,DOCUMENT_WORK_NODES,scope!==undefined);
        if (!extracted.loading) break;
        // A committed but still-parsing document is not a complete empty page.
        // Wake on its actual lifecycle/DOM transition; never cache that prefix.
        await this.waitForCondition(context,context.deadline);
        page = this.directory.stamp(page.pageId);
      }
      this.directory.binding(page, 1);
      const participants:EnginePageStamp[]=[];
      {
        const included=new Map<string,NodeBinding>([[root.frameId,root]]);
        let remainingNodes=DOCUMENT_WORK_NODES-(extracted.visited??DOCUMENT_WORK_NODES);
        const pending=this.directory.frames(page.pageId).filter(frame=>frame.frameId!==root.frameId);
        for(let pass=0;pass<16&&pending.length;pass++){
          let progressed=false;
          for(let index=0;index<pending.length;){
            const frame=pending[index]!,parent=this.directory.parent(frame),container=parent&&included.get(parent.frameId);
            if(!container){index++;continue;}
            pending.splice(index,1);progressed=true;
            if(participants.length>=16||remainingNodes<=0||extracted.text.length>=DOCUMENT_WORK_CHARS){extracted.truncated=true;continue;}
            if(!await this.frameWithinScope(context,container,frame,container===root&&scope!==undefined))continue;
            const child=await this.resolver.document(context,frame);
            const marker='\n[Embedded frame]\n';
            if(DOCUMENT_WORK_CHARS-extracted.text.length<=marker.length){extracted.truncated=true;continue;}
            const content=await this.readBoundText(context,child,DOCUMENT_WORK_CHARS-extracted.text.length-marker.length,remainingNodes,false);
            remainingNodes-=content.visited??remainingNodes;
            extracted.text+=marker+content.text;
            extracted.truncated ||= content.truncated||content.loading===true;
            participants.push(frame);included.set(frame.frameId,child);
          }
          if(!progressed)break;
        }
        if(pending.some(frame=>{const parent=this.directory.parent(frame);return parent&&included.has(parent.frameId);}))extracted.truncated=true;
        for(const frame of participants)this.directory.binding(frame,1);
      }
      const redacted = extracted.text;
      const text = boundDocumentUtf8(redacted, DOCUMENT_CACHE_BYTES);
      const complete = !extracted.truncated && text.length === redacted.length;
      snapshotId = `d${this.nextDocumentSnapshot++}`;
      const bytes = Buffer.byteLength(text, "utf8");
      this.documents.set(snapshotId, { page: {pageId:root.pageId,frameId:root.frameId,documentGeneration:root.documentGeneration},participants, ownerGeneration: page.documentGeneration, text, bytes, complete, expiresAt:performance.now()+DOCUMENT_TTL_MS });
      this.documentBytes += bytes;
      while (this.documents.size > 8 || this.documentBytes > DOCUMENT_CACHE_BYTES) {
        const oldest = this.documents.keys().next().value!;
        this.documentBytes -= this.documents.get(oldest)!.bytes; this.documents.delete(oldest);
      }
    }
    const snapshot = this.documents.get(snapshotId)!;
    return documentChunk(snapshot.text, snapshot.page, snapshotId, offset, budget, snapshot.complete);
  }
  private async frameWithinScope(context:CommandContext,container:NodeBinding,frame:EnginePageStamp,useThis=true,preferMain=true):Promise<boolean>{
    const owner=await context.read(()=>this.send(container,'DOM.getFrameOwner',{frameId:frame.frameId}));
    const root=await context.read(()=>this.send(container,'DOM.resolveNode',{backendNodeId:container.backendNodeId}));
    const rootId=string(object(root.object).objectId);let childId='';
    try{
      const child=await context.read(()=>this.send(container,'DOM.resolveNode',{backendNodeId:Number(owner.backendNodeId)}));
      childId=string(object(child.object).objectId);
      if(!rootId||!childId)throw new EngineError('evidence_unavailable');
      // Both objects resolve in our isolated world. Native assignedNodes() is read-only,
      // but Chromium's debug side-effect checker rejects it when examining slot fallback.
      const result=await context.read(()=>this.send(container,'Runtime.callFunctionOn',{objectId:rootId,functionDeclaration:FRAME_SCOPE_FUNCTION,arguments:[{objectId:childId},{value:useThis},{value:preferMain}],returnByValue:true,silent:true}));
      const value=object(result.result).value;
      if(result.exceptionDetails||typeof value!=='boolean')throw new EngineError('evidence_unavailable');
      this.directory.route(container);return value;
    }finally{for(const objectId of [rootId,childId])if(objectId)void this.send(container,'Runtime.releaseObject',{objectId}).catch(()=>undefined);}
  }
  private async readBoundText(context:CommandContext,binding:NodeBinding,maxChars:number,maxNodes:number,useThis:boolean,preferMain=true,matchText?:string):Promise<{text:string;truncated:boolean;loading?:boolean;visited?:number;matched?:boolean;characters?:number}> {
    const resolved=await context.read(()=>this.send(binding,"DOM.resolveNode",{backendNodeId:binding.backendNodeId}));
    const objectId=string(object(resolved.object).objectId);
    if(!objectId)throw new EngineError("evidence_unavailable");
    try {
      const result=await context.read(()=>this.send(binding,"Runtime.callFunctionOn",{objectId,functionDeclaration:DOCUMENT_READ_FUNCTION,arguments:[{value:maxChars},{value:maxNodes},{value:useThis},{value:matchText===undefined},{value:preferMain},...(matchText===undefined?[]:[{value:matchText}])],returnByValue:true,silent:true}));
      if(result.exceptionDetails)throw new EngineError("evidence_unavailable");
      this.directory.route(binding);
      const read=object(object(result.result).value);
      if(typeof read.text!=="string"||typeof read.truncated!=="boolean")throw new EngineError("evidence_unavailable");
      if(matchText!==undefined&&!read.loading&&typeof read.matched!=='boolean'&&!(read.text===''&&!read.truncated))throw new EngineError('evidence_unavailable');
      return {text:read.text,truncated:read.truncated,...(typeof read.matched==='boolean'?{matched:read.matched}:{}),...(Number.isSafeInteger(read.characters)&&Number(read.characters)>=0?{characters:Number(read.characters)}:{}),...(Number.isSafeInteger(read.visited)&&Number(read.visited)>=0?{visited:Number(read.visited)}:{}),...(read.loading===true?{loading:true}:{})};
    } finally {void this.send(binding,"Runtime.releaseObject",{objectId}).catch(()=>undefined);}
  }
  async screenshot(context: CommandContext, page: EnginePageStamp, budgetValue: number | EngineObservationBudget, rawOptions: unknown): Promise<EngineObservation> {
    await this.front(page);
    const capture=()=>this.captureScreenshot(context,page,budgetValue,rawOptions,false);
    if(this.connection.ownsBrowser||object(rawOptions).fullPage!==true)return capture();
    const root=this.directory.binding(page,1);
    const visibility=await context.read(()=>this.send(root,'Runtime.evaluate',{expression:'document.visibilityState',returnByValue:true,silent:true}));
    if(object(visibility.result).value!=='hidden')return capture();
    if(this.captureObservations.has(page.pageId))throw new EngineError('evidence_unavailable');
    const route=this.directory.route(root);
    this.captureObservations.add(page.pageId);
    // Tiny native observations keep hidden surfaces capturable. Do not acknowledge
    // frames: Chromium's in-flight bound prevents an ongoing image stream.
    const started=Promise.resolve().then(()=>this.connection.wire.send('Page.startScreencast',{format:'png',maxWidth:1,maxHeight:1},route));
    try{await context.read(()=>started);return await capture();}
    finally{
      // Await late start completion even after cancellation, then stop on the exact
      // original route. Keep ownership until cleanup settles to prevent late-stop races.
      const stop=()=>this.connection.wire.send('Page.stopScreencast',{},route);
      const cleanup=started.then(stop,stop).then(()=>undefined).catch(error=>{
        this.fault=error;void this.close().catch(()=>undefined);throw error;
      }).finally(()=>this.captureObservations.delete(page.pageId));
      void cleanup.catch(()=>undefined);
      await context.read(()=>cleanup);
    }
  }
  private async captureScreenshot(context: CommandContext, page: EnginePageStamp, budgetValue: number | EngineObservationBudget, rawOptions: unknown, recaptured: boolean): Promise<EngineObservation> {
    const budget=asObservationBudget(budgetValue),maxBytes=budget.maxBytes;
    if ([...this.dialogs.values()].some(dialog => dialog.pageId === page.pageId)) return this.observe(context, page, budget);
    const options = rawOptions && typeof rawOptions === "object" && !Array.isArray(rawOptions) ? rawOptions as Record<string, unknown> : {};
    const zones = Array.isArray(options.sensitiveZones) ? options.sensitiveZones : [];
    if(this.pendingAttachments.size)await context.read(()=>Promise.all([...this.pendingAttachments]));
    this.prunePendingFrames();
    if(this.pendingFrames.size)throw new EngineError('evidence_unavailable');
    const root = this.directory.binding(page, 1);
    const spatial = await this.captureSpatialState(context, root);
    const viewport = { width: spatial.width, height: spatial.height };
    const rawClip = object(options.clip);
    let defaultClip={ x: spatial.pageX, y: spatial.pageY, width: viewport.width, height: viewport.height };
    if(options.fullPage===true&&options.clip===undefined){
      const metrics=await context.read(()=>this.send(root,'Page.getLayoutMetrics',{}));
      const content=object(metrics.cssContentSize??metrics.contentSize);
      if(!finiteNumber(content.x)||!finiteNumber(content.y)||!finiteNumber(content.width)||!finiteNumber(content.height)||content.width<=0||content.height<=0)throw new EngineError('evidence_unavailable');
      defaultClip={x:content.x,y:content.y,width:content.width,height:content.height};
    }
    const clip = finiteNumber(rawClip.x) && finiteNumber(rawClip.y) && finiteNumber(rawClip.width) && finiteNumber(rawClip.height)
      ? { x: Number(rawClip.x), y: Number(rawClip.y), width: Number(rawClip.width), height: Number(rawClip.height) }
      : defaultClip;
    if(clip.width*clip.height*spatial.deviceScaleFactor**2>MAX_RASTER_PIXELS)throw new EngineError('output_budget');
    const collectRegions=async()=>{
    const regions: { x: number; y: number; width: number; height: number }[] = [];
    for (const target of zones) {
      const binding = await this.resolver.resolve(context, page, target as EngineTarget);
      if (binding.frameId !== page.frameId) throw new EngineError("unsupported_capability");
      const facts = await this.resolver.inspect(context, binding, { editable: false, allowSensitive: true });
      if (!facts.bbox) throw new EngineError("evidence_unavailable");
      regions.push({...facts.bbox,x:facts.bbox.x+spatial.pageX-spatial.offsetX,y:facts.bbox.y+spatial.pageY-spatial.offsetY});
    }
    const discovered=await nativeSensitiveRegions(context,this.directory,this.readonlyWorlds,this.connection.wire,page);
      for(const region of discovered.regions){
        const mapped={x:region.x+spatial.pageX-spatial.offsetX,y:region.y+spatial.pageY-spatial.offsetY,width:region.width,height:region.height};
        if(!regions.some(existing=>existing.x===mapped.x&&existing.y===mapped.y&&existing.width===mapped.width&&existing.height===mapped.height))regions.push(mapped);
        if(regions.length>32)throw new EngineError('work_limit');
      }
    return {regions,frames:discovered.frames};
    };
    const collected=await collectRegions(),regions=collected.regions;
    const result = await context.read(() => this.send(root, "Page.captureScreenshot", {
      format: "png", fromSurface: true, captureBeyondViewport: options.fullPage === true,
      clip: { ...clip, scale: 1 },
    }));
    const data = string(result.data);
    if (!data) throw new EngineError("evidence_unavailable");
    this.directory.route(root);
    if(!sameCaptureSpatial(spatial,await this.captureSpatialState(context,root))){
      // Native full-page capture can change scrollbar geometry. Discard its pixels
      // and rebuild all evidence once, sharing the original cancellation/deadline.
      if(options.fullPage===true&&!recaptured&&!this.pendingAttachments.size&&!this.pendingFrames.size){
        const after=await collectRegions();
        if(!this.pendingAttachments.size&&!this.pendingFrames.size&&JSON.stringify(collected.frames)===JSON.stringify(after.frames))return this.captureScreenshot(context,page,budget,rawOptions,true);
      }
      throw new EngineError('stale_target');
    }
    if(this.pendingAttachments.size||this.pendingFrames.size||JSON.stringify(collected)!==JSON.stringify(await collectRegions()))throw new EngineError('stale_target');
    let masked: ReturnType<typeof maskCapturedPng>;
    try { masked = maskCapturedPng(data, clip, regions); } catch { throw new EngineError("evidence_unavailable"); }
    if (Buffer.byteLength(masked.base64, "utf8") > maxBytes) throw new EngineError("output_budget");
    const captureId = `c${this.nextCapture++}`;
    const observation:EngineObservation={ state: "available", trust: "untrusted_page_content", scope: "page", nodes: [], imageData: masked.base64, mimeType: "image/png",
      provenance: { pageId: page.pageId, documentGeneration: page.documentGeneration, captureId, viewport, clip, maskDisposition: masked.appliedRegions>0?"mask_applied":"mask_not_applicable" } };
    if(!budget.fits(observation))throw new EngineError("output_budget");
    this.captures.set(captureId, {
      captureBeyondViewport:options.fullPage===true,
      pageId: page.pageId,
      documentGeneration: page.documentGeneration,
      clip,
      spatial,
      regions,
      maskedDigest: createHash("sha256").update(masked.base64, "utf8").digest("hex"),
    });
    while (this.captures.size > 32) this.captures.delete(this.captures.keys().next().value!);
    return observation;
  }
  async close(): Promise<void> {
    this.closed = true; this.unsubscribe?.(); this.live.close(); this.diagnostics.close();
    for(const pending of this.pageAttachments.values())pending.controller.abort();
    this.pageAttachments.clear();this.attachingPages.clear();
    this.readonlyWorlds.clear();
    this.documents.clear(); this.documentBytes = 0; this.captures.clear(); this.pointerDocuments.clear(); this.viewportFrames.clear();this.domRevisions.clear();
    // Runtime closure is independent of held cleanup acknowledgements.
    await this.connection.close();
    this.suspendedInputs.clear(); this.dialogs.clear(); this.dialogWaiters.clear();
  }
  private async attach(pageId: string, route: string, isPage: boolean, parentFrameId?: string, signal?:AbortSignal): Promise<void> {
    const send=async(method:string,params:RecordValue={})=>{
      if(signal?.aborted)throw new EngineError('unknown_page');
      const result=await this.connection.wire.send(method,params,route);
      if(signal?.aborted)throw new EngineError('unknown_page');
      return result;
    };
    this.directory.registerRoute(route);
    if (parentFrameId) this.routeParents.set(route, parentFrameId);
    this.directory.addPage(pageId); this.routes.set(route, pageId);
    await send("Page.enable");
    await send("DOM.enable");
    await send("Accessibility.enable");
    // Enabling the domain (without any highlight/inspect command) also requests
    // unbuffered debugger input in Chromium. This prevents hidden mouse moves
    // from waiting for the renderer's five-second animation-frame fallback.
    await send("Overlay.enable");
    await send("Page.setLifecycleEventsEnabled", { enabled: true });
    if (isPage && this.timezone) await send("Emulation.setTimezoneOverride", { timezoneId: this.timezone });
    if (isPage) await this.live.attachPage(route, send);
    await this.diagnostics.attachRoute(send);
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const tree = await send("Page.getFrameTree");
    if(this.routes.get(route)!==pageId)return;
    const frameTree = object(tree.frameTree);
    if (!isPage && parentFrameId && !object(frameTree.frame).parentId) frameTree.frame = { ...object(frameTree.frame), parentId: parentFrameId };
    if (isPage || object(frameTree.frame).parentId) this.frameTree(pageId, frameTree, route);
  }
  private frame(pageId: string, frame: RecordValue, route: string): void {
    const frameId = string(frame.id); const loaderId = string(frame.loaderId);
    if (!frameId || !loaderId) return;
    const parentId = string(frame.parentId) || this.routeParents.get(route) || "";
    this.directory.navigate(pageId, { frameId, loaderId, route, url:string(frame.url), ...(parentId ? { parentId } : {}) });
    this.pendingFrames.delete(frameId);
  }
  /** A frame that has not committed within ten seconds is treated as abandoned. */
  private prunePendingFrames(): void {
    const cutoff = performance.now() - 10_000;
    for (const [frameId, seen] of this.pendingFrames) if (seen < cutoff) { this.pendingFrames.delete(frameId); this.degraded = true; }
  }
  private frameTree(pageId: string, tree: RecordValue, route: string): void {
    this.frame(pageId, object(tree.frame), route);
    for (const child of array(tree.childFrames)) this.frameTree(pageId, child, route);
  }
  private send(binding: NodeBinding, method: string, params: RecordValue): Promise<RecordValue> {
    if (this.closed) throw new EngineError("session_closed");
    if (this.fault) throw new EngineError("evidence_unavailable");
    if(method==='DOM.resolveNode')return this.readonlyWorlds.context(binding).then(executionContextId=>{
      if(this.closed)throw new EngineError('session_closed');
      return this.connection.wire.send(method,{...params,executionContextId},this.directory.route(binding));
    });
    const operation = this.connection.wire.send(method, params, this.directory.route(binding));
    return method.startsWith("Input.") || method === "DOM.focus" || method === "DOM.scrollIntoViewIfNeeded" || method === 'DOM.setFileInputFiles' || ["Page.navigate", "Page.reload", "Page.navigateToHistoryEntry"].includes(method)
      ? this.dialogAware(operation, binding.pageId) : operation;
  }
  private async dialogAware(operation: Promise<RecordValue>, pageId: string): Promise<RecordValue> {
    let wake!: (openedPage: string) => void;
    const opened = new Promise<never>((_resolve, reject) => {
      wake = openedPage => { if (openedPage === pageId) reject(new EngineError("dialog_opened")); };
      this.dialogWaiters.add(wake);
      if ([...this.dialogs.values()].some(dialog => dialog.pageId === pageId)) wake(pageId);
    });
    try { return await Promise.race([operation, opened]); }
    finally { this.dialogWaiters.delete(wake); }
  }
  private async clear(binding: NodeBinding, context: CommandContext): Promise<void> {
    await this.selectAll(context, binding);
    await this.deleteSelection(context, binding);
  }
  private async deleteSelection(context: CommandContext, binding: NodeBinding): Promise<void> { await this.key(context, binding, "Backspace"); }
  private async verifyHit(context: CommandContext, binding: NodeBinding, x: number, y: number): Promise<void> {
    const resolved = await context.read(() => this.send(binding, "DOM.resolveNode", { backendNodeId: binding.backendNodeId }));
    const objectId = string(object(resolved.object).objectId);
    if (!objectId) throw new EngineError("stale_target");
    try {
      const result = await context.read(() => this.send(binding, "Runtime.callFunctionOn", {
        objectId, functionDeclaration: `function(x,y){
          let target=this;
          for(let depth=0;depth<32;depth++){
            const root=target.getRootNode(),hit=root.elementFromPoint(x,y);
            if(!hit||(hit!==target&&!target.contains(hit)))return false;
            if(!root.host)return true;
            target=root.host;
          }
          return false;
        }`,
        arguments: [{ value: x }, { value: y }], returnByValue: true, silent: true,
      }));
      if (object(result.result).value !== true) throw new EngineError("target_moved");
    } finally { void this.send(binding, "Runtime.releaseObject", { objectId }).catch(() => undefined); }
  }
  private async pointerPoint(context: CommandContext, binding: NodeBinding): Promise<{ x: number; y: number }> {
    const geometry = await context.read(() => this.send(binding, "DOM.getContentQuads", { backendNodeId: binding.backendNodeId }));
    const quads = geometry.quads;
    if (!Array.isArray(quads) || quads.length !== 1 || !Array.isArray(quads[0]) || quads[0].length !== 8 || !quads[0].every(finiteNumber)) throw new EngineError("evidence_unavailable");
    const quad = quads[0] as number[];
    const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
    const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
    const scroll = await context.read(() => this.send(binding,"Runtime.evaluate",{expression:"({x:scrollX,y:scrollY})",returnByValue:true,silent:true}));
    const offset = object(object(scroll.result).value);
    if(!finiteNumber(offset.x)||!finiteNumber(offset.y))throw new EngineError("evidence_unavailable");
    const documentPoint = {x:Math.round(x+offset.x),y:Math.round(y+offset.y)};
    // Quads and native input use viewport coordinates. This DOM hit-test method
    // takes document coordinates in the CDP route's root document instead.
    const hit = await context.read(() => this.send(binding, "DOM.getNodeForLocation", { ...documentPoint, includeUserAgentShadowDOM: false }));
    if (hit.backendNodeId !== binding.backendNodeId) {
      const target = await context.read(() => this.send(binding, "DOM.resolveNode", { backendNodeId: binding.backendNodeId }));
      const objectId = string(object(target.object).objectId);
      if (!objectId || !Number.isSafeInteger(hit.backendNodeId)) throw new EngineError("target_moved");
      let hitId: string | undefined;
      try {
        const hitNode = await context.read(() => this.send(binding, "DOM.resolveNode", { backendNodeId: hit.backendNodeId }));
        hitId = string(object(hitNode.object).objectId);
        if (!hitId) throw new EngineError("target_moved");
        const contains = await context.read(() => this.send(binding, "Runtime.callFunctionOn", { objectId, functionDeclaration: "function(node){if(!this.isConnected)return false;for(let depth=0;node&&depth<128;depth++){if(node===this)return true;node=node.parentNode||node.host;}return false;}", arguments: [{ objectId: hitId }], returnByValue: true, silent: true, throwOnSideEffect: true }));
        if (object(contains.result).value !== true) throw new EngineError("target_moved");
      } finally {
        void this.send(binding, "Runtime.releaseObject", { objectId }).catch(() => undefined);
        if (hitId) void this.send(binding, "Runtime.releaseObject", { objectId: hitId }).catch(() => undefined);
      }
    }
    return { x, y };
  }
  private async clickAt(context: CommandContext, page: EnginePageStamp, action: EngineClickAt): Promise<EnginePostcondition> {
    const capture = this.captures.get(action.captureId);
    if (!capture || capture.pageId !== page.pageId || capture.documentGeneration !== page.documentGeneration
      || action.x < 0 || action.y < 0 || action.x > capture.clip.width || action.y > capture.clip.height) throw new EngineError("stale_target");
    const root = this.directory.binding(page, 1);
    const currentSpatial = await this.captureSpatialState(context, root);
    if (!sameCaptureSpatial(capture.spatial, currentSpatial)) throw new EngineError("stale_target");
    const currentShot = await context.read(() => this.send(root, "Page.captureScreenshot", {
      format: "png", fromSurface: true, captureBeyondViewport: capture.captureBeyondViewport===true,
      clip: { ...capture.clip, scale: 1 },
    }));
    const currentData = string(currentShot.data);
    if (!currentData) throw new EngineError("evidence_unavailable");
    let currentMasked: ReturnType<typeof maskCapturedPng>;
    try { currentMasked = maskCapturedPng(currentData, capture.clip, capture.regions); } catch { throw new EngineError("evidence_unavailable"); }
    if (createHash("sha256").update(currentMasked.base64, "utf8").digest("hex") !== capture.maskedDigest) throw new EngineError("stale_target");
    const x = capture.clip.x + action.x-currentSpatial.pageX+currentSpatial.offsetX;
    const y = capture.clip.y + action.y-currentSpatial.pageY+currentSpatial.offsetY;
    if(x<0||y<0||x>=currentSpatial.width||y>=currentSpatial.height)throw new EngineError('target_moved');
    await context.input(() => this.send(root, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", clickCount: 0 }));
    if (action.kind === "click_at") await this.input!.click(root, x, y);
    if (action.waitFor) await this.waitFor(context, page, action.waitFor);
    return action.waitFor ? { state: "met", kind: "visible" } : { state: "not_requested" };
  }
  private async selectAll(context: CommandContext, binding: NodeBinding): Promise<void> {
    context.checkpoint();
    if (process.platform === "darwin") {
      // A keyless editing command: macOS never routes Command shortcuts from
      // CDP into the renderer, and held Meta events can stall headless input.
      await this.focusedFacts(context, binding, true);
      await this.input!.selectRange(binding, ["selectAll"]);
      return;
    }
    await this.input!.chord(binding, ["Control", "a"], async () => { await this.focusedFacts(context, binding, true); });
  }
  private async focusedFacts(context: CommandContext, binding: NodeBinding, editable: boolean) {
    const facts = await this.resolver.inspect(context, binding, { editable });
    if (!facts.focused) throw new EngineError("stale_target");
    return facts;
  }
  private async waitForGeneration(context: CommandContext, pageId: string, before: number): Promise<void> {
    for (;;) {
      context.checkpoint();
      if (this.directory.stamp(pageId).documentGeneration > before) return;
      if (performance.now() >= context.deadline) throw new EngineError("timed_out");
      await this.waitForCondition(context, context.deadline);
    }
  }
  private async waitForHistoryIndex(context: CommandContext, pageId: string, targetIndex: number): Promise<void> {
    for (;;) {
      context.checkpoint();
      const current = this.directory.stamp(pageId);
      const root = this.directory.binding(current, 1);
      const route = this.directory.route(root);
      const history = await context.read(() => this.connection.wire.send("Page.getNavigationHistory", {}, route));
      if (Number(history.currentIndex) === targetIndex) return;
      if (performance.now() >= context.deadline) throw new EngineError("timed_out");
      await this.waitForCondition(context, context.deadline);
    }
  }
  /**
   * Waits until the requested document is parsed. With `afterGeneration`, a document that replaced it (a script
   * redirect while it was still parsing, as sign-in pages do) also ends the wait once parsed: the requested one never
   * reaches DOMContentLoaded.
   */
  private async waitForDocument(context: CommandContext, loaderId: string, pageId: string, afterGeneration?: number): Promise<void> {
    context.checkpoint();
    if ([...this.dialogs.values()].some(dialog => dialog.pageId === pageId)) throw new EngineError("dialog_opened");
    const parsed = () => {
      if (this.lifecycle.get(loaderId)?.has("DOMContentLoaded")) return true;
      if (afterGeneration === undefined) return false;
      let current: EnginePageStamp;
      try { current = this.directory.stamp(pageId); } catch { return false; }
      const loader = this.directory.loader(current);
      return current.documentGeneration > afterGeneration && loader !== loaderId && !!this.lifecycle.get(loader)?.has("DOMContentLoaded");
    };
    if (parsed()) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.lifecycleWaiters.delete(wake); this.dialogWaiters.delete(dialog); context.signal.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); reject(context.signal.reason); };
      const dialog = (openedPage: string) => { if (openedPage === pageId) { cleanup(); reject(new EngineError("dialog_opened")); } };
      const wake = () => { if (parsed()) { cleanup(); resolve(); } };
      const timer = setTimeout(() => { cleanup(); reject(new EngineError("timed_out")); }, Math.max(1, context.deadline - performance.now()));
      this.lifecycleWaiters.add(wake); this.dialogWaiters.add(dialog); context.signal.addEventListener("abort", abort, { once: true }); wake();
    });
    context.checkpoint();
  }
  private async captureSpatialState(context: CommandContext, root: NodeBinding): Promise<CaptureSpatialState> {
    const metrics = await context.read(() => this.send(root, "Page.getLayoutMetrics", {}));
    const visual = object(metrics.cssVisualViewport??metrics.visualViewport);
    const layout = object(metrics.cssLayoutViewport??metrics.layoutViewport);
    const dpr = await context.read(() => this.send(root, "Runtime.evaluate", { expression: "window.devicePixelRatio", returnByValue: true, silent: true }));
    const deviceScaleFactor = Number(object(dpr.result).value);
    if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0) throw new EngineError("evidence_unavailable");
    return {
      width: finiteNumber(visual.clientWidth) ? Number(visual.clientWidth) : 1280,
      height: finiteNumber(visual.clientHeight) ? Number(visual.clientHeight) : 720,
      offsetX: finiteNumber(visual.offsetX) ? Number(visual.offsetX) : 0,
      offsetY: finiteNumber(visual.offsetY) ? Number(visual.offsetY) : 0,
      pageX: finiteNumber(visual.pageX) ? Number(visual.pageX) : (finiteNumber(layout.pageX) ? Number(layout.pageX) : 0),
      pageY: finiteNumber(visual.pageY) ? Number(visual.pageY) : (finiteNumber(layout.pageY) ? Number(layout.pageY) : 0),
      scale: finiteNumber(visual.scale) ? Number(visual.scale) : 1,
      deviceScaleFactor,
    };
  }
}

function expectedTypedValue(before: { value?: string; selectionStart?: number; selectionEnd?: number }, inserted: string): string | undefined {
  if (before.value === undefined) return undefined;
  const start = before.selectionStart; const end = before.selectionEnd;
  if (start === undefined || end === undefined || start < 0 || end < start || end > before.value.length) return undefined;
  return `${before.value.slice(0, start)}${inserted}${before.value.slice(end)}`;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sameCaptureSpatial(left: CaptureSpatialState, right: CaptureSpatialState): boolean {
  return left.width === right.width && left.height === right.height && left.offsetX === right.offsetX && left.offsetY === right.offsetY
    && left.pageX === right.pageX && left.pageY === right.pageY && left.scale === right.scale && left.deviceScaleFactor === right.deviceScaleFactor;
}

function documentUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value.split("#", 1)[0] ?? value;
  }
}

function waitTarget(waitFor: EngineWaitFor): EngineTarget | undefined {
  if (waitFor.ref) return { kind: "ref", ref: waitFor.ref };
  if (waitFor.selector) return { kind: "selector", selector: waitFor.selector };
  if (waitFor.role && waitFor.name) return { kind: "semantic", role: waitFor.role, name: waitFor.name, exact: true };
  return undefined;
}

/** Read-only and bounded: scans at most 4000 elements and returns element/label pairs, never page data beyond labels. */
const PAGE_EXTRAS_SCRIPT = `(() => {
  const W = innerWidth, H = innerHeight, native = "a,button,input,select,textarea,summary,label,option,[contenteditable],[role=button],[role=link],[role=menuitem],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=option],[role=textbox],[role=combobox],[role=slider]";
  const label = el => (el.getAttribute("aria-label") || el.innerText || el.title || "").replace(/\\s+/g, " ").trim().slice(0, 120);
  const visible = el => { const r = el.getBoundingClientRect(); return r.width >= 8 && r.height >= 8 && r.bottom > 0 && r.top < H * 3 && r.right > 0 && r.left < W; };
  const clickables = []; let scanned = 0, incomplete = false;
  for (const el of document.body ? document.body.querySelectorAll("*") : []) {
    if (++scanned > 4000) { incomplete = true; break; }
    if (clickables.length >= 24) { incomplete = true; break; }
    if (el.matches(native) || el.closest(native) || el.querySelector(native)) continue;
    const signal = el.hasAttribute("onclick") || el.hasAttribute("tabindex") && el.tabIndex >= 0;
    if (!signal) {
      if (getComputedStyle(el).cursor !== "pointer") continue;
      if (el.parentElement && getComputedStyle(el.parentElement).cursor === "pointer") continue;
    }
    if (!visible(el)) continue;
    const name = label(el); if (name) clickables.push([el, name]);
  }
  let coverLayer = null;
  for (let el = document.elementFromPoint(W / 2, H / 2); el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (style.position === "fixed" || style.position === "sticky") { const r = el.getBoundingClientRect(); if (r.width * r.height >= 0.4 * W * H) coverLayer = el; break; }
  }
  const cover = [];
  if (coverLayer && !coverLayer.closest("[role=dialog],[role=alertdialog],dialog[open]")) {
    for (const el of coverLayer.querySelectorAll("a,button,input,select,textarea,[role=button],[role=link],[onclick],[tabindex]")) {
      if (cover.length >= 16) break;
      if (!visible(el)) continue;
      const name = label(el) || el.getAttribute("value") || el.getAttribute("placeholder") || ""; if (name) cover.push([el, name.slice(0, 120)]);
    }
  }
  return { clickables, cover, coverText: coverLayer && cover.length ? label(coverLayer).slice(0, 160) : undefined, incomplete };
})()`;
