import test from 'node:test';
import assert from 'node:assert/strict';
import {PageExecutor} from '../src/page-executor.ts';

test('text-only press selects field feedback; submit chords retain broader feedback',async()=>{
  const controller=new AbortController();
  const executor=new PageExecutor({epoch:'epoch',claimGeneration:1,rootTargetId:'root',signal:controller.signal,wire:{send:async()=>({}),onEvent:()=>()=>{}}});
  const binding={pageId:'root',frameId:'frame',documentGeneration:1,backendNodeId:9};
  const calls=[];
  executor.send=async(_binding,method,params)=>{calls.push({method,params});return {};};
  executor.focusedFacts=async()=>({});
  executor.resolver.focused=async()=>binding;
  executor.input={chord:async()=>{}};
  const context={input:async operation=>operation()};
  await executor.pressGlobal(context,binding,undefined,'hello');
  assert.equal(executor.localField,binding);
  assert.deepEqual(calls.map(call=>call.method),['DOM.focus','Input.insertText']);
  assert.equal(calls[1].params.text,'hello');
  executor.localField=undefined;
  await executor.press(context,binding,['Enter'],undefined);
  assert.equal(executor.localField,undefined);
  await executor.press(context,binding,['Enter'],'submitted');
  assert.equal(executor.localField,undefined);
});
