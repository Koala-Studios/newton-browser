import test from 'node:test';
import assert from 'node:assert/strict';
import { readAXSnapshot } from '../src/ax-snapshot.ts';

test('AX control traversal bounds depth and does not request article text layout fragments',async()=>{
  const calls=[];
  const result=await readAXSnapshot(async(method,params)=>{
    calls.push({method,params});
    if(method==='Accessibility.getFullAXTree')return {nodes:[
      {nodeId:'root',role:{value:'RootWebArea'},childIds:['text','container']},
      {nodeId:'text',role:{value:'StaticText'},childIds:['enormous-inline-layout']},
      {nodeId:'container',role:{value:'generic'},childIds:['search']},
    ]};
    assert.equal(params.id,'container');
    return {nodes:[{nodeId:'search',role:{value:'searchbox'},childIds:['private-editor-layout']}]};
  },'frame');
  assert.equal(calls[0].params.depth,4);assert.equal(calls.length,2);
  assert.equal(result.incomplete,false);assert.ok(result.nodes.some(n=>n.nodeId==='search'));
});

test('AX expansion has bounded requests and explicit incompleteness for deep pages',async()=>{
  let calls=0;
  const result=await readAXSnapshot(async(method,params)=>{
    calls++;
    const index=method==='Accessibility.getFullAXTree'?0:Number(params.id)+1;
    return {nodes:[{nodeId:String(index),role:{value:'generic'},childIds:[String(index+1)]}]};
  },'frame');
  assert.equal(calls,65);assert.equal(result.incomplete,true);assert.equal(result.nodes.length,65);
});

test('AX scope starts at the requested backend node without a whole-frame fetch',async()=>{
  const calls=[];
  const result=await readAXSnapshot(async(method,params)=>{calls.push({method,params});return {nodes:method==='Accessibility.getPartialAXTree'?[{nodeId:'scope',role:{value:'group'}}]:[]};},'frame',77);
  assert.deepEqual(calls[0],{method:'Accessibility.getPartialAXTree',params:{backendNodeId:77,fetchRelatives:true}});
  assert.ok(calls.slice(1).every(call=>call.method==='Accessibility.queryAXTree'&&call.params.backendNodeId===77));
  assert.equal(result.incomplete,false);
});

test('deep filter fields and their context survive exhaustion of broad article traversal',async()=>{
  const result=await readAXSnapshot(async(method,params)=>{
    if(method==='Accessibility.getFullAXTree')return {nodes:[{nodeId:'root',backendDOMNodeId:1,role:{value:'RootWebArea'},childIds:['wide']}]};
    if(method==='Accessibility.queryAXTree')return {nodes:params.role==='searchbox'?[{nodeId:'filter',backendDOMNodeId:9,parentId:'form',role:{value:'searchbox'}}]:[]};
    if(method==='Accessibility.getAXNodeAndAncestors')return {nodes:[{nodeId:'form',backendDOMNodeId:8,role:{value:'form'},name:{value:'Issue filters'},childIds:['filter']}]};
    return {nodes:[]};
  },'frame');
  assert.equal(result.incomplete,true);assert.ok(result.nodes.some(n=>n.nodeId==='filter'));assert.ok(result.nodes.some(n=>n.nodeId==='form'));
});
test('primary-landmark links remain discoverable without site-specific selectors',async()=>{
  const result=await readAXSnapshot(async(method,params)=>{
    if(method==='Accessibility.getFullAXTree')return {nodes:[{nodeId:'root',backendDOMNodeId:1,role:{value:'RootWebArea'},childIds:['unexpanded-main']}]};
    if(method==='Accessibility.queryAXTree'&&params.role==='main')return {nodes:[{nodeId:'main',backendDOMNodeId:2}]};
    if(method==='Accessibility.queryAXTree'&&params.role==='link'){assert.equal(params.backendNodeId,2);return {nodes:[{nodeId:'result',backendDOMNodeId:3,role:{value:'link'}}]};}
    return {nodes:[]};
  },'frame');
  assert.deepEqual([...result.primary],[3]);assert.ok(result.nodes.some(node=>node.nodeId==='result'));
});

test('a text query reaches a matching main link past the 128-link bound',async()=>{
  const links=Array.from({length:300},(_,index)=>({nodeId:`l${index}`,backendDOMNodeId:100+index,role:{value:'link'},name:{value:index===176?'WorldWideWeb':`Link ${index}`}}));
  const read=queryText=>readAXSnapshot(async(method,params)=>{
    if(method==='Accessibility.getFullAXTree')return {nodes:[{nodeId:'root',backendDOMNodeId:1,role:{value:'RootWebArea'},childIds:['unexpanded-main']}]};
    if(method==='Accessibility.queryAXTree'&&params.role==='main')return {nodes:[{nodeId:'main',backendDOMNodeId:2}]};
    if(method==='Accessibility.queryAXTree'&&params.role==='link')return {nodes:links};
    return {nodes:[]};
  },'frame',undefined,undefined,queryText);
  const plain=await read(),queried=await read('worldwideweb');
  assert.ok(!plain.nodes.some(node=>node.nodeId==='l176'));
  assert.ok(queried.nodes.some(node=>node.nodeId==='l176'));
  assert.equal(queried.nodes.filter(node=>node.role?.value==='link').length,128);
  assert.equal(queried.incomplete,true);
});

test('role queries a background tab holds back are released by a following accessibility read',async()=>{
  // Chromium answers a pending queryAXTree only when another accessibility read arrives after it.
  const held=[];
  const result=await readAXSnapshot(async(method,params)=>{
    if(method==='Accessibility.getFullAXTree')return {nodes:[{nodeId:'root',backendDOMNodeId:1,role:{value:'RootWebArea'},childIds:['deep']}]};
    if(method==='Accessibility.queryAXTree')return new Promise(resolve=>held.push(()=>resolve({nodes:params.role==='menuitem'?[{nodeId:'item',backendDOMNodeId:5,role:{value:'menuitem'},name:{value:'Import'}}]:[]})));
    if(method==='Accessibility.getPartialAXTree'){assert.deepEqual(params,{backendNodeId:1,fetchRelatives:false});held.splice(0).forEach(release=>release());return {nodes:[]};}
    return {nodes:[]};
  },'frame');
  assert.ok(result.nodes.some(node=>node.nodeId==='item'),'open menu items are queried directly');
  assert.equal(held.length,0);
});
