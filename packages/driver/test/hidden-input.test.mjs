import test from 'node:test';
import assert from 'node:assert/strict';
import { PageExecutor } from '../src/page-executor.ts';
import { CommandContext } from '../src/command-context.ts';

function executor(send) {
  const value=new PageExecutor({rootTargetId:'p1',epoch:'epoch',claimGeneration:1,signal:new AbortController().signal,close:async()=>{},wire:{send,onEvent:()=>()=>{}}});
  value.directory.registerRoute('route');value.directory.addPage('p1');value.directory.navigate('p1',{frameId:'f1',route:'route',loaderId:'a'});
  return value;
}

test('a stalled optional frame observation cannot stall verified scrolling or accumulate captures',async()=>{
  let finishCapture;let captures=0;let wheels=0;let offset=0;
  const capture=new Promise(resolve=>{finishCapture=resolve;});
  const value=executor(async(method,params)=>{
    if(method==='Runtime.evaluate')return {result:{value:{x:0,y:offset,visibility:'hidden'}}};
    if(method==='Page.captureScreenshot'){captures++;return capture;}
    assert.equal(method,'Input.dispatchMouseEvent');assert.equal(params.type,'mouseWheel');wheels++;offset+=100;return {};
  });
  const context=new CommandContext(1000);
  try {
    for(let i=0;i<2;i++)assert.deepEqual(await value.act(context,value.bindPage(),{kind:'scroll',x:0,y:100}),{state:'met',kind:'visible'});
    assert.equal(wheels,2);assert.equal(captures,1);assert.equal(context.dispatch,'acknowledged');
  } finally {finishCapture({data:'discarded'});context.dispose();await value.close();}
});

test('hidden pointer preparation is observed once per document and invalidated by navigation',async()=>{
  let captures=0;let finishCapture;let signalCapture;
  let started=new Promise(resolve=>{signalCapture=resolve;});
  const value=executor(async method=>{
    if(method==='Runtime.evaluate')return {result:{value:'hidden'}};
    assert.equal(method,'Page.captureScreenshot');captures++;return new Promise(resolve=>{finishCapture=resolve;signalCapture();});
  });
  const context=new CommandContext(1000);
  try {
    const first=value.preparePointerDocument(context,value.directory.binding(value.bindPage(),10));
    await started;
    value.directory.navigate('p1',{frameId:'f1',route:'route',loaderId:'b'});
    finishCapture({data:'discarded'});
    await assert.rejects(first,error=>error.code==='stale_target');
    started=new Promise(resolve=>{signalCapture=resolve;});
    const second=value.preparePointerDocument(context,value.directory.binding(value.bindPage(),10));
    await started;finishCapture({data:'discarded'});await second;
    await value.preparePointerDocument(context,value.directory.binding(value.bindPage(),11));
    assert.equal(captures,2);assert.equal(context.dispatch,'not_started');
  } finally {context.dispose();await value.close();}
});

test('visible pointer preparation does not capture pixels',async()=>{
  const value=executor(async method=>{assert.equal(method,'Runtime.evaluate');return {result:{value:'visible'}};});
  const context=new CommandContext(1000);
  try {await value.preparePointerDocument(context,value.directory.binding(value.bindPage(),10));assert.equal(context.dispatch,'not_started');}
  finally {context.dispose();await value.close();}
});
