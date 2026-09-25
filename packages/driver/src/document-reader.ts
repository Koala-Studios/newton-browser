import { EngineError, asObservationBudget, type EngineObservationBudget, type EngineObservation, type EnginePageStamp } from '@newton-browser/core';

/** Read-only, bounded DOM traversal. Excluded subtrees are never descended into. */
export const FRAME_SCOPE_FUNCTION=String.raw`function(owner,useThis=true,preferMain=true){
  const parent=node=>node.assignedSlot||node.parentElement||node.parentNode?.host||null;
  const unrendered=node=>!node.assignedSlot&&(!!node.parentElement?.shadowRoot||(node.parentElement?.tagName==='SLOT'&&node.parentElement.assignedNodes().length>0));
  let root=this;
  if(!useThis){
    const doc=this.ownerDocument||(this.nodeType===9?this:document);
    root=preferMain?(doc.querySelector('main,article,[role=main]')||doc.body):doc.body;
    let ancestor=root,depth=0;
    while(ancestor){
      if(++depth>128)return null;
      if(unrendered(ancestor)){root=doc.body;break;}
      const style=getComputedStyle(ancestor);
      if(/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|SVG|CANVAS|INPUT|TEXTAREA|SELECT|OPTION)$/.test(ancestor.tagName)||ancestor.hidden||ancestor.getAttribute('aria-hidden')==='true'||/password|one-time-code|cc-|webauthn/i.test(ancestor.getAttribute('autocomplete')||'')||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'){root=doc.body;break;}
      ancestor=parent(ancestor);
    }
  }
  if(!root)return false;
  let node=owner,inside=false;
  for(let depth=0;node&&depth<128;depth++,node=parent(node)){
    if(node===root)inside=true;
  }
  if(node)return null;
  if(!inside)return false;
  node=owner;
  for(let depth=0;node&&depth<128;depth++,node=parent(node)){
    if(unrendered(node))return false;
    if(/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|SVG|CANVAS|INPUT|TEXTAREA|SELECT|OPTION)$/.test(node.tagName)||node.hidden||node.getAttribute('aria-hidden')==='true'||/password|one-time-code|cc-|webauthn/i.test(node.getAttribute('autocomplete')||''))return false;
    const style=getComputedStyle(node);
    if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse')return false;
  }
  return node?null:true;
}`;

export const DOCUMENT_READ_FUNCTION = String.raw`function(maxChars,maxNodes,useThis=false,includeLinks=true,preferMain=true,matchText=null) {
  const parent=node=>node.assignedSlot||node.parentElement||node.parentNode?.host||null;
  const unrendered=node=>!node.assignedSlot&&(!!node.parentElement?.shadowRoot||(node.parentElement?.tagName==='SLOT'&&node.parentElement.assignedNodes().length>0));
  const doc=this?.ownerDocument||(this?.nodeType===9?this:document);
  if(doc.readyState==='loading')return {text:'',truncated:true,loading:true,visited:0,characters:0};
  let root=useThis?this:preferMain?(doc.querySelector('main,article,[role=main]')||doc.body):doc.body;
  if(!root)return {text:'',truncated:false,matched:false,visited:0,characters:0,title:doc.title,url:location.href};
  const blocks=/^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TR|UL)$/;
  const excluded=/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|SVG|CANVAS|INPUT|TEXTAREA|SELECT|OPTION)$/;
  let ancestor=root,ancestors=0;
  while(ancestor){
    if(++ancestors>maxNodes)return {text:'',truncated:true,title:doc.title,url:location.href};
    if(unrendered(ancestor)){
      if(useThis)return {text:'',truncated:false,excluded:true,title:doc.title,url:location.href};
      root=doc.body;break;
    }
    const style=getComputedStyle(ancestor);
    if(excluded.test(ancestor.tagName)||ancestor.hidden||ancestor.getAttribute('aria-hidden')==='true'||/password|one-time-code|cc-|webauthn/i.test(ancestor.getAttribute('autocomplete')||'')||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'){
      if(useThis)return {text:'',truncated:false,excluded:true,title:doc.title,url:location.href};
      root=doc.body;break;
    }
    ancestor=parent(ancestor);
  }
  const searching=typeof matchText==='string'&&matchText.length>0;
  let text='',visited=0,truncated=false,matched=false,characters=0;
  function append(value){
    if(searching){
      const remaining=maxChars-characters;
      if(value.length>remaining){value=value.slice(0,Math.max(0,remaining));truncated=true;}
      characters+=value.length;
      const combined=text+value;
      matched=matched||combined.includes(matchText);
      // Keep only the suffix needed for a match across adjacent text nodes.
      // Retain one character for whitespace/newline normalization below.
      text=combined.slice(-Math.max(1,matchText.length-1));
      return;
    }
    const remaining=maxChars-text.length;
    if(value.length>remaining){let end=Math.max(0,remaining);if(end>0&&/[\uD800-\uDBFF]/.test(value[end-1])&&/[\uDC00-\uDFFF]/.test(value[end]||''))end--;text+=value.slice(0,end);truncated=true;return;}
    text+=value;
  }
  function newline(preserve=false){if(!preserve)text=text.replace(/[\t ]+$/,'');if(text&&!text.endsWith('\n'))append('\n');}
  const stack=[{node:root,exit:false,pre:false}];
  while(stack.length&&!truncated&&!matched){
    const item=stack.pop(),node=item.node;
    if(item.exit){if(item.href)append(' <'+item.href+'>');if(item.block)newline(item.pre);continue;}
    if(++visited>maxNodes){truncated=true;break;}
    if(node.nodeType===3){let value=item.pre?node.nodeValue:node.nodeValue.replace(/\s+/g,' ');if(!item.pre&&(!text||text.endsWith('\n')))value=value.replace(/^ +/,'');append(value);continue;}
    if(node.nodeType!==1)continue;
    const tag=node.tagName;
    if(excluded.test(tag)||node.hidden||node.getAttribute('aria-hidden')==='true'||/password|one-time-code|cc-|webauthn/i.test(node.getAttribute('autocomplete')||''))continue;
    const style=getComputedStyle(node);
    if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse')continue;
    if(tag==='BR'){append('\n');continue;}
    const nativeHeading=/^H[1-6]$/.test(tag)?Number(tag[1]):0;
    const ariaLevel=node.getAttribute('role')==='heading'?Number(node.getAttribute('aria-level')||2):0;
    const heading=nativeHeading||(Number.isInteger(ariaLevel)&&ariaLevel>=1&&ariaLevel<=6?ariaLevel:0);
    const block=blocks.test(tag)||heading>0,pre=item.pre||tag==='PRE'||/^pre/.test(style.whiteSpace);
    if(block)newline(item.pre);
    if(heading&&!searching)append('#'.repeat(heading)+' ');
    let href;
    if(includeLinks&&tag==='A'&&node.hasAttribute('href')){try{const url=new URL(node.href);if((url.protocol==='http:'||url.protocol==='https:')&&!url.username&&!url.password)href=url.href;}catch{}}
    stack.push({node,exit:true,pre,block,href});
    // Bound queued traversal as well as visited nodes on exceptionally wide DOMs.
    // Follow rendered open-shadow content; light children enter only through slots.
    // Unflattened assignment keeps nested slots in the bounded traversal itself.
    let children=node.shadowRoot?node.shadowRoot.childNodes:node.childNodes;
    if(tag==='SLOT'){
      const assigned=node.assignedNodes();
      if(assigned.length)children=assigned;
    }
    const count=children.length;
    if(count+stack.length>maxNodes){truncated=true;break;}
    for(let i=count-1;i>=0;i--)stack.push({node:children[i],exit:false,pre});
  }
  return {text:searching?'':text.replace(/^\n+|\n+$/g,''),truncated,visited,...(searching?{matched,characters}:{}),title:doc.title,url:location.href};
}`;

export function unicodeBoundary(text: string, offset: number): number {
  return offset > 0 && offset < text.length && /[\uD800-\uDBFF]/u.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/u.test(text[offset]!) ? offset - 1 : offset;
}

export function documentChunk(text: string, page: EnginePageStamp, snapshotId: string, offset: number, budgetValue: number|EngineObservationBudget, sourceComplete: boolean): EngineObservation {
  const budget=asObservationBudget(budgetValue);
  if (unicodeBoundary(text, offset) !== offset) throw new EngineError('cursor_expired');
  const observation = (end: number): EngineObservation => {
    const complete = sourceComplete && end === text.length;
    return { state: complete ? 'available' : 'incomplete', trust: 'untrusted_page_content', scope: 'document', page,
      snapshotId, nodes: [], text: text.slice(offset, end), complete,
      ...(end < text.length ? { cursor: `doc:${snapshotId}:${end}` } : {}),
      ...(!complete ? { incompleteReason: end < text.length ? 'output_limit' : 'work_limit' } as const : {}) };
  };
  const fits = (end: number) => budget.fits(observation(end));
  let low = offset, high = text.length;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (fits(middle)) low = middle; else high = middle - 1; }
  const end = unicodeBoundary(text, low);
  if (!fits(end) || (end === offset && end < text.length)) throw new EngineError('output_budget');
  return observation(end);
}

export function boundDocumentUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let low=0,high=text.length;
  while(low<high){const middle=Math.ceil((low+high)/2);if(Buffer.byteLength(text.slice(0,middle))<=maxBytes)low=middle;else high=middle-1;}
  return text.slice(0,unicodeBoundary(text,low));
}
