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
// An owner element with no box paints none of its frame. (getClientRects and isConnected count as side effects here.)
const OWNER_UNRENDERED_FUNCTION='function(){const rect=this.getBoundingClientRect();return rect.width===0&&rect.height===0}';
type Region={x:number;y:number;width:number;height:number};
type RecordValue=Record<string,unknown>;
const object=(value:unknown):RecordValue=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as RecordValue:{};
const quad=(value:unknown):number[]=>{
  if(!Array.isArray(value)||value.length!==8||!value.every(item=>typeof item==='number'&&Number.isFinite(item)))throw new EngineError('evidence_unavailable');
  return value;
};

// Masked fields per capture, and candidate nodes examined per renderer root (hidden payment and code inputs included).
const VISIBLE_LIMIT=32,EXAMINE_LIMIT=256,CHILD_ROOT_LIMIT=64;
const intersects=(a:Region,b:Region)=>a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height;

/** Native search reaches closed shadow roots without exporting DOM attributes or
 * text. Each renderer root is searched once; child renderer quads are projected
 * into the root viewport. All resource allocations have late-result cleanup.
 * With `clip` (root viewport coordinates) only fields and frames that intersect it count. Only visible fields count
 * toward the limit. A child renderer (an embedded cross-site frame such as a payment field) past a budget is masked
 * whole instead of refusing the capture; the page's own document past a budget still refuses it (work_limit).
 */
export async function nativeSensitiveRegions(context:CommandContext,directory:PageDirectory,worlds:ReadonlyWorlds,wire:EngineWire,page:EnginePageStamp,clip?:Region):Promise<{regions:Region[];frames:readonly EnginePageStamp[]}> {
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
  const rootRoute=directory.route(directory.binding(page,1));
  const send=(binding:NodeBinding,method:string,params:RecordValue={})=>context.read(async()=>{
    const result=await wire.send(method,params,directory.route(binding));directory.route(binding);return result;
  });
  // A frame whose owner element has no layout box (display:none, or zero area) paints nothing: `hidden`.
  const transforms=new Map<string,{parent:NodeBinding;owner:number[];width:number;height:number}|'hidden'>();
  // Proof that an owner element without a box model really renders nothing, read in the parent's read-only world.
  // Anything else (a detached node, a failed read) keeps the original error.
  const ownerUnrendered=async(parent:NodeBinding,backendNodeId:number):Promise<boolean>=>{
    let allocation:Promise<RecordValue>|undefined;
    const route=directory.route(parent);
    try{
      const executionContextId=await context.read(()=>worlds.context(parent));
      const resolved=await context.read(()=>allocation=wire.send('DOM.resolveNode',{backendNodeId,executionContextId},directory.route(parent)));
      directory.route(parent);
      const objectId=object(resolved.object).objectId;
      if(typeof objectId!=='string'||!objectId)return false;
      const facts=await send(parent,'Runtime.callFunctionOn',{objectId,functionDeclaration:OWNER_UNRENDERED_FUNCTION,returnByValue:true,silent:true,throwOnSideEffect:true});
      return !facts.exceptionDetails&&object(facts.result).value===true;
    }catch(error){
      if(error instanceof EngineError&&error.code!=='evidence_unavailable')throw error;
      return false;
    }finally{
      void allocation?.then(result=>{const objectId=object(result.object).objectId;if(typeof objectId==='string'&&objectId)return wire.send('Runtime.releaseObject',{objectId},route);}).catch(()=>undefined);
    }
  };
  const zeroArea=(value:number[])=>{
    const xs=value.filter((_,index)=>index%2===0),ys=value.filter((_,index)=>index%2===1);
    return Math.max(...xs)-Math.min(...xs)<=0||Math.max(...ys)-Math.min(...ys)<=0;
  };
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
        let model:RecordValue;
        try{model=await send(parent,'DOM.getBoxModel',{backendNodeId:owner.backendNodeId});}
        catch(error){
          // "Could not compute box model": a hidden payment or wallet frame. Its fields cannot show.
          if(error instanceof EngineError||!await ownerUnrendered(parent,Number(owner.backendNodeId)))throw error;
          transforms.set(route,'hidden');return undefined;
        }
        const ownerQuad=quad(object(model.model).content);
        if(zeroArea(ownerQuad)){transforms.set(route,'hidden');return undefined;}
        const sizeResult=await send(current,'Runtime.evaluate',{expression:'({width:innerWidth,height:innerHeight})',contextId:await context.read(()=>worlds.context(current)),returnByValue:true,silent:true,throwOnSideEffect:true});
        const size=object(object(sizeResult.result).value);
        if(sizeResult.exceptionDetails||typeof size.width!=='number'||typeof size.height!=='number'||!Number.isFinite(size.width)||!Number.isFinite(size.height)||size.width<=0||size.height<=0)throw new EngineError('evidence_unavailable');
        transform={parent:parentRoot,owner:ownerQuad,width:size.width,height:size.height};
        transforms.set(route,transform);
      }
      if(transform==='hidden')return undefined;
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
  const box=(mapped:number[]):Region=>{
    const xs=mapped.filter((_,index)=>index%2===0),ys=mapped.filter((_,index)=>index%2===1);
    const x=Math.min(...xs),y=Math.min(...ys);return {x,y,width:Math.max(...xs)-x,height:Math.max(...ys)-y};
  };
  // A child renderer's whole visible surface in the root viewport (undefined when none of it shows).
  const frameBox=async(binding:NodeBinding):Promise<Region|undefined>=>{
    const mapped=await toRoot(binding,[0,0,1e7,0,1e7,1e7,0,1e7]);
    const region=mapped&&box(mapped);
    return region&&region.width>0&&region.height>0?region:undefined;
  };
  const regions:Region[]=[];
  let children=0;
  // The page's own document first: its budget refuses, a child's masks the child.
  const ordered=[...roots].sort(([left],[right])=>Number(right===rootRoute)-Number(left===rootRoute));
  for(const [route,binding] of ordered){
    const child=route!==rootRoute;
    let whole:Region|undefined;
    const overBudget=()=>{
      if(!whole)throw new EngineError('work_limit');
      regions.push(whole);
      if(regions.length>VISIBLE_LIMIT)throw new EngineError('work_limit');
    };
    await send(binding,'DOM.getDocument',{depth:0});
    let searchAllocation:Promise<RecordValue>|undefined;
    try{
      const search=await context.read(()=>searchAllocation=wire.send('DOM.performSearch',{query:QUERY,includeUserAgentShadowDOM:true},directory.route(binding)));
      directory.route(binding);
      if(typeof search.searchId!=='string'||!search.searchId||!Number.isSafeInteger(search.resultCount)||Number(search.resultCount)<0)throw new EngineError('evidence_unavailable');
      if(search.resultCount===0)continue;
      if(child){
        // A frame with candidates counts only where it shows inside the clip.
        whole=await frameBox(binding);
        if(!whole||(clip&&!intersects(whole,clip)))continue;
        // Storefronts load many cross-site widget and tracking frames in their own renderers (33 on one product page).
        if(++children>CHILD_ROOT_LIMIT){overBudget();continue;}
      }
      if(Number(search.resultCount)>EXAMINE_LIMIT){overBudget();continue;}
      const fieldRegions:Region[]=[];
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
          const region=box(mapped);
          if(region.width<=0||region.height<=0)throw new EngineError('evidence_unavailable');
          if(clip&&!intersects(region,clip))continue;
          fieldRegions.push(region);
        }finally{
          void nodeAllocation?.then(result=>{const objectId=object(result.object).objectId;if(typeof objectId==='string'&&objectId)return wire.send('Runtime.releaseObject',{objectId},route);}).catch(()=>undefined);
        }
      }
      if(regions.length+fieldRegions.length>VISIBLE_LIMIT)overBudget();
      else regions.push(...fieldRegions);
    }finally{
      void searchAllocation?.then(result=>{if(typeof result.searchId==='string'&&result.searchId)return wire.send('DOM.discardSearchResults',{searchId:result.searchId},route);}).catch(()=>undefined);
    }
  }
  for(const frame of frames)directory.route(directory.binding(frame,1));
  const current=[...directory.frames(page.pageId)].sort((a,b)=>a.frameId.localeCompare(b.frameId));
  if(JSON.stringify(current)!==JSON.stringify(frames))throw new EngineError('stale_target','frame_churn');
  return {regions,frames};
}
