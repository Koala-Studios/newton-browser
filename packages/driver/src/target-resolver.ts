import { EngineError, type EnginePageStamp, type EngineTarget } from "@newton-browser/core";
import type { CommandContext } from "./command-context.ts";
import { type NodeBinding } from "./page-directory.ts";

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function array(value: unknown): RecordValue[] { return Array.isArray(value) ? value.map(object) : []; }
const fieldInspection = `function(pointer=false) {
  const tag = this.tagName?.toLowerCase();
  const type = (this.getAttribute('type') || 'text').toLowerCase();
  const autocomplete = (this.getAttribute('autocomplete') || '').toLowerCase();
  const sensitive = type === 'password' || /password|one-time-code|cc-|webauthn/.test(autocomplete);
  const editable = tag === 'textarea' || tag === 'select' || this.isContentEditable || (tag === 'input' && ['text','search','email','url','tel','number'].includes(type));
  const rect = this.getBoundingClientRect();
  const visible = !!(rect.width && rect.height) && getComputedStyle(this).visibility !== 'hidden';
  let pointerInView;
  if(pointer){
    const view=this.ownerDocument.defaultView;
    let left=0,top=0,right=view.innerWidth,bottom=view.innerHeight,ancestor=this.parentElement,count=0;
    while(ancestor&&count++<128){
      const style=getComputedStyle(ancestor),box=ancestor.getBoundingClientRect();
      if(/auto|scroll|hidden|clip/.test(style.overflowX)){left=Math.max(left,box.left);right=Math.min(right,box.right);}
      if(/auto|scroll|hidden|clip/.test(style.overflowY)){top=Math.max(top,box.top);bottom=Math.min(bottom,box.bottom);}
      ancestor=ancestor.parentElement;
    }
    if(!ancestor)pointerInView=rect.left+rect.width/2>=left&&rect.left+rect.width/2<right&&rect.top+rect.height/2>=top&&rect.top+rect.height/2<bottom;
  }
  // Sensitivity gates the access itself, including geometry-only masking inspection.
  const currentValue = sensitive || !editable ? undefined :
    tag === 'input' || tag === 'textarea' || tag === 'select' ? this.value : this.isContentEditable ? (this.textContent || '') : undefined;
  let focusRoot=this,focusDepth=0;
  while(focusRoot.parentNode&&focusDepth++<256)focusRoot=focusRoot.parentNode;
  return { sensitive, editable, connected: this.isConnected, disabled: !!this.disabled,
    readonly: !!this.readOnly, visible, focused: !focusRoot.parentNode && focusRoot.activeElement === this,
    tag, type, checked: !!this.checked, selected: !!this.selected, pointerInView,
    multiple: tag === 'select' || (tag === 'input' && type === 'file') ? !!this.multiple : undefined,
    bbox: visible ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : undefined,
    selectionStart: !sensitive && typeof this.selectionStart === 'number' ? this.selectionStart : undefined,
    selectionEnd: !sensitive && typeof this.selectionEnd === 'number' ? this.selectionEnd : undefined,
    value: !sensitive && editable ? currentValue : undefined };
}`;

interface TargetResolverContext {
  directory: {
    resolve(ref: string, pageId: string): NodeBinding;
    binding(page: EnginePageStamp, backendNodeId: number): NodeBinding;
    frames(pageId: string): readonly EnginePageStamp[];
    parent(page: EnginePageStamp): EnginePageStamp | undefined;
    route(binding: NodeBinding): string;
  };
  send(binding: NodeBinding, method: string, params: RecordValue): Promise<RecordValue>;
  pendingAttachments(): number;
  pendingFrames(): number;
}
export type TargetResolverFacts = Readonly<{
  sensitive: boolean;
  editable: boolean;
  connected: boolean;
  disabled: boolean;
  readonly: boolean;
  visible: boolean;
  focused: boolean;
  pointerInView?: boolean;
  tag?: string;
  type?: string;
  checked?: boolean;
  selected?: boolean;
  multiple?: boolean;
  selectionStart?: number;
  selectionEnd?: number;
  bbox?: { x: number; y: number; width: number; height: number };
  value?: string;
}>;

/** Shared target resolution and fact collection for input primitives. */
export class TargetResolver {
  private readonly directory: TargetResolverContext["directory"];
  private readonly sendBinding: TargetResolverContext["send"];
  private readonly pendingAttachmentsCount: TargetResolverContext["pendingAttachments"];
  private readonly pendingFrameCount: TargetResolverContext["pendingFrames"];
  constructor(context: TargetResolverContext) {
    this.directory = context.directory;
    this.sendBinding = context.send;
    this.pendingAttachmentsCount = context.pendingAttachments;
    this.pendingFrameCount = context.pendingFrames;
  }
  async resolve(context: CommandContext, page: EnginePageStamp, target: EngineTarget): Promise<NodeBinding> {
    if (target.kind === "ref") return this.directory.resolve(target.ref, page.pageId);
    this.directory.binding(page, 1);
    if (this.pendingAttachmentsCount() || this.pendingFrameCount()) throw new EngineError("search_incomplete");
    const matches: NodeBinding[] = [];
    let visited = 0;
    for (const frame of this.directory.frames(page.pageId)) {
      const base = this.directory.binding(frame, 1);
      if (target.kind === "semantic") {
        const nodeId = await this.documentRoot(context, frame, base);
        // Chromium filters inside the renderer; unrelated article text and its
        // inline layout fragments never become a giant protocol response.
        const result = await context.read(() => this.sendBinding(base, "Accessibility.queryAXTree", { nodeId, role: target.role, ...(target.exact ? { accessibleName: target.name } : {}) }));
        const nodes = array(result.nodes);
        visited += nodes.length;
        if (visited > 20_000) throw new EngineError("search_incomplete");
        for (const node of nodes) if (!node.ignored && object(node.role).value === target.role &&
          (target.exact ? object(node.name).value === target.name : string(object(node.name).value).includes(target.name))) {
          matches.push(this.directory.binding(frame, Number(node.backendDOMNodeId)));
        }
      } else {
        const nodeId = await this.documentRoot(context, frame, base);
        const result = await context.read(() => this.sendBinding(base, "DOM.querySelectorAll", { nodeId, selector: target.selector }));
        const ids = Array.isArray(result.nodeIds) ? result.nodeIds : [];
        if (ids.length > 1) throw new EngineError("ambiguous");
        if (ids.length) {
          const described = await context.read(() => this.sendBinding(base, "DOM.describeNode", { nodeId: ids[0] }));
          const backendNodeId = Number(object(described.node).backendNodeId);
          if (Number.isSafeInteger(backendNodeId) && backendNodeId > 0) matches.push(this.directory.binding(frame, backendNodeId));
        }
      }
      if (matches.length > 1) throw new EngineError("ambiguous");
    }
    if (!matches.length) throw new EngineError("not_found");
    return matches[0]!;
  }
  async document(context: CommandContext, frame: EnginePageStamp): Promise<NodeBinding> {
    const base = this.directory.binding(frame, 1);
    const nodeId = await this.documentRoot(context, frame, base);
    const described = await context.read(() => this.sendBinding(base, "DOM.describeNode", { nodeId }));
    return this.directory.binding(frame, Number(object(described.node).backendNodeId));
  }
  private async documentRoot(context: CommandContext, frame: EnginePageStamp, base: NodeBinding): Promise<number> {
    // DOM.getDocument is a CDP-session root, not necessarily this frame's document.
    const document = await context.read(() => this.sendBinding(base, "DOM.getDocument", { depth: 0 }));
    const parent = this.directory.parent(frame);
    if (!parent || this.directory.route(this.directory.binding(parent, 1)) !== this.directory.route(base)) {
      const id = Number(object(document.root).nodeId);
      if (!Number.isSafeInteger(id) || id <= 0) throw new EngineError("search_incomplete");
      return id;
    }
    const owner = await context.read(() => this.sendBinding(base, "DOM.getFrameOwner", { frameId: frame.frameId }));
    const described = await context.read(() => this.sendBinding(base, "DOM.describeNode", { backendNodeId: owner.backendNodeId, depth: 1 }));
    const content = object(object(described.node).contentDocument);
    if (!Number.isSafeInteger(content.backendNodeId) || Number(content.backendNodeId) <= 0) throw new EngineError("search_incomplete");
    const pushed = await context.read(() => this.sendBinding(base, "DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [content.backendNodeId] }));
    const id = Number(Array.isArray(pushed.nodeIds) ? pushed.nodeIds[0] : undefined);
    if (!Number.isSafeInteger(id) || id <= 0) throw new EngineError("search_incomplete");
    return id;
  }
  async inspect(context: CommandContext, binding: NodeBinding, options: { editable?: boolean; actionable?: boolean; allowSensitive?: boolean; pointer?: boolean } = {}): Promise<TargetResolverFacts> {
    const resolved = await context.read(() => this.sendBinding(binding, "DOM.resolveNode", { backendNodeId: binding.backendNodeId }));
    const objectId = string(object(resolved.object).objectId);
    if (!objectId) throw new EngineError("stale_target");
    try {
      const result = await context.read(() => this.sendBinding(binding, "Runtime.callFunctionOn", {
        objectId, functionDeclaration: fieldInspection, arguments: [{value:options.pointer===true}], returnByValue: true, silent: true, throwOnSideEffect: true,
      }));
      if (result.exceptionDetails) throw new EngineError("evidence_unavailable");
      const facts = object(object(result.result).value);
      for (const key of ["sensitive", "connected", "disabled", "visible", "editable", "readonly", "focused"]) {
        if (typeof facts[key] !== "boolean") throw new EngineError("evidence_unavailable");
      }
      if (facts.sensitive && options.allowSensitive !== true) throw new EngineError("sensitive_target");
      if (options.pointer && typeof facts.pointerInView !== "boolean") throw new EngineError("evidence_unavailable");
      if (!facts.connected) throw new EngineError("stale_target");
      if (options.actionable !== false && (facts.disabled || !facts.visible || (options.editable !== false && (!facts.editable || facts.readonly)))) throw new EngineError("target_not_editable");
      // Internal effect verification needs the exact non-sensitive value. Public
      // observations redact independently; these facts never form an output view.
      const verifiedValue = !facts.sensitive && typeof facts.value === "string" ? facts.value : undefined;
      const bbox = object(facts.bbox);
      return {
        sensitive: Boolean(facts.sensitive), editable: Boolean(facts.editable), connected: Boolean(facts.connected), disabled: Boolean(facts.disabled),
        readonly: Boolean(facts.readonly), visible: Boolean(facts.visible), focused: Boolean(facts.focused),
        ...(typeof facts.tag === "string" ? { tag: facts.tag } : {}),
        ...(typeof facts.type === "string" ? { type: facts.type } : {}),
        ...(typeof facts.checked === "boolean" ? { checked: facts.checked } : {}),
        ...(typeof facts.selected === "boolean" ? { selected: facts.selected } : {}),
        ...(typeof facts.multiple === "boolean" ? { multiple: facts.multiple } : {}),
        ...(typeof facts.pointerInView === "boolean" ? { pointerInView: facts.pointerInView } : {}),
        ...(typeof facts.selectionStart === "number" ? { selectionStart: facts.selectionStart } : {}),
        ...(typeof facts.selectionEnd === "number" ? { selectionEnd: facts.selectionEnd } : {}),
        ...(typeof bbox.x === "number" && typeof bbox.y === "number" && typeof bbox.width === "number" && typeof bbox.height === "number"
          ? { bbox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height } } : {}),
        ...(verifiedValue !== undefined ? { value: verifiedValue } : {}),
      };
    } finally { void this.sendBinding(binding, "Runtime.releaseObject", { objectId }).catch(() => undefined); }
  }
  async focused(context: CommandContext, page: EnginePageStamp): Promise<NodeBinding> {
    this.directory.binding(page, 1);
    if (this.isSearchIncomplete()) throw new EngineError("search_incomplete");
    const matches: NodeBinding[] = [];
    for (const frame of this.directory.frames(page.pageId)) {
      const base = this.directory.binding(frame, 1);
      const root = await this.documentRoot(context, frame, base);
      const result = await context.read(() => this.sendBinding(base, "DOM.querySelector", { nodeId: root, selector: ":focus" }));
      if (!result.nodeId) continue;
      const described = await context.read(() => this.sendBinding(base, "DOM.describeNode", { nodeId: result.nodeId }));
      let node = object(described.node);
      // Document :focus is retargeted to a shadow host. Follow authored roots
      // through native DOM identities, including closed roots, to the actual leaf.
      for(let depth=0;depth<32;depth++){
        const shadows=array(node.shadowRoots).filter(root=>root.shadowRootType==='open'||root.shadowRootType==='closed');
        if(!shadows.length)break;
        if(shadows.length!==1)throw new EngineError('search_incomplete');
        const shadow=shadows[0]!;
        let nodeId=Number(shadow.nodeId);
        if(!Number.isSafeInteger(nodeId)||nodeId<=0){
          const backendNodeId=Number(shadow.backendNodeId);
          if(!Number.isSafeInteger(backendNodeId)||backendNodeId<=0)throw new EngineError('search_incomplete');
          const pushed=await context.read(()=>this.sendBinding(base,'DOM.pushNodesByBackendIdsToFrontend',{backendNodeIds:[backendNodeId]}));
          nodeId=Number(Array.isArray(pushed.nodeIds)?pushed.nodeIds[0]:undefined);
          if(!Number.isSafeInteger(nodeId)||nodeId<=0)throw new EngineError('search_incomplete');
        }
        const focused=await context.read(()=>this.sendBinding(base,'DOM.querySelector',{nodeId,selector:':focus'}));
        if(!focused.nodeId)break;
        const leaf=await context.read(()=>this.sendBinding(base,'DOM.describeNode',{nodeId:focused.nodeId}));
        node=object(leaf.node);
        if(depth===31)throw new EngineError('search_incomplete');
      }
      if (node.localName === "iframe" || node.localName === "frame") continue;
      const binding = this.directory.binding(frame, Number(node.backendNodeId));
      const facts = await this.inspect(context, binding, { editable: false });
      if (facts.focused) matches.push(binding);
    }
    if (!matches.length) throw new EngineError("not_found");
    if (matches.length !== 1) throw new EngineError("ambiguous");
    return matches[0]!;
  }
  isSearchIncomplete(): boolean { return this.pendingAttachmentsCount() > 0 || this.pendingFrameCount() > 0; }
}
