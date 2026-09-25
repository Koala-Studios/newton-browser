import test from 'node:test';
import assert from 'node:assert/strict';
import {handleEngineMcp} from '../apps/mcp-server/src/engine-mcp.ts';

test('screenshot MCP accepts automatic discovery with optional strictly validated extra zones',async()=>{
  const calls=[],context={signal:new AbortController().signal};
  const host={session:()=>({nextCommandId:1}),screenshot:async(sessionId,options)=>{calls.push({sessionId,options});return {state:'unavailable',errorCode:'fixture'};}};
  const call=args=>handleEngineMcp(host,{id:1,method:'tools/call',params:{name:'browser.screenshot',arguments:{sessionId:'s',...args}}},context);
  for(const args of [{},{sensitiveZones:[]},{sensitiveZones:[{kind:'selector',selector:'#custom'}]}]){
    const result=await call(args);assert.equal(result.error,undefined);assert.equal(result.result.isError,undefined);
  }
  assert.deepEqual(calls.map(call=>call.options.options.sensitiveZones),[[],[],[{kind:'selector',selector:'#custom'}]]);
  for(const sensitiveZones of [null,'#custom',{},[{selector:'#custom'}],[{kind:'ref',ref:'e1',selector:'#mixed'}],Array.from({length:33},()=>({kind:'ref',ref:'e1'}))]){
    const result=await call({sensitiveZones});assert.ok(result.error||result.result.isError,JSON.stringify(result));
  }
  assert.equal(calls.length,3,'invalid zones never reach the browser host');
  const catalog=await handleEngineMcp(host,{id:2,method:'tools/list',params:{}},context);
  const schema=catalog.result.tools.find(tool=>tool.name==='browser.screenshot').inputSchema;
  assert.deepEqual(schema.required,['sessionId']);assert.equal(schema.properties.sensitiveZones.items.oneOf.length,3);
});

test('screenshot image allowance delivers images above the text ceiling and enforces explicit limits',async()=>{
  const context={signal:new AbortController().signal},calls=[];
  const imageData=Buffer.alloc(100_000,42).toString('base64');
  const host={session:()=>({nextCommandId:1}),screenshot:async(_id,options)=>{
    calls.push(options);
    return {state:'available',trust:'untrusted_page_content',scope:'page',nodes:[],imageData,mimeType:'image/png'};
  }};
  const call=args=>handleEngineMcp(host,{id:1,method:'tools/call',params:{name:'browser.screenshot',arguments:{sessionId:'s',...args}}},context);
  const result=await call({});
  assert.equal(result.result.content.find(block=>block.type==='image').data,imageData);
  assert.equal(calls[0].maxBytes,2*1024*1024);
  const limited=await call({maxBytes:65536});
  assert.ok(limited.error||limited.result.isError,'final encoder must not exceed a caller budget');
  const before=calls.length;
  for(const maxBytes of [8191,4*1024*1024+1,NaN,1.5]){
    const invalid=await call({maxBytes});assert.ok(invalid.error||invalid.result.isError);
  }
  assert.equal(calls.length,before);
  const catalog=await handleEngineMcp(host,{id:2,method:'tools/list',params:{}},context);
  const tools=catalog.result.tools;
  assert.equal(tools.find(tool=>tool.name==='browser.screenshot').inputSchema.properties.maxBytes.maximum,4*1024*1024);
  assert.equal(tools.find(tool=>tool.name==='browser.observe').inputSchema.properties.maxBytes.maximum,65536);
});
