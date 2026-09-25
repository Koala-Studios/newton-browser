import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineError } from '@newton-browser/core';
import { PageExecutor } from '../src/page-executor.ts';
import { CommandContext } from '../src/command-context.ts';

function setup(){
  const executor=new PageExecutor({epoch:'test',claimGeneration:1,signal:new AbortController().signal});
  executor.directory.registerRoute('route');executor.directory.addPage('page');
  executor.directory.navigate('page',{frameId:'frame',route:'route',loaderId:'old'});
  return executor;
}
test('condition probe crossing a navigation retries reads in the new document without replaying input',async()=>{
  const executor=setup(),context=new CommandContext(1000);let probes=0;
  executor.waitFact=async()=>{if(++probes===1){executor.directory.navigate('page',{frameId:'frame',route:'route',loaderId:'new'});throw new EngineError('stale_target');}return true;};
  try {assert.equal((await executor.waitFor(context,executor.bindPage(),{text:'article'})).state,'met');assert.equal(probes,2);}finally{context.dispose();}
});
test('condition probe failures in an unchanged document are not concealed by retry',async()=>{
  const executor=setup(),context=new CommandContext(1000);let probes=0;
  executor.waitFact=async()=>{probes++;throw new EngineError('evidence_unavailable');};
  try {await assert.rejects(executor.waitFor(context,executor.bindPage(),{text:'article'}),/evidence_unavailable/);assert.equal(probes,1);}finally{context.dispose();}
});

test('a same-generation DOM invalidation retries only the read probe',async()=>{
  const executor=setup(),context=new CommandContext(1000);let probes=0;
  const generation=executor.bindPage().documentGeneration;
  executor.waitFact=async()=>{if(++probes===1){executor.domRevisions.set('page',1);throw new EngineError('evidence_unavailable');}return true;};
  try{assert.equal((await executor.waitFor(context,executor.bindPage(),{text:'article'})).state,'met');assert.equal(probes,2);assert.equal(executor.bindPage().documentGeneration,generation);assert.equal(context.dispatch,'not_started');}finally{context.dispose();}
});

test('another page DOM invalidation cannot conceal a broken read on this page',async()=>{
  const executor=setup(),context=new CommandContext(1000);let probes=0;
  executor.waitFact=async()=>{probes++;executor.domRevisions.set('other',1);throw new EngineError('evidence_unavailable');};
  try{await assert.rejects(executor.waitFor(context,executor.bindPage(),{text:'article'}),/evidence_unavailable/);assert.equal(probes,1);}finally{context.dispose();}
});
test('document snapshots wait for parsing and never retain the incomplete loading prefix',async()=>{
  const executor=setup(),context=new CommandContext(1000);let reads=0,wakes=0;
  executor.resolver.document=async(_context,page)=>executor.directory.binding(page,10);
  executor.readBoundText=async()=>++reads===1?{text:'',truncated:true,loading:true}:{text:'Complete article',truncated:false};
  executor.waitForCondition=async()=>{wakes++;assert.equal(executor.documents.size,0);};
  try{const result=await executor.readDocument(context,executor.bindPage(),2048);assert.equal(result.text,'Complete article');assert.equal(result.complete,true);assert.equal(wakes,1);assert.equal(executor.documents.size,1);}finally{context.dispose();}
});
