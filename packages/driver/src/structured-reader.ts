import { createHash } from 'node:crypto';
import { EngineError,redactText,type EngineObservation,type EngineObservationBudget,type EngineObservationRecord,type EnginePageStamp,type EngineRecordShape,type EngineTarget,type EngineTableRecord,type EngineFieldView } from '@newton-browser/core';
import type {CommandContext} from './command-context.ts';
import type {PageDirectory,NodeBinding} from './page-directory.ts';
import type {TargetResolver} from './target-resolver.ts';
import {readNativeTable} from './table-reader.ts';
import {readAXSnapshot} from './ax-snapshot.ts';
import {readAXControls} from './control-reader.ts';
type Value=Record<string,unknown>;
const object=(value:unknown):Value=>value&&typeof value==='object'&&!Array.isArray(value)?value as Value:{};
const list=(value:unknown):Value[]=>Array.isArray(value)?value.map(object):[];
const identity=(binding:NodeBinding)=>'n'+createHash('sha256').update(JSON.stringify(binding)).digest('hex').slice(0,32);
const previewRef='e9007199254740991';

export async function readStructuredRecords(context:CommandContext,page:EnginePageStamp,budget:EngineObservationBudget,shape:Exclude<EngineRecordShape,'controls'>,scope:EngineTarget|undefined,
  dependencies:{directory:PageDirectory;resolver:TargetResolver;send:(binding:NodeBinding,method:string,params:Value)=>Promise<Value>}):Promise<EngineObservation>{
  const {directory,resolver,send}=dependencies;
  const read=(binding:NodeBinding,method:string,params:Value)=>context.read(()=>send(binding,method,params));
  const view=(records:readonly EngineObservationRecord[],complete:boolean,reason:'output_limit'|'work_limit'|'rendered_subset'='rendered_subset'):EngineObservation=>({
    state:complete?'available':'incomplete',trust:'untrusted_page_content',scope:scope||shape!=='links'?'target':'page',page,nodes:[],records,
    snapshotId:'s9007199254740991',expiredSnapshots:['s9007199254740991','s9007199254740991'],...(complete?{}:{incompleteReason:reason}),
  });
  const publish=(bindings:readonly NodeBinding[],build:(refs:readonly string[])=>EngineObservation):EngineObservation=>{
    context.checkpoint();directory.binding(page,1);
    const published=directory.publish(bindings);
    return {...build(published.refs),snapshotId:published.snapshotId,expiredSnapshots:published.expiredSnapshots} as EngineObservation;
  };
  if(shape==='table'){
    const root=await resolver.resolve(context,page,scope??{kind:'selector',selector:'table'});
    const {grid,truncated}=await readNativeTable(context,root,send);
    const ax=list((await read(root,'Accessibility.getPartialAXTree',{backendNodeId:root.backendNodeId,fetchRelatives:false})).nodes);
    const name=redactText(String(object(ax.find(node=>node.backendDOMNodeId===root.backendNodeId)?.name).value??'')).slice(0,256);
    const record=(count:number,ref:string):EngineTableRecord=>{
      const needed=new Set(grid.cells.filter(cell=>cell.row<count).map(cell=>cell.id));
      const byId=new Map(grid.cells.map(cell=>[cell.id,cell]));
      for(const id of needed)for(const headerId of byId.get(id)?.headerIds??[])needed.add(headerId);
      const cells=grid.cells.filter(cell=>needed.has(cell.id)).map(cell=>({id:cell.id,row:cell.row,column:cell.column,rowSpan:cell.effectiveRowSpan,colSpan:cell.colSpan,header:cell.header,text:cell.text,links:cell.links??[],headerIds:cell.headerIds,headersUnresolved:cell.headersUnresolved}));
      return {kind:'table',recordId:identity(root),ref,name,coverage:'rendered',columns:Array.from({length:grid.columns},(_,column)=>({id:'c'+(column+1),headerIds:grid.cells.filter(cell=>needed.has(cell.id)&&cell.header&&cell.scope==='col'&&column>=cell.column&&column<cell.column+cell.colSpan).map(cell=>cell.id)})),rows:grid.rows.slice(0,count),cells,complete:count===grid.rows.length&&!truncated};
    };
    let low=0,high=grid.rows.length;
    while(low<high){const middle=Math.ceil((low+high)/2);if(budget.fits(view([record(middle,previewRef)],false,'output_limit')))low=middle;else high=middle-1;}
    if((low===0&&grid.rows.length>0)||!budget.fits(view([record(low,previewRef)],false,'output_limit')))throw new EngineError('output_budget');
    const complete=low===grid.rows.length&&!truncated;
    return publish([root],refs=>view([record(low,refs[0]!)],complete,low<grid.rows.length?'output_limit':'work_limit'));
  }
  if(shape==='form'){
    const root=await resolver.resolve(context,page,scope??{kind:'selector',selector:'form'});
    const ax=await readAXSnapshot((method,params)=>read(root,method,params),root.frameId,root.backendNodeId);
    const described=object((await read(root,'DOM.describeNode',{backendNodeId:root.backendNodeId,depth:0})).node);
    if(described.localName!=='form'&&object(ax.nodes.find(node=>node.backendDOMNodeId===root.backendNodeId)?.role).value!=='form')throw new EngineError('unsupported_structure');
    const projection=readAXControls(ax.nodes,root.backendNodeId);
    if(!projection.foundScope)throw new EngineError('evidence_unavailable');
    const name=redactText(String(object(ax.nodes.find(node=>node.backendDOMNodeId===root.backendNodeId)?.name).value??'')).slice(0,256);
    const fields:Omit<EngineFieldView,'ref'>[]=[],bindings=[root];
    const build=(refs:readonly string[],complete:boolean)=>view([{kind:'form',recordId:identity(root),ref:refs[0]!,name,fields:fields.map((field,index)=>({...field,ref:refs[index+1]!})),complete}],complete,'output_limit');
    let limited=false;
    for(const field of projection.controls.slice(0,511)){
      const binding=directory.binding(root,field.backendNodeId);
      fields.push({...field.view,recordId:identity(binding)});
      if(!budget.fits(build(Array(fields.length+1).fill(previewRef),false))){fields.pop();limited=true;continue;}
      bindings.push(binding);
    }
    if(!budget.fits(build(Array(fields.length+1).fill(previewRef),false)))throw new EngineError('output_budget');
    return publish(bindings,refs=>build(refs,!limited&&!ax.incomplete&&!projection.incomplete&&fields.length===projection.controls.length));
  }
  const roots:NodeBinding[]=[];
  if(scope)roots.push(await resolver.resolve(context,page,scope));
  else{
    const frames=directory.frames(page.pageId);
    for(let index=0;index<frames.length;index+=8){
      const results=await Promise.allSettled(frames.slice(index,index+8).map(frame=>resolver.document(context,frame)));
      for(const result of results){if(result.status==='fulfilled')roots.push(result.value);else throw result.reason;}
    }
  }
  const records:EngineObservationRecord[]=[],bindings:NodeBinding[]=[];
  let complete=!resolver.isSearchIncomplete(),limited=false,visited=0;
  for(const root of roots){
    const result=await read(root,'Accessibility.queryAXTree',{backendNodeId:root.backendNodeId,role:'link'});
    const raw=list(result.nodes);visited+=raw.length;
    const projected=readAXControls(raw);complete&&=!projected.incomplete;
    for(const item of projected.controls){
      if(bindings.length>=512){limited=true;break;}
      if(item.view.role!=='link'||!item.view.href)continue;
      const binding=directory.binding(root,item.backendNodeId);
      const record={...item.view,kind:'link' as const,recordId:identity(binding),ref:previewRef};
      if(!budget.fits(view([...records,record],false,'output_limit'))){limited=true;continue;}
      records.push(record);bindings.push(binding);
    }
    if(visited>20000){complete=false;break;}
  }
  if(scope&&directory.frames(page.pageId).length>1)complete=false;
  return publish(bindings,refs=>view(records.map((record,index)=>({...record,ref:refs[index]!})),complete&&!limited,limited?'output_limit':'rendered_subset'));
}
