import test from 'node:test';
import assert from 'node:assert/strict';
import {PageExecutor} from '../src/page-executor.ts';

test('ordinary document reads traverse frames using the same preferred-root policy',async()=>{
  const executor=new PageExecutor({epoch:'epoch',claimGeneration:1,rootTargetId:'root',signal:new AbortController().signal,wire:{send:async()=>({}),onEvent:()=>()=>{}}});
  const directory=executor.directory;directory.addPage('root');directory.registerRoute('route');
  directory.navigate('root',{frameId:'root-frame',route:'route',loaderId:'root'});
  directory.navigate('root',{frameId:'child',parentId:'root-frame',route:'route',loaderId:'child'});
  executor.resolver.document=async(_context,frame)=>directory.binding(frame,5);
  const modes=[];executor.frameWithinScope=async(_context,_container,_frame,useThis)=>{modes.push(useThis);return true;};
  executor.readBoundText=async(_context,binding)=>({text:binding.frameId,truncated:false,visited:1});
  const result=await executor.readDocument({checkpoint(){}},directory.stamp('root'),8192);
  assert.deepEqual(modes,[false]);assert.match(result.text,/root-frame\n\[Embedded frame\]\nchild/);
});

test('scoped document includes contained frame descendants and expires their continuations',async()=>{
  const executor=new PageExecutor({epoch:'epoch',claimGeneration:1,rootTargetId:'root',signal:new AbortController().signal,wire:{send:async()=>({}),onEvent:()=>()=>{}}});
  const directory=executor.directory;
  directory.addPage('root');directory.registerRoute('route');
  for(const [frameId,parentId] of [['root-frame',undefined],['inside','root-frame'],['outside','root-frame'],['nested','inside']])directory.navigate('root',{frameId,parentId,route:'route',loaderId:frameId});
  const page=directory.stamp('root'),root=directory.binding(page,5),reads=[];
  executor.resolver.resolve=async()=>root;
  executor.resolver.document=async(_context,frame)=>directory.binding(frame,6);
  executor.frameWithinScope=async(_context,_container,frame)=>frame.frameId!=='outside';
  executor.readBoundText=async(_context,binding)=>{reads.push(binding.frameId);return {text:binding.frameId==='root-frame'?'Root':`${binding.frameId} `.repeat(700),truncated:false,visited:10};};
  const context={checkpoint(){}};
  const first=await executor.readDocument(context,page,2048,undefined,{kind:'selector',selector:'#scope'});
  assert.deepEqual(reads,['root-frame','inside','nested']);
  assert.ok(first.cursor);assert.match(first.text,/Root\n\[Embedded frame\]\ninside/);
  directory.navigate('root',{frameId:'inside',parentId:'root-frame',route:'route',loaderId:'new'});
  await assert.rejects(executor.readDocument(context,page,2048,first.cursor),/cursor_expired/);
});
