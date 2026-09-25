import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionEngine} from '../src/session-engine.ts';

const page={pageId:'p',frameId:'f',documentGeneration:1};
const field=(id,ref,name='Useful long field label '.repeat(15))=>({recordId:id,ref,role:'textbox',name,readonly:false,disabled:false});
function harness(){
  let snapshot=0,records=[];
  const engine=new SessionEngine('delta',{bindPage:()=>page,close:async()=>{},act:async()=>({state:'not_requested'}),
    observe:async()=>({state:'available',trust:'untrusted_page_content',scope:'page',nodes:[],records,snapshotId:'s'+(++snapshot)})});
  return {engine,set:value=>{records=value;}};
}
test('compact deltas refresh nested form refs without repeating unchanged content',async()=>{
  const h=harness();
  const form=ref=>({kind:'form',recordId:'form',ref,name:'Profile',complete:true,fields:[field('name',ref+'a'),field('email',ref+'b')]});
  h.set([form('e1')]);const first=await h.engine.observe({mode:'records'});
  h.set([form('e2')]);const next=await h.engine.observe({mode:'records',previousSnapshotId:first.snapshotId});
  assert.equal(next.delta.reset,false);assert.deepEqual(next.records,[]);assert.deepEqual(next.delta.changed,[]);
  assert.deepEqual(next.delta.refs,[{recordId:'form',ref:'e2'},{recordId:'name',ref:'e2a'},{recordId:'email',ref:'e2b'}]);
  assert.deepEqual(next.delta.order,['form']);
  assert.ok(JSON.stringify(next).length<JSON.stringify(first).length/2);
});
test('delta additions removals content changes and ordering reconstruct a current view',async()=>{
  const h=harness(),control=(id,ref,name)=>({...field(id,ref,name),kind:'control'});
  h.set(['a','b','c','d','e'].map(id=>control(id,id+'1')));
  const first=await h.engine.observe({mode:'records'});
  const wanted=[control('c','c2'),control('a','a2','Changed'),control('d','d2'),control('e','e2'),control('f','f2','Added')];
  h.set(wanted);const next=await h.engine.observe({mode:'records',previousSnapshotId:first.snapshotId});
  assert.equal(next.delta.reset,false);assert.deepEqual(next.delta.removed,['b']);
  assert.deepEqual(next.delta.changed.map(r=>r.recordId),['a']);assert.deepEqual(next.delta.added.map(r=>r.recordId),['f']);
  const byId=new Map(first.records.map(r=>[r.recordId,{...r}]));
  for(const id of next.delta.removed)byId.delete(id);
  for(const r of [...next.delta.added,...next.delta.changed])byId.set(r.recordId,r);
  for(const {recordId,ref} of next.delta.refs)byId.get(recordId).ref=ref;
  assert.deepEqual(next.delta.order.map(id=>byId.get(id)),wanted);
});
test('a still retained older baseline is compared before the cache evicts it',async()=>{
  const h=harness();h.set([{...field('a','e1'),kind:'control'}]);
  const first=await h.engine.observe({mode:'records'});
  await h.engine.observe({mode:'records'});
  const third=await h.engine.observe({mode:'records',previousSnapshotId:first.snapshotId});
  assert.equal(third.delta.reset,false);
  const fourth=await h.engine.observe({mode:'records',previousSnapshotId:first.snapshotId});
  assert.equal(fourth.delta.resetReason,'baseline_unavailable');assert.equal(fourth.records.length,1);
});
