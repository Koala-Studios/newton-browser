import { redactText, type EngineFieldView } from '@newton-browser/core';

type Ax = Record<string, unknown>;
const object = (value: unknown): Ax => value && typeof value === 'object' && !Array.isArray(value) ? value as Ax : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const list = (value: unknown): Ax[] => Array.isArray(value) ? value.map(object) : [];
const roles = new Set(['button','link','textbox','searchbox','combobox','checkbox','radio','switch','menuitem','tab','option','slider','spinbutton','listbox','textarea']);
const contextRoles = new Set(['dialog','alertdialog','form','row','listitem','group','radiogroup','tabpanel','region']);

/** Project relationships from AX evidence without per-control geometry or value reads. */
export function readAXControls(raw: readonly Ax[], scopeBackendNodeId?: number): {
  controls: { backendNodeId: number; view: Omit<EngineFieldView, 'ref'> }[]; incomplete: boolean; foundScope: boolean;
} {
  let incomplete = raw.length > 20_000;
  const nodes=raw.slice(0,20_000);
  const byId=new Map(nodes.filter(node=>typeof node.nodeId==='string').map(node=>[String(node.nodeId),node]));
  const byBackend=new Map(nodes.filter(node=>Number.isSafeInteger(node.backendDOMNodeId)).map(node=>[Number(node.backendDOMNodeId),node]));
  const parent=new Map<string,string>();
  for(const node of nodes) {
    if(typeof node.nodeId!=='string')continue;
    if(typeof node.parentId==='string')parent.set(node.nodeId,node.parentId);
    if(Array.isArray(node.childIds))for(const id of node.childIds)if(typeof id==='string')parent.set(id,node.nodeId);
  }
  let selected: Set<Ax>|undefined;
  if(scopeBackendNodeId!==undefined) {
    const root=byBackend.get(scopeBackendNodeId);
    if(!root)return {controls:[],incomplete,foundScope:false};
    selected=new Set([root]);
    // Parent associations also support partial AX payloads lacking childIds.
    const children=new Map<string,Ax[]>();
    for(const [id,parentId] of parent) {
      const node=byId.get(id);if(!node)continue;
      const siblings=children.get(parentId)??[];siblings.push(node);children.set(parentId,siblings);
    }
    const queue=[root];
    for(let index=0;index<queue.length;index++)for(const child of children.get(text(queue[index]!.nodeId))??[]) {
      if(selected.has(child))continue;selected.add(child);queue.push(child);
    }
  }
  const bounded=(value: unknown,limit=256):string=>{
    const safe=redactText(text(value));if(safe.length>limit)incomplete=true;return safe.slice(0,limit);
  };
  const controls: {backendNodeId:number;view:Omit<EngineFieldView,'ref'>}[]=[];
  const relatedText=(root:Ax):string=>{
    const queue=[root],seen=new Set<Ax>();const parts:string[]=[];
    for(let i=0;i<queue.length;i++) {
      if(seen.size>=256){incomplete=true;break;}
      const item=queue[i]!;if(seen.has(item))continue;seen.add(item);
      const role=text(object(item.role).value);
      if(roles.has(role))continue;
      if(role==='StaticText'){parts.push(text(object(item.name).value));continue;}
      if(Array.isArray(item.childIds))for(const id of item.childIds) {const child=byId.get(String(id));if(child)queue.push(child);else incomplete=true;}
    }
    return parts.join(' ');
  };
  for(const node of nodes) {
    if(selected&&!selected.has(node))continue;
    const role=text(object(node.role).value);
    if(selected&&['Iframe','iframe'].includes(role))incomplete=true;
    if(node.ignored||!roles.has(role)||!Number.isSafeInteger(node.backendDOMNodeId)||Number(node.backendDOMNodeId)<=0)continue;
    const props=list(node.properties);
    const property=(name:string)=>object(props.find(entry=>entry.name===name)?.value);
    const boolean=(name:string)=>typeof property(name).value==='boolean'?property(name).value as boolean:undefined;
    const ancestors:{role:string;name:string}[]=[];
    const seen=new Set<string>();let id=parent.get(text(node.nodeId));
    while(id) {
      if(seen.has(id)||seen.size>=128){incomplete=true;break;}seen.add(id);
      const ancestor=byId.get(id);if(!ancestor)break;
      const rawRole=text(object(ancestor.role).value);
      const ancestorRole=rawRole==='LayoutTableRow'?'row':rawRole;
      if(contextRoles.has(ancestorRole)) {
        const name=bounded(object(ancestor.name).value);
        if(name)ancestors.push({role:ancestorRole,name});
      }
      if(selected&&scopeBackendNodeId===ancestor.backendDOMNodeId)break;
      id=parent.get(id);
    }
    if(ancestors.length>3)incomplete=true;
    const validation:string[]=[];
    for(const related of list(property('errormessage').relatedNodes)) {
      const error=byBackend.get(Number(related.backendDOMNodeId));
      const message=bounded(text(related.text)||(error?(text(object(error.name).value)||relatedText(error)):''));
      if(!message)incomplete=true;
      if(message&&!validation.includes(message))validation.push(message);
    }
    if(validation.length>4)incomplete=true;
    const rawChecked=property('checked').value;
    const checked=rawChecked==='true'?true:rawChecked==='false'?false:rawChecked;
    const selectedValue=boolean('selected'),expanded=boolean('expanded'),required=boolean('required');
    const invalid=property('invalid').value;
    const description=bounded(object(node.description).value);
    let href:string|undefined;
    const destination=property('url').value;
    if(typeof destination==='string') {
      try {const url=new URL(destination);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)href=bounded(url.href,2048);}catch{/* malformed page URL is not an actionable destination */}
    }
    controls.push({backendNodeId:Number(node.backendDOMNodeId),view:{role,name:bounded(object(node.name).value),readonly:boolean('readonly')===true,disabled:boolean('disabled')===true,
      ...(typeof checked==='boolean'||checked==='mixed'?{checked}:{}),
      ...(selectedValue===undefined?{}:{selected:selectedValue}),...(expanded===undefined?{}:{expanded}),...(required===undefined?{}:{required}),
      ...(href===undefined?{}:{href}),...(ancestors.length?{context:ancestors.slice(0,3).reverse()}:{}),
      ...(invalid===undefined?{}:{invalid:invalid!==false&&invalid!=='false'}),
      ...(validation.length?{validation:validation.slice(0,4)}:{}),...(description?{description}:{})}});
  }
  return {controls,incomplete,foundScope:true};
}
