import { EngineError, asObservationBudget, type EngineGeometry, type EngineGeometryElement, type EngineObservation, type EngineObservationBudget, type EnginePageStamp } from '@newton-browser/core';
import type { CommandContext } from './command-context.ts';
import type { NodeBinding, PageDirectory } from './page-directory.ts';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};

/** Elements examined per read; past it the result says `complete: false`. */
export const GEOMETRY_NODE_LIMIT = 6000;
/** Entries per list (wider, clippedText, imagesNotLoaded, overlaps). */
export const GEOMETRY_LIST_LIMIT = 12;
/** Text and control boxes compared pairwise for overlap. */
export const GEOMETRY_OVERLAP_CANDIDATES = 400;

/** Read-only layout facts for responsive checks, with `this` the scope element or document. Reads boxes and computed
 * styles only; never scrolls, focuses, loads or writes. Coordinates are CSS pixels in the document (scroll-independent).
 * Returns `{ facts, nodes }`: facts is JSON-safe and each list entry names its element by index into nodes. */
export const GEOMETRY_FUNCTION = String.raw`function(maxNodes,listLimit,overlapLimit){
  const doc=this.ownerDocument||(this.nodeType===9?this:document),win=doc.defaultView,html=doc.documentElement;
  const root=this.nodeType===9?(doc.body||html):this;
  const sx=win.scrollX,sy=win.scrollY,vw=html.clientWidth,vh=html.clientHeight;
  const round=value=>Math.round(value*10)/10;
  const box=rect=>({x:round(rect.left+sx),y:round(rect.top+sy),width:round(rect.width),height:round(rect.height)});
  const nodes=[],index=new Map();
  const name=element=>{if(!index.has(element)){index.set(element,nodes.length);nodes.push(element);}return index.get(element);};
  const label=element=>{
    let value=element.tagName.toLowerCase();
    if(element.id)value+='#'+element.id.slice(0,40);
    const cls=typeof element.className==='string'?element.className.trim().split(/\s+/)[0]:'';
    if(cls)value+='.'+cls.slice(0,40);
    // textContent, not innerText: a label must not lay out a whole page section again.
    const text=(element.getAttribute('aria-label')||element.getAttribute('alt')||(element.textContent||'').slice(0,200)).replace(/\s+/g,' ').trim();
    return text?value+' "'+(text.length>40?text.slice(0,39)+'…':text)+'"':value;
  };
  const entry=(element,rect,extra)=>({node:name(element),label:label(element),box:box(rect),...extra});
  const parent=node=>node.assignedSlot||node.parentElement||node.parentNode?.host||null;
  const ownText=element=>{for(const child of element.childNodes)if(child.nodeType===3&&child.nodeValue.trim())return true;return false;};
  const field=element=>/^(INPUT|SELECT|TEXTAREA)$/.test(element.tagName)&&element.type!=='hidden';
  const wider=[],clipped=[],notLoaded=[],candidates=[];
  let visited=0,complete=true,widerCount=0,clippedCount=0,images=0,notLoadedCount=0,overlapTruncated=false;
  // Each stack item carries whether an ancestor below the page clips horizontally, whether an outer element was
  // already reported as wider, and whether it sits in a fixed or sticky layer.
  const stack=[{node:root,clipX:false,reported:false,layer:false}];
  while(stack.length){
    const item=stack.pop(),element=item.node;
    if(++visited>maxNodes){complete=false;break;}
    if(element.nodeType!==1)continue;
    if(/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|HEAD|META|LINK)$/.test(element.tagName))continue;
    const style=win.getComputedStyle(element);
    if(style.display==='none')continue;
    const shown=style.visibility!=='hidden'&&style.visibility!=='collapse';
    const rect=element.getBoundingClientRect();
    // Visually hidden helpers (skip links, screen-reader labels) are 1x1 boxes: present for assistive technology only.
    const sized=rect.width>1&&rect.height>1;
    const layer=item.layer||style.position==='fixed'||style.position==='sticky';
    let reported=item.reported;
    // A fixed or sticky layer wholly outside the viewport is an off-canvas drawer; it does not widen the page.
    const offCanvas=layer&&(rect.left>=vw||rect.right<=0);
    if(shown&&sized&&!item.clipX&&!reported&&!offCanvas&&(rect.right>vw+0.5||rect.left<-0.5)){
      widerCount++;reported=true;
      if(wider.length<listLimit)wider.push(entry(element,rect,{right:round(rect.right),left:round(rect.left)}));
    }
    if(shown&&sized&&!/^(inline|contents)$/.test(style.display)&&ownText(element)&&(element.scrollWidth>element.clientWidth+1||element.scrollHeight>element.clientHeight+1)&&element.clientWidth>0){
      clippedCount++;
      if(clipped.length<listLimit)clipped.push(entry(element,rect,{scrollWidth:element.scrollWidth,clientWidth:element.clientWidth,scrollHeight:element.scrollHeight,clientHeight:element.clientHeight,overflow:style.overflowX+' '+style.overflowY,...(style.textOverflow==='ellipsis'?{ellipsis:true}:{})}));
    }
    if(element.tagName==='IMG'&&shown&&sized){
      images++;
      if(!element.complete||element.naturalWidth===0){notLoadedCount++;if(notLoaded.length<listLimit)notLoaded.push(entry(element,rect,{loading:element.loading||'eager',complete:element.complete}));}
    }
    // Text boxes and form fields: a link or button stretched over a card on purpose has no text of its own.
    if(shown&&sized&&!layer&&(ownText(element)||field(element))){
      if(candidates.length<overlapLimit)candidates.push({element,rect});else overlapTruncated=true;
    }
    const clipX=item.clipX||element!==html&&element!==doc.body&&style.overflowX!=='visible';
    const children=element.shadowRoot?element.shadowRoot.children:element.tagName==='SLOT'&&element.assignedElements().length?element.assignedElements():element.children;
    if(children.length+stack.length>maxNodes){complete=false;break;}
    for(let i=children.length-1;i>=0;i--)stack.push({node:children[i],clipX,reported,layer});
  }
  const overlaps=[];let overlapCount=0;
  const related=(a,b)=>{for(let node=a;node;node=parent(node))if(node===b)return true;for(let node=b;node;node=parent(node))if(node===a)return true;return false;};
  for(let i=0;i<candidates.length;i++)for(let j=i+1;j<candidates.length;j++){
    const a=candidates[i],b=candidates[j];
    const width=Math.min(a.rect.right,b.rect.right)-Math.max(a.rect.left,b.rect.left),height=Math.min(a.rect.bottom,b.rect.bottom)-Math.max(a.rect.top,b.rect.top);
    if(width<=2||height<=2||related(a.element,b.element))continue;
    overlapCount++;
    if(overlaps.length<listLimit)overlaps.push({a:entry(a.element,a.rect),b:entry(b.element,b.rect),width:round(width),height:round(height)});
  }
  const scope=this.nodeType===9?undefined:entry(root,root.getBoundingClientRect(),{scrollWidth:root.scrollWidth,clientWidth:root.clientWidth});
  return {facts:{viewport:{width:vw,height:vh},scroll:{x:round(sx),y:round(sy)},document:{scrollWidth:html.scrollWidth,scrollHeight:html.scrollHeight},
    horizontalOverflow:html.scrollWidth>vw,...(scope?{scope}:{}),
    wider:{count:widerCount,items:wider},clippedText:{count:clippedCount,items:clipped},
    images:{count:images,notLoaded:{count:notLoadedCount,items:notLoaded}},
    overlaps:{count:overlapCount,items:overlaps,...(overlapTruncated?{truncated:true}:{})},
    complete},nodes};
}`;

type GeometryDeps = Readonly<{ directory: PageDirectory; send: (binding: NodeBinding, method: string, params: RecordValue) => Promise<RecordValue> }>;

/** Bounded geometry of the scope (or the page) in its own frame, every reported element with a ref. */
export async function readGeometry(context: CommandContext, page: EnginePageStamp, budgetValue: number | EngineObservationBudget, root: NodeBinding, scoped: boolean, deps: GeometryDeps): Promise<EngineObservation> {
  const budget = asObservationBudget(budgetValue);
  const { directory, send } = deps;
  const resolved = await context.read(() => send(root, 'DOM.resolveNode', { backendNodeId: root.backendNodeId }));
  const rootId = String(object(resolved.object).objectId ?? '');
  if (!rootId) throw new EngineError('stale_target');
  const temporary: string[] = [rootId];
  try {
    const result = await context.read(() => send(root, 'Runtime.callFunctionOn', { objectId: rootId, functionDeclaration: GEOMETRY_FUNCTION,
      arguments: [{ value: GEOMETRY_NODE_LIMIT }, { value: GEOMETRY_LIST_LIMIT }, { value: GEOMETRY_OVERLAP_CANDIDATES }], silent: true }));
    const resultId = String(object(result.result).objectId ?? '');
    if (result.exceptionDetails || !resultId) throw new EngineError('evidence_unavailable');
    temporary.push(resultId);
    const factsResult = await context.read(() => send(root, 'Runtime.callFunctionOn', { objectId: resultId, functionDeclaration: 'function(){return this.facts}', returnByValue: true, silent: true }));
    const facts = object(object(factsResult.result).value);
    if (factsResult.exceptionDetails || typeof facts.complete !== 'boolean') throw new EngineError('evidence_unavailable');
    const nodesResult = await context.read(() => send(root, 'Runtime.callFunctionOn', { objectId: resultId, functionDeclaration: 'function(){return this.nodes}', silent: true }));
    const nodesId = String(object(nodesResult.result).objectId ?? '');
    if (nodesResult.exceptionDetails || !nodesId) throw new EngineError('evidence_unavailable');
    temporary.push(nodesId);
    const properties = await context.read(() => send(root, 'Runtime.getProperties', { objectId: nodesId, ownProperties: true }));
    const elementIds = new Map<number, string>();
    for (const property of Array.isArray(properties.result) ? properties.result : []) {
      const entry = object(property), position = Number(entry.name), objectId = object(entry.value).objectId;
      if (Number.isSafeInteger(position) && position >= 0 && typeof objectId === 'string' && objectId) { elementIds.set(position, objectId); temporary.push(objectId); }
    }
    const bindings: NodeBinding[] = [];
    for (let position = 0; elementIds.has(position); position++) {
      const described = await context.read(() => send(root, 'DOM.describeNode', { objectId: elementIds.get(position)! }));
      const backendNodeId = Number(object(described.node).backendNodeId);
      if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) throw new EngineError('evidence_unavailable');
      bindings.push(directory.binding(root, backendNodeId));
    }
    directory.route(root);
    const published = directory.publish(bindings);
    const element = (value: unknown): EngineGeometryElement => {
      const raw = object(value), position = Number(raw.node), ref = published.refs[position];
      if (!Number.isSafeInteger(position) || !ref) throw new EngineError('evidence_unavailable');
      const { node: _node, ...rest } = raw;
      return { ref, ...rest } as EngineGeometryElement;
    };
    const list = (value: unknown) => { const raw = object(value); return { count: Number(raw.count), items: (Array.isArray(raw.items) ? raw.items : []).map(element) }; };
    const overlaps = object(facts.overlaps), images = object(facts.images);
    const full: EngineGeometry = {
      viewport: facts.viewport as EngineGeometry['viewport'], scroll: facts.scroll as EngineGeometry['scroll'], document: facts.document as EngineGeometry['document'],
      horizontalOverflow: facts.horizontalOverflow === true, ...(scoped && facts.scope ? { scope: element(facts.scope) } : {}),
      wider: list(facts.wider), clippedText: list(facts.clippedText),
      images: { count: Number(images.count), notLoaded: list(images.notLoaded) },
      overlaps: { count: Number(overlaps.count), items: (Array.isArray(overlaps.items) ? overlaps.items : []).map(item => { const raw = object(item); return { a: element(raw.a), b: element(raw.b), width: Number(raw.width), height: Number(raw.height) }; }), ...(overlaps.truncated === true ? { truncated: true as const } : {}) },
      complete: facts.complete === true,
    };
    const view = (geometry: EngineGeometry, trimmed: boolean): EngineObservation => ({ state: geometry.complete && !trimmed ? 'available' : 'incomplete', trust: 'untrusted_page_content', scope: scoped ? 'target' : 'page', page,
      snapshotId: published.snapshotId, expiredSnapshots: published.expiredSnapshots, nodes: [], geometry,
      ...(!geometry.complete ? { incompleteReason: 'work_limit' as const } : trimmed ? { incompleteReason: 'output_limit' as const } : {}) });
    // Past the byte budget, drop list entries from the end (counts stay exact) until it fits.
    let geometry = full, trimmed = false;
    while (!budget.fits(view(geometry, trimmed))) {
      const lists = [geometry.overlaps.items, geometry.clippedText.items, geometry.images.notLoaded.items, geometry.wider.items];
      const longest = lists.reduce((a, b) => b.length > a.length ? b : a);
      if (!longest.length) throw new EngineError('output_budget');
      trimmed = true;
      geometry = { ...geometry,
        overlaps: { ...geometry.overlaps, items: longest === lists[0] ? geometry.overlaps.items.slice(0, -1) : geometry.overlaps.items },
        clippedText: { ...geometry.clippedText, items: longest === lists[1] ? geometry.clippedText.items.slice(0, -1) : geometry.clippedText.items },
        images: { ...geometry.images, notLoaded: { ...geometry.images.notLoaded, items: longest === lists[2] ? geometry.images.notLoaded.items.slice(0, -1) : geometry.images.notLoaded.items } },
        wider: { ...geometry.wider, items: longest === lists[3] ? geometry.wider.items.slice(0, -1) : geometry.wider.items } };
    }
    return view(geometry, trimmed);
  } finally {
    for (const objectId of temporary) void send(root, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
  }
}
