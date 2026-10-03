type Ax = Record<string, unknown>;
type Send = (method: string, params: Ax) => Promise<Ax>;
const object = (value: unknown): Ax => value && typeof value === 'object' && !Array.isArray(value) ? value as Ax : {};
const nodes = (value: unknown): Ax[] => Array.isArray(value) ? value.map(object) : [];
// Chromium can withhold a role query's reply on pages with embedded frames. A query that does
// not answer in time leaves the snapshot incomplete instead of holding it to the command deadline.
const ROLE_QUERY_MS = 2500;
const bounded = (reply: Promise<Ax>): Promise<Ax> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([reply, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('role_query_timeout')), ROLE_QUERY_MS); })])
    .finally(() => clearTimeout(timer));
};
const terminalRoles = new Set(['StaticText', 'InlineTextBox', 'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'option', 'tab', 'menuitem', 'DisclosureTriangle']);

/** Bound tree expansion before requesting the full rendered article from CDP.
 * Static text leaves cannot contain controls, so their inline layout fragments
 * need not cross either the private pipe or native-messaging transport.
 */
export async function readAXSnapshot(send: Send, frameId: string, scopeBackendNodeId?: number, limits: {maxNodes:number;maxExpansionCalls:number}={maxNodes:4096,maxExpansionCalls:64}, queryText?: string): Promise<{nodes: Ax[]; incomplete: boolean; primary: ReadonlySet<number>}> {
  const maxNodes=Math.max(1,Math.min(4096,limits.maxNodes));
  const maxExpansionCalls=Math.max(0,Math.min(64,limits.maxExpansionCalls));
  const initial = scopeBackendNodeId === undefined
    ? await send('Accessibility.getFullAXTree', {frameId, depth: 4})
    : await send('Accessibility.getPartialAXTree', {backendNodeId: scopeBackendNodeId, fetchRelatives: true});
  const found = new Map<string, Ax>();
  let incomplete = false;
  // A text query must reach a matching control past the per-role bound, so
  // matching names take the bounded slots first and the rest fill them in order.
  const needle = queryText?.toLocaleLowerCase();
  const named = (node: Ax) => !!needle && [object(node.name).value, object(node.description).value].some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(needle));
  const bound = (batch: Ax[], cap: number) => (needle ? [...batch.filter(named), ...batch.filter(node => !named(node))] : batch).slice(0, cap);
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
    const queried: [string, number][] = [['searchbox',16],['textbox',16],['combobox',16],['spinbutton',16],['button',64],['DisclosureTriangle',16],['checkbox',16],['radio',24],['switch',8],['tab',16],['slider',8]];
    // The main-content links run alongside the role queries so a withheld reply costs one bound, not several.
    const mainLinks = scopeBackendNodeId === undefined ? bounded(send('Accessibility.queryAXTree',{backendNodeId:rootBackend,role:'main'})).then(async reply => {
      const landmarks=nodes(reply.nodes).filter(node=>!node.ignored);
      if(landmarks.length!==1||!Number.isSafeInteger(landmarks[0]!.backendDOMNodeId))return undefined;
      return nodes((await bounded(send('Accessibility.queryAXTree',{backendNodeId:landmarks[0]!.backendDOMNodeId,role:'link'}))).nodes);
    }) : undefined;
    void mainLinks?.catch(() => undefined);
    const matches = await Promise.allSettled(queried.map(([role]) => bounded(send('Accessibility.queryAXTree',{backendNodeId:rootBackend,role}))));
    const fields: Ax[] = [];
    matches.forEach((result, index) => {
      if (result.status === 'rejected') { incomplete = true; return; }
      const cap = queried[index]![1];
      const batch = nodes(result.value.nodes).filter(node => !node.ignored); if (batch.length > cap) incomplete = true;
      fields.push(...bound(batch, cap));
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
        const links=await mainLinks!;
        if(links) {
          if(links.length>128)incomplete=true;
          const kept=bound(links,128);
          add(kept);
          for(const node of kept)if(Number.isSafeInteger(node.backendDOMNodeId))primary.add(Number(node.backendDOMNodeId));
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
