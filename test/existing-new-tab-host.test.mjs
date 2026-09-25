import test from 'node:test';
import assert from 'node:assert/strict';
import {EngineHost} from '../apps/mcp-server/src/browser-runtime/engine-host.ts';

test('new existing-browser session attaches before navigating its normalized URL',async()=>{
  const calls=[];let location='about:blank',input;
  const host=new EngineHost(async()=>{throw Error('standalone_forbidden');},async request=>{
    input=request;return {rootTargetId:'tab_7',epoch:'epoch',claimGeneration:1,signal:new AbortController().signal,close:async()=>{},wire:{
      onEvent:()=>()=>{},async send(method,params){calls.push(method);
        if(method==='Target.attachToTarget')return {sessionId:'tab_7'};
        if(method==='Page.navigate'){location=params.url;return {};}
        if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'frame',loaderId:location,url:location}}};
        if(method==='Accessibility.getFullAXTree')return {nodes:[]};return {};
      },
    }};
  });
  try{
    const started=await host.start({mode:'existing',connectionId:'selected',target:{kind:'new_tab',instanceId:'epoch',url:'https://example.test'}});
    assert.deepEqual(input,{connectionId:'selected',instanceId:'epoch'});
    assert.equal(location,'https://example.test/');assert.equal(started.mode,'existing');
    assert.ok(calls.indexOf('Page.enable')<calls.indexOf('Page.navigate'));
    assert.ok(calls.indexOf('Target.attachToTarget')<calls.indexOf('Page.navigate'));
  }finally{await host.close();}
});
test('invalid new-tab URL and conflicting target fields fail before connecting',async()=>{
  let connects=0;
  const host=new EngineHost(async()=>{connects++;},async()=>{connects++;});
  for(const target of [
    {kind:'new_tab',instanceId:'epoch',url:'file:///secret'},
    {kind:'new_tab',instanceId:'epoch',url:'https://example.test/',tabId:1},
    {kind:'tab',instanceId:'epoch',tabId:1,url:'https://example.test/'},
  ])await assert.rejects(host.start({mode:'existing',target}));
  assert.equal(connects,0);await host.close();
});
