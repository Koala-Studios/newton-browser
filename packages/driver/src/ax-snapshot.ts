type Ax = Record<string, unknown>;
type Send = (method: string, params: Ax) => Promise<Ax>;
const object = (value: unknown): Ax => value && typeof value === 'object' && !Array.isArray(value) ? value as Ax : {};
const nodes = (value: unknown): Ax[] => Array.isArray(value) ? value.map(object) : [];
const terminalRoles = new Set(['StaticText', 'InlineTextBox', 'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'option', 'tab', 'menuitem']);

/** Bound tree expansion before requesting the full rendered article from CDP.
 * Static text leaves cannot contain controls, so their inline layout fragments
 * need not cross either the private pipe or native-messaging transport.
 */
export async function readAXSnapshot(send: Send, frameId: string, scopeBackendNodeId?: number, limits: {maxNodes:number;maxExpansionCalls:number}={maxNodes:4096,maxExpansionCalls:64}): Promise<{nodes: Ax[]; incomplete: boolean; primary: ReadonlySet<number>}> {
  const maxNodes=Math.max(1,Math.min(4096,limits.maxNodes));
  const maxExpansionCalls=Math.max(0,Math.min(64,limits.maxExpansionCalls));
  const initial = scopeBackendNodeId === undefined
    ? await send('Accessibility.getFullAXTree', {frameId, depth: 4})
    : await send('Accessibility.getPartialAXTree', {backendNodeId: scopeBackendNodeId, fetchRelatives: true});
  const found = new Map<string, Ax>();
  let incomplete = false;
  const primary = new Set<number>();
  const add = (batch: Ax[]) => {
    for (const node of batch) {
      if (typeof node.nodeId !== 'string') { incomplete = true; continue; }
      if (!found.has(node.nodeId) && found.size >= maxNodes) { incomplete = true; break; }
      found.set(node.nodeId, node);
    }
  };
  add(nodes(initial.nodes));
  const needsExpansion = () => [...found.values()].some(node => !terminalRoles.has(String(object(node.role).value))
    && Array.isArray(node.childIds) && node.childIds.some(id => typeof id === 'string' && !found.has(id)));
  if (scopeBackendNodeId === undefined && !needsExpansion()) return {nodes:[...found.values()],incomplete,primary};
  const rootBackend = scopeBackendNodeId ?? [...found.values()].find(node => object(node.role).value === 'RootWebArea')?.backendDOMNodeId;
  // Scoped reads already have a concrete subtree. Cross-frame queryAXTree can
  // withhold its response; expand that subtree through bounded child reads below.
  if (scopeBackendNodeId === undefined && Number.isSafeInteger(rootBackend) && Number(rootBackend) > 0) {
    // An article's broad link tree must not exhaust traversal before a deeply
    // nested search/form field. Query these scarce high-value roles in Chromium,
    // then fetch their ancestor paths for the same scope/context projection.
    // Deep action controls (add to cart, quantity, options) sit below any
    // breadth-first bound on real storefronts, so query them directly too.
    const queried: [string, number][] = [['searchbox',16],['textbox',16],['combobox',16],['spinbutton',16],['button',64],['checkbox',16],['radio',24],['switch',8],['tab',16],['slider',8]];
    const matches = await Promise.allSettled(queried.map(([role]) => send('Accessibility.queryAXTree',{backendNodeId:rootBackend,role})));
    const fields: Ax[] = [];
    matches.forEach((result, index) => {
      if (result.status === 'rejected') { incomplete = true; return; }
      const cap = queried[index]![1];
      const batch = nodes(result.value.nodes).filter(node => !node.ignored); if (batch.length > cap) incomplete = true;
      fields.push(...batch.slice(0, cap));
    });
    add(fields);
    for (let index=0;index<fields.length;index+=8) {
      const paths=await Promise.allSettled(fields.slice(index,index+8).map(node => send('Accessibility.getAXNodeAndAncestors',{backendNodeId:node.backendDOMNodeId})));
      for (const result of paths) { if(result.status==='fulfilled')add(nodes(result.value.nodes));else incomplete=true; }
    }
    if (scopeBackendNodeId === undefined) {
      // Preserve links in the primary task content before site-wide navigation
      // fills a compact view. Semantic landmarks work across ordinary sites;
      // there are no URL-specific selectors or site-specific ranking rules.
      try {
        const landmarks=nodes((await send('Accessibility.queryAXTree',{backendNodeId:rootBackend,role:'main'})).nodes).filter(node=>!node.ignored);
        if(landmarks.length===1&&Number.isSafeInteger(landmarks[0]!.backendDOMNodeId)) {
          const links=nodes((await send('Accessibility.queryAXTree',{backendNodeId:landmarks[0]!.backendDOMNodeId,role:'link'})).nodes);
          if(links.length>128)incomplete=true;
          add(links.slice(0,128));
          for(const node of links.slice(0,128))if(Number.isSafeInteger(node.backendDOMNodeId))primary.add(Number(node.backendDOMNodeId));
        }
      }catch{incomplete=true;}
    }
  }
  const expanded = new Set<string>();
  let calls = 0;
  for (;;) {
    const pending: string[] = [];
    for (const [id, node] of found) {
      if (expanded.has(id) || terminalRoles.has(String(object(node.role).value))) continue;
      if (Array.isArray(node.childIds) && node.childIds.some(child => typeof child === 'string' && !found.has(child))) pending.push(id);
      if (pending.length === 8) break;
    }
    if (!pending.length) break;
    if (calls >= maxExpansionCalls || found.size >= maxNodes) { incomplete = true; break; }
    // Independent read-only branches share one bounded batch; every result is
    // consumed before issuing more work. No timers, global AX cache or polling.
    const batch = pending.slice(0, maxExpansionCalls - calls); calls += batch.length;
    batch.forEach(id => expanded.add(id));
    const results = await Promise.allSettled(batch.map(id => send('Accessibility.getChildAXNodes', {id, frameId})));
    for (const result of results) if (result.status === 'fulfilled') add(nodes(result.value.nodes));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    for (const id of batch) {
      const children = found.get(id)?.childIds;
      if (Array.isArray(children) && children.some(child => typeof child === 'string' && !found.has(child))) incomplete = true;
    }
  }
  markMainContent(found, primary);
  return {nodes: [...found.values()], incomplete, primary};
}

/** Controls inside the page's single main landmark rank ahead of site chrome. */
function markMainContent(found: Map<string, Ax>, primary: Set<number>): void {
  const mains = [...found.values()].filter(node => object(node.role).value === 'main' && !node.ignored);
  if (mains.length !== 1) return;
  const parent = new Map<string, string>();
  for (const node of found.values()) {
    if (typeof node.parentId === 'string') parent.set(String(node.nodeId), node.parentId);
    if (Array.isArray(node.childIds)) for (const child of node.childIds) if (typeof child === 'string') parent.set(child, String(node.nodeId));
  }
  const main = String(mains[0]!.nodeId);
  for (const node of found.values()) {
    if (!Number.isSafeInteger(node.backendDOMNodeId)) continue;
    let id = parent.get(String(node.nodeId));
    for (let depth = 0; id && depth < 256; depth++, id = parent.get(id)) if (id === main) { primary.add(Number(node.backendDOMNodeId)); break; }
  }
}
