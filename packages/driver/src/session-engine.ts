import { type EngineControlQuery, ENGINE_LIMITS, EngineError, boundedInteger, engineErrorCode, parseEngineCommand, readObservationBudget, receiptObservationBudget, type EngineObservationBudget, type EngineCommand, type EngineCommandState,
  type EngineInputAction, type EngineObservation, type EngineObservationRecord, type EnginePageStamp, type EnginePostcondition, type EngineReceipt, type EngineStepReceipt, type EngineTarget } from "@newton-browser/core";
import { CommandContext, engineClock, type EngineClock } from "./command-context.ts";
import { CommandStore, type CommandRecord } from "./command-store.ts";
import {encodeEngineResult,type EngineRecordShape,type EngineObservationDelta} from '@newton-browser/core';

const postconditionKind=(action:EngineInputAction):Exclude<EnginePostcondition,{state:'not_requested'}>['kind']=>
  action.kind==='set_files'?'files':action.kind==='resize'?'viewport':
  ['navigate','back','forward','reload'].includes(action.kind)?'navigation':
  ['fill','type','clear','edit','select','press'].includes(action.kind)?'value':'visible';

export interface EngineExecutor {
  bindPage(pageId?: string): EnginePageStamp;
  act(context: CommandContext, page: EnginePageStamp, action: EngineInputAction): Promise<EnginePostcondition>;
  observe(context: CommandContext, page: EnginePageStamp, budget: EngineObservationBudget, recordMode?: boolean, scope?: EngineTarget, query?: EngineControlQuery): Promise<EngineObservation>;
  observeAfterAction?(context: CommandContext, page: EnginePageStamp, budget: EngineObservationBudget): Promise<EngineObservation>;
  readyPage?(context: CommandContext, page: EnginePageStamp): Promise<{ page: EnginePageStamp } | { observation: EngineObservation }>;
  readRecords?(context:CommandContext,page:EnginePageStamp,budget:EngineObservationBudget,shape:EngineRecordShape,scope?:EngineTarget):Promise<EngineObservation>;
  readDocument?(context: CommandContext, page: EnginePageStamp, budget: EngineObservationBudget, cursor?: string, scope?: EngineTarget): Promise<EngineObservation>;
  screenshot?(context: CommandContext, page: EnginePageStamp, budget: EngineObservationBudget, options: unknown): Promise<EngineObservation>;
  /** Must close the exact owned runtime, or revoke/detach a borrowed claim. Never await this queue. */
  close(): Promise<void>;
}
interface QueueItem { kind: "command"; command: EngineCommand; page: EnginePageStamp; record: CommandRecord; bytes: number; context: CommandContext; }
interface ReadItem { kind: "read"; page: EnginePageStamp; maxBytes: number; bytes: number; context: CommandContext; mode?: "document" | "screenshot" | "records"; recordShape?:EngineRecordShape; cursor?: string; previousSnapshotId?: string; scope?: EngineTarget; query?: EngineControlQuery; options?: unknown; beforeRead?: () => void; complete(value: EngineObservation): void; }

export class SessionEngine {
  readonly sessionId: string;
  private readonly executor: EngineExecutor;
  private readonly clock: EngineClock;
  private readonly store: CommandStore;
  private readonly queue: (QueueItem | ReadItem)[] = [];
  private bytes = 0;
  private operator: string | undefined;
  private active: { item: QueueItem | ReadItem; context: CommandContext } | undefined;
  private admission: "open" | "closed" | "quarantined" = "open";
  private stopping: Promise<void> | undefined;
  private readonly reconciliationMs: number;
  private readonly recordSnapshots = new Map<string, { page: EnginePageStamp; scope: string; records: readonly EngineObservationRecord[]; complete: boolean }>();

  constructor(sessionId: string, executor: EngineExecutor, options: { clock?: EngineClock; reconciliationMs?: number } = {}) {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(sessionId)) throw new EngineError("invalid_arguments");
    this.sessionId = sessionId; this.executor = executor;
    this.clock = options.clock ?? engineClock; this.store = new CommandStore(this.clock);
    this.reconciliationMs = options.reconciliationMs ?? 250;
  }
  get nextCommandId(): number { return this.store.nextId; }
  get state(): string { return this.admission; }
  command(id: number, cancel = false): EngineCommandState {
    const state = this.store.get(id);
    if (cancel && state.state !== "finished") {
      if (this.active?.item.kind === "command" && this.active.item.record.id === id) this.active.context.cancel();
      else {
        const index = this.queue.findIndex(item => item.kind === "command" && item.record.id === id);
        if (index !== -1) {
          const item = this.queue.splice(index, 1)[0]!; this.bytes -= item.bytes;
          item.context.cancel(); item.context.dispose(); if (item.kind === "command") item.record.complete(this.cancelled(item));
        }
      }
    }
    if (this.active?.item.kind === "command" && this.active.item.record.id === id) return { commandId: id, state: state.state === "reconciling" ? "reconciling" : "running", dispatch: this.active.context.dispatch };
    return this.store.get(id);
  }
  submit(raw: unknown): Promise<EngineReceipt> {
    const command = parseEngineCommand(raw);
    const existing = this.store.lookup(command);
    if (existing) return existing.result;
    // An operator has the page; model actions wait for resume. The ID is not consumed.
    if (this.operator !== undefined) throw new EngineError("operator_control");
    if (this.admission !== "open") throw new EngineError(this.admission === "closed" ? "session_closed" : "session_quarantined");
    const bytes = Buffer.byteLength(JSON.stringify(command));
    if (this.queue.length + (this.active ? 1 : 0) >= ENGINE_LIMITS.queueItems || this.bytes + bytes > ENGINE_LIMITS.queueBytes) throw new EngineError("queue_full");
    // Bind before admission: popups/selection changes must not retarget queued input.
    const page = Object.freeze({ ...this.executor.bindPage(command.pageId) });
    const record = this.store.admit(command);
    const context = new CommandContext(command.timeoutMs, this.clock);
    const item: QueueItem = { kind: "command", command, page, record, bytes, context };
    this.queue.push(item); this.bytes += bytes;
    void context.aborted.then(() => {
      const index = this.queue.indexOf(item);
      if (index !== -1) {
        this.queue.splice(index, 1); this.bytes -= bytes; context.dispose();
        record.complete({ ...this.cancelled(item), reason: context.cancellation!, errorCode: context.cancellation! });
      }
    });
    this.pump();
    return record.result;
  }
  observe(options: { pageId?: string; maxBytes?: number; timeoutMs?: number; mode?: "controls" | "document" | "records"; recordShape?:EngineRecordShape; cursor?: string; previousSnapshotId?: string; scope?: EngineTarget; query?: EngineControlQuery; beforeRead?: () => void } = {}): Promise<EngineObservation> {
    if(options.recordShape!==undefined&&(options.mode!=='records'||!['controls','links','table','form'].includes(options.recordShape)))throw new EngineError('invalid_arguments');
    if (this.admission !== "open") throw new EngineError("session_closed");
    if (this.queue.length + (this.active ? 1 : 0) >= ENGINE_LIMITS.queueItems) throw new EngineError("queue_full");
    const maxBytes = boundedInteger(options.maxBytes ?? 8192, 2048, 65536);
    const page = this.executor.bindPage(options.pageId);
    const context = new CommandContext(boundedInteger(options.timeoutMs ?? 10000, 1, 120000), this.clock);
    let complete!: (value: EngineObservation) => void;
    const result = new Promise<EngineObservation>(resolve => { complete = resolve; });
    const item: ReadItem = { kind: "read", page, maxBytes, bytes: 0, context, complete, ...(options.mode === "document" ? { mode: "document" as const } : options.mode === "records" ? { mode: "records" as const } : {}), ...(options.cursor === undefined ? {} : { cursor: options.cursor }), ...(options.previousSnapshotId === undefined ? {} : { previousSnapshotId: options.previousSnapshotId }) };
    this.queue.push(item);
    if (options.scope) item.scope = options.scope;
    if (options.query) item.query = options.query;
    if (options.recordShape) item.recordShape=options.recordShape;
    // Runs in the lane, after earlier queued work, for example selecting the page to read.
    if (options.beforeRead) item.beforeRead = options.beforeRead;
    void context.aborted.then(() => {
      const index = this.queue.indexOf(item);
      if (index !== -1) { this.queue.splice(index, 1); context.dispose(); complete({ state: "unavailable", errorCode: context.cancellation! }); }
    });
    this.pump(); return result;
  }
  screenshot(options: { pageId?: string; maxBytes?: number; timeoutMs?: number; options?: unknown } = {}): Promise<EngineObservation> {
    if (this.admission !== "open") throw new EngineError("session_closed");
    if (this.queue.length + (this.active ? 1 : 0) >= ENGINE_LIMITS.queueItems) throw new EngineError("queue_full");
    const maxBytes = boundedInteger(options.maxBytes ?? ENGINE_LIMITS.defaultScreenshotBytes, 8192, ENGINE_LIMITS.maxScreenshotBytes);
    const page = this.executor.bindPage(options.pageId);
    const context = new CommandContext(boundedInteger(options.timeoutMs ?? 30000, 1, 120000), this.clock);
    let complete!: (value: EngineObservation) => void;
    const result = new Promise<EngineObservation>(resolve => { complete = resolve; });
    const item: ReadItem = { kind: "read", page, maxBytes, bytes: 0, context, complete, mode: "screenshot", options: options.options };
    this.queue.push(item);
    void context.aborted.then(() => {
      const index = this.queue.indexOf(item);
      if (index !== -1) { this.queue.splice(index, 1); context.dispose(); complete({ state: "unavailable", errorCode: context.cancellation! }); }
    });
    this.pump(); return result;
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.admission = "closed";
    this.active?.context.cancel();
    this.cancelQueued();
    // Invoke immediately, independently of any held executor promise.
    this.stopping = Promise.resolve().then(() => this.executor.close()).catch(() => {
      this.admission = "quarantined"; this.stopping = undefined; throw new EngineError("cleanup_uncertain");
    });
    return this.stopping;
  }
  private pump(): void {
    if (this.active || this.admission !== "open") return;
    const item = this.queue.shift();
    if (!item) return;
    const context = item.context;
    this.active = { item, context };
    if (item.kind === "read") { void this.runRead(item); return; }
    item.record.state = { commandId: item.record.id, state: "running", dispatch: "not_started" };
    void this.run(item, context);
  }
  private async run(item: QueueItem, context: CommandContext): Promise<void> {
    const steps: EngineStepReceipt[] = [];
    let observation: EngineObservation = { state: "none" };
    let postcondition: EnginePostcondition = { state: "unknown", kind: "value" };
    let failure: ReturnType<typeof engineErrorCode> | undefined;
    let stoppedAt: number | undefined;
    let actionPhaseFinished = false;
    const execution = (async () => {
        const actions = item.command.action.kind === "sequence" ? item.command.action.steps : [item.command.action];
        for (let index = 0; index < actions.length; index++) {
          const mark = context.mark();
          postcondition = { state: "unknown", kind: postconditionKind(actions[index]!) };
          try {
            context.checkpoint();
            const stepPage = index === 0 ? item.page : this.executor.bindPage(item.page.pageId);
            postcondition = await this.executor.act(context, stepPage, actions[index]!);
            context.checkpoint();
            steps.push({ index, dispatch: context.since(mark), postcondition });
          if (postcondition.state !== "met" && postcondition.state !== "not_requested") { stoppedAt = index; break; }
        } catch (error) {
          failure = context.cancellation ?? engineErrorCode(error);
          steps.push({ index, dispatch: context.since(mark), postcondition: { state: "unknown", kind: postconditionKind(actions[index]!) }, errorCode: failure });
          break;
        }
      }
      actionPhaseFinished = !context.cancellation;
      if (!context.cancellation && item.command.observe === "local") {
        try {
          const page = this.executor.bindPage(item.page.pageId);
          // Bound the final receipt envelope, not an unrelated fixed node allowance.
          // Longest terminal variants reserve room if the optional read times out.
          const budget = receiptObservationBudget(item.command.maxBytes,{sessionId:this.sessionId,commandId:item.command.commandId,state:"finished",reason:"timed_out",dispatch:"acknowledged",postcondition:{state:"unknown",kind:"navigation"},nextCommandId:Number.MAX_SAFE_INTEGER,page:item.page,steps,errorCode:"unsupported_capability",stoppedAt:steps.length});
          observation = this.executor.observeAfterAction ? await this.executor.observeAfterAction(context, page, budget) : await this.executor.observe(context, page, budget);
        }
        catch (error) { observation = { state: "unavailable", errorCode: engineErrorCode(error) }; }
      }
    })().catch(error => { failure = engineErrorCode(error); });
    await this.reconcile(execution, context, () => { item.record.state = { commandId: item.record.id, state: "reconciling", dispatch: context.dispatch }; });
    // A timed-out optional read cannot rewrite already-known input effects.
    // Its own unavailable observation carries that timeout/cancellation.
    failure = actionPhaseFinished ? failure : context.cancellation ?? failure;
    if (failure === "cleanup_uncertain") { this.admission = "quarantined"; this.cancelQueued(); void this.stop().catch(() => undefined); }
    const reason = failure === "cancelled" || failure === "timed_out" ? failure : failure ? (context.dispatch === "not_started" ? "rejected" : "failed") : "completed";
    item.record.complete({ sessionId: this.sessionId, commandId: item.record.id, state: "finished", reason,
      dispatch: context.dispatch, postcondition, nextCommandId: this.store.nextId, page: item.page,
      steps: [...steps], ...(failure ? { errorCode: failure, stoppedAt: steps.length ? steps.length - 1 : 0 } : stoppedAt === undefined ? {} : { stoppedAt }), observation });
    context.dispose();
    this.bytes -= item.bytes;
    this.active = undefined;
    this.pump();
  }
  private async runRead(item: ReadItem): Promise<void> {
    let observation: EngineObservation = { state: "unavailable", errorCode: "read_failed" };
    try { item.beforeRead?.(); }
    catch (error) { item.complete({ state: "unavailable", errorCode: engineErrorCode(error) }); item.context.dispose(); this.active = undefined; this.pump(); return; }
    const readBudget=readObservationBudget(item.maxBytes);
    const budget:EngineObservationBudget=item.mode!=="records"?readBudget:{maxBytes:item.maxBytes,fits:value=>{
      if(value.state!=="available"&&value.state!=="incomplete")return readBudget.fits(value);
      const records=value.records??value.nodes.map(node=>({...node,recordId:node.recordId??node.ref,kind:"control" as const}));
      return readBudget.fits({...value,nodes:[],records,...(item.previousSnapshotId===undefined?{}:{delta:{baseSnapshotId:item.previousSnapshotId,reset:true,resetReason:'baseline_unavailable',added:[],removed:[],changed:[]}})});
    }};
    const execution = Promise.resolve().then(async () => {
      // A read during a document navigation waits for the new document, or reports it pending.
      const ready = item.mode !== "screenshot" && this.executor.readyPage ? await this.executor.readyPage(item.context, item.page) : { page: item.page };
      if ("observation" in ready) return ready.observation;
      const page = ready.page;
      return item.mode === "document" && this.executor.readDocument
      ? this.executor.readDocument(item.context, page, budget, item.cursor, item.scope)
      : item.mode === "screenshot" && this.executor.screenshot
        ? this.executor.screenshot(item.context, page, budget, item.options)
      : item.mode === 'records' && this.executor.readRecords ? this.executor.readRecords(item.context,page,budget,item.recordShape??'controls',item.scope)
      : this.executor.observe(item.context, page, budget, item.mode === "records", item.scope, item.query);
    }).then(value => { observation = item.mode === "records" ? this.records(value, item.page, item.maxBytes, item.previousSnapshotId, item.scope,item.recordShape) : value; }).catch(error => {
      observation = { state: "unavailable", errorCode: engineErrorCode(error) };
    });
    await this.reconcile(execution, item.context, () => undefined);
    item.complete(item.context.cancellation ? { state: "unavailable", errorCode: item.context.cancellation } : observation);
    item.context.dispose(); this.active = undefined; this.pump();
  }
  private records(observation: EngineObservation, page: EnginePageStamp, maxBytes: number, previousSnapshotId?: string, scope?: EngineTarget,shape:EngineRecordShape='controls'): EngineObservation {
    if (observation.state !== "available" && observation.state !== "incomplete") return observation;
    const records = observation.records??observation.nodes.map((node): EngineObservationRecord => ({ ...node, recordId: node.recordId ?? node.ref, kind: "control" }));
    const scopeKey=JSON.stringify({scope:scope??null,shape});
    const snapshotId = observation.snapshotId;
    const previous=previousSnapshotId===undefined?undefined:this.recordSnapshots.get(previousSnapshotId);
    if (snapshotId) {
      this.recordSnapshots.set(snapshotId, { page, scope: scopeKey, records, complete: observation.state === "available" });
      while (this.recordSnapshots.size > 2) this.recordSnapshots.delete(this.recordSnapshots.keys().next().value!);
    }
    let delta:EngineObservationDelta|undefined;
    if (previousSnapshotId !== undefined) {
      if (!previous || previous.scope !== scopeKey || previous.page.pageId !== page.pageId || previous.page.documentGeneration !== page.documentGeneration
        || !previous.complete || observation.state !== "available") {
        const resetReason=!previous?'baseline_unavailable':previous.scope!==scopeKey?'incompatible_scope':previous.page.pageId!==page.pageId||previous.page.documentGeneration!==page.documentGeneration?'document_changed':'incomplete_view';
        delta = { baseSnapshotId: previousSnapshotId, reset: true, resetReason, added: [], removed: [], changed: [] };
      } else {
      const oldById = new Map(previous.records.map(record => [record.recordId, record]));
      const newById = new Map(records.map(record => [record.recordId, record]));
      const content = (record: EngineObservationRecord) => JSON.stringify(record,(key,value)=>key==='ref'?undefined:value);
      const unchanged=records.filter(record=>oldById.has(record.recordId)&&content(oldById.get(record.recordId)!)===content(record));
      delta = { baseSnapshotId: previousSnapshotId, reset:false,
        added: records.filter(record => !oldById.has(record.recordId)),
        removed: previous.records.filter(record => !newById.has(record.recordId)).map(record => record.recordId),
        changed: records.filter(record => oldById.has(record.recordId) && content(oldById.get(record.recordId)!) !== content(record)),
        refs:unchanged.flatMap(record=>[{recordId:record.recordId,ref:record.ref},...(record.kind==='form'?record.fields.map(field=>({recordId:field.recordId!,ref:field.ref})):[])]),
        order:records.map(record=>record.recordId) };
      }
    }
    const projected: EngineObservation = { ...observation, nodes: [], records:delta?.reset===false?[]:records, ...(delta ? { delta } : {}) };
    const budget=readObservationBudget(maxBytes);
    const reset: EngineObservation = { ...observation, nodes: [], records, ...(previousSnapshotId === undefined ? {} : { delta: { baseSnapshotId: previousSnapshotId, reset: true, resetReason:'full_more_compact', added: [], removed: [], changed: [] } }) };
    const bytes=(value:EngineObservation)=>Buffer.byteLength(JSON.stringify(encodeEngineResult({observation:value,nextCommandId:Number.MAX_SAFE_INTEGER})));
    if (budget.fits(projected)&&(delta?.reset!==false||bytes(projected)<bytes(reset))) return projected;
    return budget.fits(reset) ? reset : { state: "unavailable", errorCode: "output_budget" };
  }
  private async reconcile(execution: Promise<void>, context: CommandContext, onReconciling: () => void): Promise<void> {
    let settled = false;
    const finished = execution.finally(() => { settled = true; });
    await Promise.race([finished, context.aborted]);
    if (settled) return;
    onReconciling();
    let dispose!: () => void;
    await Promise.race([finished, new Promise<void>(resolve => { dispose = this.clock.schedule(resolve, this.reconciliationMs); })]);
    dispose();
    if (!settled) { this.admission = "quarantined"; this.cancelQueued(); void this.stop().catch(() => undefined); }
  }
  private cancelled(item: QueueItem): EngineReceipt {
    return { sessionId: this.sessionId, commandId: item.record.id, state: "finished", reason: "cancelled",
      dispatch: "not_started", postcondition: { state: "not_requested" }, nextCommandId: this.store.nextId,
      page: item.page, steps: [], errorCode: "cancelled", observation: { state: "none" } };
  }
  /** The operator takes the page: queued model actions are cancelled and an in-flight one finishes first. Reads continue. */
  async pause(reason: string): Promise<void> {
    if (this.admission !== "open") throw new EngineError("session_closed");
    this.operator = reason.slice(0, 80);
    for (let index = this.queue.length - 1; index >= 0; index--) {
      const item = this.queue[index]!;
      if (item.kind !== "command") continue;
      this.queue.splice(index, 1); this.bytes -= item.bytes; item.context.cancel(); item.context.dispose();
      item.record.complete({ ...this.cancelled(item), reason: "cancelled", errorCode: "operator_control" });
    }
    const active = this.active?.item;
    if (active?.kind === "command") await active.record.result.catch(() => undefined);
  }
  resume(): void { this.operator = undefined; }
  get operatorControl(): string | undefined { return this.operator; }
  private cancelQueued(): void {
    for (const item of this.queue.splice(0)) {
      this.bytes -= item.bytes; item.context.cancel(); item.context.dispose();
      if (item.kind === "command") item.record.complete(this.cancelled(item));
      else item.complete({ state: "unavailable", errorCode: "cancelled" });
    }
  }
}
