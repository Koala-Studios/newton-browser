import {EngineError,type EnginePageStamp} from '@newton-browser/core';
import type {CommandContext} from './command-context.ts';
import type {EngineWire} from './connection.ts';
import type {PageDirectory,NodeBinding} from './page-directory.ts';
import type {ReadonlyWorlds} from './readonly-world.ts';
import {projectFrameMaskQuad} from './frame-mask-geometry.ts';

const QUERY='[type="password" i], [autocomplete*="password" i], [autocomplete*="one-time-code" i], [autocomplete*="cc-" i], [autocomplete*="webauthn" i]';
export const SENSITIVE_NODE_VISIBLE_FUNCTION=String.raw`function(){
  if(this.nodeType!==1)return false;
  const type=(this.getAttribute('type')||'').toLowerCase(),autocomplete=this.getAttribute('autocomplete')||'';
  if(type!=='password'&&!/password|one-time-code|cc-|webauthn/i.test(autocomplete))return false;
  const rect=this.getBoundingClientRect(),style=getComputedStyle(this);
  return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&style.visibility!=='collapse';
}`;
type Region={x:number;y:number;width:number;height:number};
type RecordValue=Record<string,unknown>;
const object=(value:unknown):RecordValue=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as RecordValue:{};
const quad=(value:unknown):number[]=>{
  if(!Array.isArray(value)||value.length!==8||!value.every(item=>typeof item==='number'&&Number.isFinite(item)))throw new EngineError('evidence_unavailable');
  return value;
};

/** Native search reaches closed shadow roots without exporting DOM attributes or
 * text. Each renderer root is searched once; child renderer quads are projected
 * into the root viewport. All resource allocations have late-result cleanup.
 */
export async function nativeSensitiveRegions(context:CommandContext,directory:PageDirectory,worlds:ReadonlyWorlds,wire:EngineWire,page:EnginePageStamp):Promise<{regions:Region[];frames:readonly EnginePageStamp[]}> {
  const frames=[...directory.frames(page.pageId)].sort((a,b)=>a.frameId.localeCompare(b.frameId));
  if(frames.length>256)throw new EngineError('work_limit');
  const roots=new Map<string,NodeBinding>();
  for(const frame of frames){
    const binding=directory.binding(frame,1),route=directory.route(binding),parent=directory.parent(frame);
    if(!parent||directory.route(directory.binding(parent,1))!==route){
      if(roots.has(route))throw new EngineError('evidence_unavailable');
      roots.set(route,binding);
    }
  }
  if(roots.size>16)throw new EngineError('work_limit');
  const rootRoute=directory.route(directory.binding(page,1));
  const send=(binding:NodeBinding,method:string,params:RecordValue={})=>context.read(async()=>{
    const result=await wire.send(method,params,directory.route(binding));directory.route(binding);return result;
  });
  const transforms=new Map<string,{parent:NodeBinding;owner:number[];width:number;height:number}>();
  const toRoot=async(binding:NodeBinding,source:number[]):Promise<number[]|undefined>=>{
    let current=binding,result=source;
    for(let depth=0;directory.route(current)!==rootRoute;depth++){
      if(depth>=16)throw new EngineError('work_limit');
      const route=directory.route(current);
      let transform=transforms.get(route);
      if(!transform){
        const parentFrame=directory.parent(current);
        if(!parentFrame)throw new EngineError('evidence_unavailable');
        const parent=directory.binding(parentFrame,1),parentRoot=roots.get(directory.route(parent));
        if(!parentRoot)throw new EngineError('evidence_unavailable');
        const owner=await send(parent,'DOM.getFrameOwner',{frameId:current.frameId});
        if(!Number.isSafeInteger(owner.backendNodeId)||Number(owner.backendNodeId)<=0)throw new EngineError('evidence_unavailable');
        const model=await send(parent,'DOM.getBoxModel',{backendNodeId:owner.backendNodeId});
        const sizeResult=await send(current,'Runtime.evaluate',{expression:'({width:innerWidth,height:innerHeight})',contextId:await context.read(()=>worlds.context(current)),returnByValue:true,silent:true,throwOnSideEffect:true});
        const size=object(object(sizeResult.result).value);
        if(sizeResult.exceptionDetails||typeof size.width!=='number'||typeof size.height!=='number'||!Number.isFinite(size.width)||!Number.isFinite(size.height)||size.width<=0||size.height<=0)throw new EngineError('evidence_unavailable');
        transform={parent:parentRoot,owner:quad(object(model.model).content),width:size.width,height:size.height};
        transforms.set(route,transform);
      }
      // The child surface clips its contents. A conservative bounding rectangle
      // preserves that clipping before the projective map; offscreen child fields
      // must not mask unrelated parent content outside the iframe.
      const xs=result.filter((_,index)=>index%2===0),ys=result.filter((_,index)=>index%2===1);
      const left=Math.max(0,Math.min(...xs)),top=Math.max(0,Math.min(...ys));
      const right=Math.min(transform.width,Math.max(...xs)),bottom=Math.min(transform.height,Math.max(...ys));
      if(right<=left||bottom<=top)return undefined;
      result=projectFrameMaskQuad([left,top,right,top,right,bottom,left,bottom],transform.owner,transform.width,transform.height);
      current=transform.parent;
    }
    return result;
  };
  const regions:Region[]=[];
  let matches=0;
  for(const [route,binding] of roots){
    await send(binding,'DOM.getDocument',{depth:0});
    let searchAllocation:Promise<RecordValue>|undefined;
    try{
      const search=await context.read(()=>searchAllocation=wire.send('DOM.performSearch',{query:QUERY,includeUserAgentShadowDOM:true},directory.route(binding)));
      directory.route(binding);
      if(typeof search.searchId!=='string'||!search.searchId||!Number.isSafeInteger(search.resultCount)||Number(search.resultCount)<0)throw new EngineError('evidence_unavailable');
      matches+=Number(search.resultCount);
      if(matches>32)throw new EngineError('work_limit');
      if(search.resultCount===0)continue;
      const found=await send(binding,'DOM.getSearchResults',{searchId:search.searchId,fromIndex:0,toIndex:search.resultCount});
      if(!Array.isArray(found.nodeIds)||found.nodeIds.length!==search.resultCount)throw new EngineError('evidence_unavailable');
      const executionContextId=await context.read(()=>worlds.context(binding));
      for(const nodeId of found.nodeIds){
        if(!Number.isSafeInteger(nodeId)||Number(nodeId)<=0)throw new EngineError('evidence_unavailable');
        let nodeAllocation:Promise<RecordValue>|undefined;
        try{
          const resolved=await context.read(()=>nodeAllocation=wire.send('DOM.resolveNode',{nodeId,executionContextId},directory.route(binding)));
          directory.route(binding);
          const objectId=object(resolved.object).objectId;
          if(typeof objectId!=='string'||!objectId)throw new EngineError('evidence_unavailable');
          const visible=await send(binding,'Runtime.callFunctionOn',{objectId,functionDeclaration:SENSITIVE_NODE_VISIBLE_FUNCTION,returnByValue:true,silent:true,throwOnSideEffect:true});
          if(visible.exceptionDetails||typeof object(visible.result).value!=='boolean')throw new EngineError('evidence_unavailable');
          if(object(visible.result).value===false)continue;
          const model=await send(binding,'DOM.getBoxModel',{nodeId});
          const mapped=await toRoot(binding,quad(object(model.model).border));
          if(!mapped)continue;
          const xs=mapped.filter((_,index)=>index%2===0),ys=mapped.filter((_,index)=>index%2===1);
          const x=Math.min(...xs),y=Math.min(...ys),width=Math.max(...xs)-x,height=Math.max(...ys)-y;
          if(width<=0||height<=0)throw new EngineError('evidence_unavailable');
          regions.push({x,y,width,height});
        }finally{
          void nodeAllocation?.then(result=>{const objectId=object(result.object).objectId;if(typeof objectId==='string'&&objectId)return wire.send('Runtime.releaseObject',{objectId},route);}).catch(()=>undefined);
        }
      }
    }finally{
      void searchAllocation?.then(result=>{if(typeof result.searchId==='string'&&result.searchId)return wire.send('DOM.discardSearchResults',{searchId:result.searchId},route);}).catch(()=>undefined);
    }
  }
  for(const frame of frames)directory.route(directory.binding(frame,1));
  const current=[...directory.frames(page.pageId)].sort((a,b)=>a.frameId.localeCompare(b.frameId));
  if(JSON.stringify(current)!==JSON.stringify(frames))throw new EngineError('stale_target');
  return {regions,frames};
}
