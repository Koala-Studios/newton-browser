import test from 'node:test';
import assert from 'node:assert/strict';
import {EngineError} from '@newton-browser/core';
import {PageExecutor} from '../src/page-executor.ts';
import {CommandContext} from '../src/command-context.ts';

function fixture(){
  const executor=new PageExecutor({epoch:'epoch',claimGeneration:1,rootTargetId:'page',signal:new AbortController().signal,wire:{send:async()=>({}),onEvent:()=>()=>{}}});
  executor.directory.addPage('page');executor.directory.registerRoute('route');
  executor.directory.navigate('page',{frameId:'frame',route:'route',loaderId:'first'});
  return {executor,page:executor.bindPage(),context:new CommandContext(1000)};
}

test('action feedback refreshes once when navigation commits during the optional read',async()=>{
  const {executor,page,context}=fixture();let reads=0;
  executor.observeLocalFeedback=async()=>{
    reads++;executor.directory.navigate('page',{frameId:'frame',route:'route',loaderId:'second'});
    throw new EngineError('stale_target');
  };
  executor.observe=async(_context,current,budget)=>{
    reads++;assert.equal(_context,context);assert.equal(budget.maxBytes,8192);
    return {state:'available',trust:'untrusted_page_content',scope:'page',page:current,nodes:[]};
  };
  try{
    const result=await executor.observeAfterAction(context,page,8192);
    assert.equal(result.page.pageId,page.pageId);assert.ok(result.page.documentGeneration>page.documentGeneration);
    assert.equal(reads,2);
  }finally{context.dispose();}
});

test('feedback never retries unchanged documents, unrelated errors or repeated navigation',async()=>{
  for(const scenario of ['unchanged','unrelated','repeated']){
    const {executor,page,context}=fixture();let reads=0;
    executor.observeLocalFeedback=async()=>{
      reads++;
      if(scenario!=='unchanged')executor.directory.navigate('page',{frameId:'frame',route:'route',loaderId:'second'});
      throw new EngineError(scenario==='unrelated'?'evidence_unavailable':'stale_target');
    };
    executor.observe=async()=>{reads++;throw new EngineError('stale_target');};
    try{
      await assert.rejects(executor.observeAfterAction(context,page,8192),{code:scenario==='unrelated'?'evidence_unavailable':'stale_target'});
      assert.equal(reads,scenario==='repeated'?2:1);
    }finally{context.dispose();}
  }
});
