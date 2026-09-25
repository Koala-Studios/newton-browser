import { EngineError, type EnginePageStamp } from "@newton-browser/core";

export type NodeBinding = Readonly<{
  connectionEpoch: string; claimGeneration: number; pageId: string; frameId: string;
  documentGeneration: number; backendNodeId: number;
}>;
interface Frame { id: string; parentId?: string; route: string; documentGeneration: number; loaderId: string; }
interface Page { id: string; frames: Map<string, Frame>; root: string; title?: string; url?: string; openerPageId?: string; }
interface Snapshot { id: string; refs: string[]; }

/** The authority for document lifetimes, bounded tab metadata and public references. */
export class PageDirectory {
  readonly connectionEpoch: string;
  readonly claimGeneration: number;
  private readonly pages = new Map<string, Page>();
  private readonly refs = new Map<string, NodeBinding>();
  private readonly snapshots: Snapshot[] = [];
  private readonly liveRefs = new Map<string, string>();
  static readonly SNAPSHOTS = 8;
  private nextRef = 1;
  private nextSnapshot = 1;
  private nextDocument = 1;
  private readonly routeOrder = new Map<string, number>();
  private nextRoute = 1;
  private selected: string | undefined;
  constructor(connectionEpoch: string, claimGeneration = 1) {
    this.connectionEpoch = connectionEpoch; this.claimGeneration = claimGeneration;
  }
  registerRoute(route: string): void {
    if (this.routeOrder.has(route)) return;
    if (!route || route.length > 120 || this.routeOrder.size >= 256) throw new EngineError("work_limit");
    this.routeOrder.set(route, this.nextRoute++);
  }
  addPage(pageId: string, openerPageId?: string): void {
    if (this.pages.has(pageId)) return;
    if (this.pages.size >= 32) throw new EngineError("work_limit");
    this.pages.set(pageId, { id: pageId, root: "", frames: new Map(), ...(openerPageId&&this.pages.has(openerPageId)?{openerPageId}:{}) });
    this.selected ??= pageId;
  }
  navigate(pageId: string, input: { frameId: string; parentId?: string; route: string; loaderId: string; url?: string }): void {
    if (!this.routeOrder.has(input.route)) return;
    const page = this.page(pageId);
    const old = page.frames.get(input.frameId);
    if (old && old.route !== input.route && this.routeOrder.get(old.route)! > this.routeOrder.get(input.route)!) return;
    if (old && old.loaderId === input.loaderId && old.route === input.route) return;
    if (!old && page.frames.size >= 128) throw new EngineError("work_limit");
    if (old) this.removeDescendants(page, input.frameId);
    page.frames.set(input.frameId, { id: input.frameId, ...(input.parentId ? { parentId: input.parentId } : {}), route: input.route,
      documentGeneration: this.nextDocument++, loaderId: input.loaderId });
    if (!input.parentId) { page.root = input.frameId; delete page.title; delete page.url; this.describe(this.stamp(pageId),{url:input.url}); }
    this.pruneRefs();
  }
  detachRoute(route: string): void {
    this.routeOrder.delete(route);
    for (const page of this.pages.values()) {
      for (const frame of [...page.frames.values()]) if (frame.route === route) {
        this.removeDescendants(page, frame.id); page.frames.delete(frame.id);
      }
    }
    this.pruneRefs();
  }
  detachFrame(pageId: string, frameId: string, route: string): void {
    const page = this.pages.get(pageId);
    if (!page || page.frames.get(frameId)?.route !== route) return;
    this.removeDescendants(page, frameId); page.frames.delete(frameId); this.pruneRefs();
  }
  removePage(pageId: string): void {
    this.pages.delete(pageId);
    if (this.selected === pageId) this.selected = this.pages.keys().next().value;
    this.pruneRefs();
  }
  select(pageId: string): EnginePageStamp { const stamp = this.stamp(pageId); this.selected = pageId; return stamp; }
  stamp(pageId = this.selected): EnginePageStamp {
    if (!pageId) throw new EngineError("unknown_page");
    const page = this.page(pageId); const frame = page.frames.get(page.root);
    if (!frame) throw new EngineError("evidence_unavailable");
    return Object.freeze({ pageId, frameId: frame.id, documentGeneration: frame.documentGeneration });
  }
  inventory(): readonly (EnginePageStamp & {selected: boolean; title?: string; url?: string; openerPageId?: string})[] {
    return [...this.pages.values()].filter(page=>page.frames.has(page.root)).map(page=>({...this.stamp(page.id),selected:page.id===this.selected,
      ...(page.title===undefined?{}:{title:page.title}),...(page.url===undefined?{}:{url:page.url}),...(page.openerPageId?{openerPageId:page.openerPageId}:{})}));
  }
  describe(stamp: EnginePageStamp, metadata: {title?:string|undefined;url?:string|undefined}): void {
    const page=this.page(stamp.pageId);this.binding(stamp,1);
    if(stamp.frameId!==page.root)return;
    if(metadata.title!==undefined)page.title=metadata.title.slice(0,256);
    if(metadata.url!==undefined){
      delete page.url;
      try{const url=new URL(metadata.url);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)page.url=url.href.slice(0,2048);}catch{/* Not a supported browser location. */}
    }
  }
  loader(stamp:EnginePageStamp):string {
    this.binding(stamp,1);
    return this.page(stamp.pageId).frames.get(stamp.frameId)!.loaderId;
  }
  frames(pageId: string): readonly EnginePageStamp[] {
    return [...this.page(pageId).frames.values()].map(frame => Object.freeze({ pageId, frameId: frame.id, documentGeneration: frame.documentGeneration }));
  }
  parent(stamp: EnginePageStamp): EnginePageStamp | undefined {
    const page = this.page(stamp.pageId); const frame = page.frames.get(stamp.frameId);
    if (!frame || frame.documentGeneration !== stamp.documentGeneration) throw new EngineError("stale_target");
    if (!frame.parentId) return undefined;
    const parent = page.frames.get(frame.parentId);
    if (!parent) throw new EngineError("search_incomplete");
    return Object.freeze({ pageId: stamp.pageId, frameId: parent.id, documentGeneration: parent.documentGeneration });
  }
  binding(page: EnginePageStamp, backendNodeId: number): NodeBinding {
    const frame = this.page(page.pageId).frames.get(page.frameId);
    if (!frame || frame.documentGeneration !== page.documentGeneration || !Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) throw new EngineError("stale_target");
    return Object.freeze({ ...page, connectionEpoch: this.connectionEpoch, claimGeneration: this.claimGeneration, backendNodeId });
  }
  route(binding: NodeBinding): string {
    if (binding.connectionEpoch !== this.connectionEpoch || binding.claimGeneration !== this.claimGeneration) throw new EngineError("stale_target");
    const frame = this.pages.get(binding.pageId)?.frames.get(binding.frameId);
    if (!frame || frame.documentGeneration !== binding.documentGeneration) throw new EngineError("stale_target");
    return frame.route;
  }
  resolve(ref: string, pageId: string): NodeBinding {
    const binding = this.refs.get(ref);
    if (!binding || binding.pageId !== pageId) throw new EngineError("stale_target");
    this.route(binding); return binding;
  }
  /** Call only for nodes that survived output selection. Private verification never publishes. */
  publish(bindings: readonly NodeBinding[]): { snapshotId: string; refs: readonly string[]; expiredSnapshots: readonly string[] } {
    if (bindings.length > 512) throw new EngineError("work_limit");
    bindings.forEach(binding => this.route(binding));
    // The same live element keeps its ref across observations, and refs stay
    // valid for several snapshots so a multi-field form can be filled from one read.
    const reused = bindings.map(binding => { const ref = this.liveRefs.get(bindingKey(binding)); return ref && this.refs.has(ref) ? ref : undefined; });
    const expiredSnapshots: string[] = [];
    const added = reused.filter(ref => ref === undefined).length;
    while (this.snapshots.length >= PageDirectory.SNAPSHOTS || (this.snapshots.length && this.refs.size + added > 1024)) {
      const snapshot = this.snapshots.shift()!; expiredSnapshots.push(snapshot.id);
      const kept = new Set([...this.snapshots.flatMap(item => item.refs), ...reused.filter((ref): ref is string => ref !== undefined)]);
      for (const ref of snapshot.refs) if (!kept.has(ref)) this.forget(ref);
    }
    const snapshot: Snapshot = { id: `s${this.nextSnapshot++}`, refs: [] };
    bindings.forEach((binding, index) => {
      let ref = reused[index];
      if (!ref || !this.refs.has(ref)) { ref = `e${this.nextRef++}`; this.refs.set(ref, binding); this.liveRefs.set(bindingKey(binding), ref); }
      snapshot.refs.push(ref);
    });
    this.snapshots.push(snapshot);
    return { snapshotId: snapshot.id, refs: snapshot.refs, expiredSnapshots };
  }
  private forget(ref: string): void {
    const binding = this.refs.get(ref);
    if (binding && this.liveRefs.get(bindingKey(binding)) === ref) this.liveRefs.delete(bindingKey(binding));
    this.refs.delete(ref);
  }
  private page(id: string): Page { const page = this.pages.get(id); if (!page) throw new EngineError("unknown_page"); return page; }
  private removeDescendants(page: Page, id: string): void {
    for (const frame of [...page.frames.values()]) if (frame.parentId === id) { this.removeDescendants(page, frame.id); page.frames.delete(frame.id); }
  }
  private pruneRefs(): void {
    for (const [ref, binding] of this.refs) { try { this.route(binding); } catch { this.forget(ref); } }
  }
}

function bindingKey(binding: NodeBinding): string {
  return `${binding.connectionEpoch}:${binding.claimGeneration}:${binding.pageId}:${binding.frameId}:${binding.documentGeneration}:${binding.backendNodeId}`;
}
