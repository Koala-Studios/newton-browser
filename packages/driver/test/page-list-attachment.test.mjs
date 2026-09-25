import test from 'node:test';
import assert from 'node:assert/strict';
import {PageExecutor} from '../src/page-executor.ts';

async function fixture(){
  let receive,release,started;
  const attached=new Promise(resolve=>{started=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const executor=new PageExecutor({rootTargetId:'root',epoch:'epoch',claimGeneration:1,tracksOwnedPages:true,signal:new AbortController().signal,close:async()=>{},wire:{
    onEvent(listener){receive=listener;return()=>{};},
    async send(method,params={},route){
      if(method==='Target.attachToTarget')return {sessionId:params.targetId};
      if(method==='Page.enable'&&route==='child'){started();await gate;}
      if(method==='Page.getFrameTree')return {frameTree:{frame:{id:`frame-${route}`,loaderId:`loader-${route}`,url:'https://example.test/'}}};
      if(method==='Accessibility.getFullAXTree')return {nodes:[]};
      return {};
    },
  }});
  await executor.start();
  receive({method:'Target.targetCreated',params:{targetInfo:{type:'page',targetId:'child',openerId:'root'}},sessionId:null});
  await attached;
  return {executor,release,receive};
}
test('page listing waits for a known popup attachment without polling',async()=>{
  const {executor,release}=await fixture();
  let completed=false;const listing=executor.pages().then(pages=>{completed=true;return pages;});
  await Promise.resolve();assert.equal(completed,false);
  release();const pages=await listing;
  assert.deepEqual(pages.map(page=>page.pageId),['root','child']);
  assert.equal(pages[1].openerPageId,'root');assert.equal(pages[0].selected,true);
  await executor.close();
});
test('a popup closed while attaching does not stall listing or remove the parent',async()=>{
  const {executor,release,receive}=await fixture();
  const listing=executor.pages();
  receive({method:'Target.targetDestroyed',params:{targetId:'child'},sessionId:null});
  assert.deepEqual((await listing).map(page=>page.pageId),['root']);
  release();await executor.close();
});
