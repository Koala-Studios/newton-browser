import { EngineError, redactText } from '@newton-browser/core';
import type { CommandContext } from './command-context.ts';
import type { NodeBinding } from './page-directory.ts';
import { DOCUMENT_READ_FUNCTION } from './document-reader.ts';
import { buildTableGrid, type TableGrid, type TableSourceCell, type TableSourceRow } from './table-grid.ts';

type Value=Record<string,unknown>;
const object=(value:unknown):Value=>value&&typeof value==='object'&&!Array.isArray(value)?value as Value:{};
const list=(value:unknown):Value[]=>Array.isArray(value)?value.map(object):[];
const ROW_READ=`function(){
  const read=(${DOCUMENT_READ_FUNCTION});
  if(this.localName!=='tr'||this.cells.length>64)return {unsupported:true};
  const table=this.closest('table'),group=this.parentElement;
  const groupIndex=group===table?-1:Array.prototype.indexOf.call(table.children,group);
  const cells=[];let remaining=4096,truncated=false;
  for(const cell of this.cells){
    const content=read.call(cell,Math.min(1024,remaining),1000,true,false);
    if(content.excluded||content.loading)return {unsupported:true};
    remaining-=content.text.length;truncated=truncated||content.truncated;
    const links=[];const anchors=cell.querySelectorAll('a[href]');
    for(let i=0;i<Math.min(anchors.length,16);i++){
      if(remaining<=0){truncated=true;break;}
      const anchor=anchors[i],label=read.call(anchor,Math.min(256,remaining),256,true,false);
      if(label.excluded)continue;
      truncated=truncated||label.truncated;
      try{const url=new URL(anchor.href);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password){if(url.href.length>2048||url.href.length+label.text.length>remaining){truncated=true;continue;}remaining-=url.href.length+label.text.length;links.push({label:label.text,href:url.href});}}catch{}
    }
    truncated=truncated||anchors.length>16;
    if(cell.id.length>256||(cell.getAttribute('headers')||'').length>4096)return {workLimited:true};
    cells.push({header:cell.localName==='th',domId:cell.id,scope:cell.scope||'auto',rowSpan:cell.rowSpan,colSpan:cell.colSpan,text:content.text,links,
      ...(cell.hasAttribute('headers')?{explicitHeaders:cell.getAttribute('headers').trim().split(/\\s+/).filter(Boolean)}:{})});
  }
  return {groupIndex,rowIndex:this.rowIndex,cells,truncated};
}`;

/** Read one real HTML table. DOM identities bracket each row's read-only facts. */
export async function readNativeTable(context:CommandContext,binding:NodeBinding,
  send:(binding:NodeBinding,method:string,params:Value)=>Promise<Value>):Promise<{grid:Extract<TableGrid,{state:'available'}>;truncated:boolean}> {
  const read=(method:string,params:Value)=>context.read(()=>send(binding,method,params));
  const describe=await read('DOM.describeNode',{backendNodeId:binding.backendNodeId,depth:0});
  if(object(describe.node).localName!=='table')throw new EngineError('unsupported_structure');
  await read('DOM.getDocument',{depth:0});
  const pushed=await read('DOM.pushNodesByBackendIdsToFrontend',{backendNodeIds:[binding.backendNodeId]});
  const nodeId=Array.isArray(pushed.nodeIds)?pushed.nodeIds[0]:undefined;
  if(!Number.isSafeInteger(nodeId)||Number(nodeId)<=0)throw new EngineError('stale_target');
  const query=await read('DOM.querySelectorAll',{nodeId,selector:':scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr'});
  const ids=Array.isArray(query.nodeIds)?query.nodeIds:[];
  if(ids.length>128)throw new EngineError('work_limit');
  const rows:(TableSourceRow&{sourceIndex:number})[]=[];let truncated=false,totalChars=0,totalCells=0;
  for(const id of ids){
    const before=object((await read('DOM.describeNode',{nodeId:id,depth:1})).node);
    const children=list(before.children).filter(node=>node.localName==='td'||node.localName==='th');
    if(!Number.isSafeInteger(before.backendNodeId)||Number(before.backendNodeId)<=0||children.some(node=>!Number.isSafeInteger(node.backendNodeId)||Number(node.backendNodeId)<=0))throw new EngineError('stale_target');
    if(children.length>64||(totalCells+=children.length)>2048)throw new EngineError('work_limit');
    const resolved=await read('DOM.resolveNode',{backendNodeId:before.backendNodeId});
    const objectId=object(resolved.object).objectId;
    if(typeof objectId!=='string')throw new EngineError('stale_target');
    let facts:Value;
    try{
      const result=await read('Runtime.callFunctionOn',{objectId,functionDeclaration:ROW_READ,returnByValue:true,silent:true});
      if(result.exceptionDetails)throw new EngineError('evidence_unavailable');
      facts=object(object(result.result).value);
    }finally{void Promise.resolve().then(()=>send(binding,'Runtime.releaseObject',{objectId})).catch(()=>{});}
    if(facts.workLimited)throw new EngineError('work_limit');
    if(facts.unsupported||!Number.isSafeInteger(facts.groupIndex)||!Number.isSafeInteger(facts.rowIndex)||Number(facts.rowIndex)<0)throw new EngineError('unsupported_structure');
    const raw=list(facts.cells);
    const after=object((await read('DOM.describeNode',{nodeId:id,depth:1})).node);
    const afterIds=list(after.children).filter(node=>node.localName==='td'||node.localName==='th').map(node=>node.backendNodeId);
    if(raw.length!==children.length||JSON.stringify(afterIds)!==JSON.stringify(children.map(node=>node.backendNodeId)))throw new EngineError('stale_target');
    const cells:TableSourceCell[]=raw.map((cell,index)=>{
      if(typeof cell.text!=='string'||typeof cell.header!=='boolean')throw new EngineError('evidence_unavailable');
      totalChars+=cell.text.length+list(cell.links).reduce((sum,link)=>sum+String(link.label??'').length+String(link.href??'').length,0);
      return {id:'cell'+String(children[index]!.backendNodeId),header:cell.header,text:redactText(cell.text),rowSpan:Number(cell.rowSpan),colSpan:Number(cell.colSpan),
        domId:String(cell.domId??''),scope:['row','col','rowgroup','colgroup'].includes(String(cell.scope))?cell.scope as NonNullable<TableSourceCell['scope']>:'auto',
        ...(Array.isArray(cell.explicitHeaders)?{explicitHeaders:cell.explicitHeaders.map(String)}:{}),
        links:list(cell.links).map(link=>({label:redactText(String(link.label??'')),href:redactText(String(link.href??''))}))};
    });
    if(totalChars>262144)throw new EngineError('work_limit');
    truncated ||= facts.truncated===true;
    rows.push({id:'row'+String(before.backendNodeId),groupId:'group'+String(facts.groupIndex),sourceIndex:Number(facts.rowIndex),cells});
  }
  const afterRows=await read('DOM.querySelectorAll',{nodeId,selector:':scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr'});
  if(JSON.stringify(afterRows.nodeIds)!==JSON.stringify(ids))throw new EngineError('stale_target');
  rows.sort((left,right)=>left.sourceIndex-right.sourceIndex);
  if(rows.some((row,index)=>row.sourceIndex!==index))throw new EngineError('stale_target');
  const grid=buildTableGrid(rows);
  if(grid.state==='unsupported')throw new EngineError(grid.reason==='work_limit'?'work_limit':'unsupported_structure');
  return {grid,truncated};
}
