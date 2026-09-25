import test from 'node:test';
import assert from 'node:assert/strict';
import {PageExecutor} from '../src/page-executor.ts';

test('offscreen container is revealed before one native wheel and verified by its offset',async()=>{
  const executor=new PageExecutor({epoch:'epoch',claimGeneration:1,rootTargetId:'root',signal:new AbortController().signal,wire:{send:async()=>({}),onEvent:()=>()=>{}}});
  const binding={pageId:'root',frameId:'frame',documentGeneration:1,backendNodeId:4};
  let revealed=false,offset=0;const effects=[];
  executor.resolver.resolve=async()=>binding;
  executor.preparePointerDocument=async()=>{};
  executor.resolver.inspect=async()=>({pointerInView:revealed});
  executor.pointerPoint=async()=>{assert.equal(revealed,true);return {x:10,y:20};};
  executor.send=async(_binding,method,params)=>{
    if(method==='DOM.scrollIntoViewIfNeeded'){effects.push('reveal');revealed=true;return {};}
    if(method==='DOM.resolveNode')return {object:{objectId:'container'}};
    if(method==='Runtime.callFunctionOn')return {result:{value:{x:0,y:offset,connected:true,visibility:'visible'}}};
    if(method==='Input.dispatchMouseEvent'){effects.push('wheel');offset+=params.deltaY;return {};}
    if(method==='Runtime.releaseObject')return {};
    throw Error(method);
  };
  const context={read:async op=>op(),input:async op=>op(),deadline:performance.now()+1000};
  assert.deepEqual(await executor.scroll(context,binding,0,100,{kind:'selector',selector:'#container'}),{state:'met',kind:'visible'});
  assert.deepEqual(effects,['reveal','wheel']);assert.equal(offset,100);
});
