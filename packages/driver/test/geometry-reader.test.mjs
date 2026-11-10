import assert from 'node:assert/strict';
import test from 'node:test';
import {CommandContext} from '../src/command-context.ts';
import {readGeometry} from '../src/geometry-reader.ts';
import {PageDirectory} from '../src/page-directory.ts';

// The page-side function is exercised in a real browser (geometry-read live regression); here the host side: every
// reported element gets a ref, remote objects are released, and a tight budget drops entries while counts stay exact.
function fixture(facts,elementCount){
  const directory=new PageDirectory('epoch');
  directory.registerRoute('root-route');
  directory.addPage('page');
  directory.navigate('page',{frameId:'root',route:'root-route',loaderId:'root'});
  const calls=[];
  const send=async(_binding,method,params)=>{
    calls.push({method,params});
    if(method==='DOM.resolveNode')return {object:{objectId:'root-object'}};
    if(method==='Runtime.callFunctionOn'){
      if(params.functionDeclaration==='function(){return this.facts}')return {result:{value:facts}};
      if(params.functionDeclaration==='function(){return this.nodes}')return {result:{objectId:'nodes-object'}};
      return {result:{objectId:'result-object'}};
    }
    if(method==='Runtime.getProperties')return {result:[...Array.from({length:elementCount},(_,index)=>({name:String(index),value:{objectId:`element-${index}`}})),{name:'length',value:{value:elementCount}}]};
    if(method==='DOM.describeNode')return {node:{backendNodeId:100+Number(params.objectId.split('-')[1])}};
    return {};
  };
  return {directory,send,calls,page:directory.stamp('page')};
}
const element=(node,label)=>({node,label,box:{x:0,y:0,width:10,height:10}});
const list=(count,from)=>({count,items:Array.from({length:Math.min(count,12)},(_,index)=>element(from+index,`p.item-${from+index} "some page text ${from+index}"`))});
const facts=(extra={})=>({viewport:{width:390,height:844},scroll:{x:0,y:0},document:{scrollWidth:640,scrollHeight:2000},horizontalOverflow:true,
  wider:list(1,0),clippedText:list(30,1),images:{count:4,notLoaded:list(2,13)},overlaps:{count:0,items:[]},complete:true,...extra});

test('every reported element carries a ref of the read snapshot, and remote objects are released',async()=>{
  const state=fixture(facts(),15);
  const context=new CommandContext(10_000);
  try{
    const observation=await readGeometry(context,state.page,65536,state.directory.binding(state.page,1),false,{directory:state.directory,send:state.send});
    assert.equal(observation.state,'available');
    const geometry=observation.geometry;
    assert.equal(geometry.wider.items[0].label,'p.item-0 "some page text 0"');
    assert.ok(geometry.wider.items[0].ref);
    assert.equal(geometry.clippedText.count,30);
    assert.equal(geometry.clippedText.items.length,12);
    assert.equal(new Set([...geometry.wider.items,...geometry.clippedText.items,...geometry.images.notLoaded.items].map(item=>item.ref)).size,15);
    assert.ok(!('node' in geometry.wider.items[0]),'the page-side index is not exposed');
    await Promise.resolve();
    const released=state.calls.filter(call=>call.method==='Runtime.releaseObject').map(call=>call.params.objectId);
    for(const id of ['root-object','result-object','nodes-object','element-0','element-14'])assert.ok(released.includes(id),id);
  }finally{context.dispose();}
});

test('a tight budget drops list entries, keeps counts, and says output_limit; a page past the node limit says work_limit',async()=>{
  const state=fixture(facts(),15);
  const context=new CommandContext(10_000);
  try{
    const observation=await readGeometry(context,state.page,2048,state.directory.binding(state.page,1),false,{directory:state.directory,send:state.send});
    assert.equal(observation.state,'incomplete');
    assert.equal(observation.incompleteReason,'output_limit');
    assert.ok(observation.geometry.clippedText.items.length<12);
    assert.equal(observation.geometry.clippedText.count,30);
    const partial=fixture(facts({complete:false}),15);
    const limited=await readGeometry(context,partial.page,65536,partial.directory.binding(partial.page,1),false,{directory:partial.directory,send:partial.send});
    assert.equal(limited.incompleteReason,'work_limit');
  }finally{context.dispose();}
});

test('a list entry naming an element that did not come back refuses the read',async()=>{
  const state=fixture(facts(),3);
  const context=new CommandContext(10_000);
  try{await assert.rejects(readGeometry(context,state.page,65536,state.directory.binding(state.page,1),false,{directory:state.directory,send:state.send}),error=>error?.code==='evidence_unavailable');}
  finally{context.dispose();}
});
