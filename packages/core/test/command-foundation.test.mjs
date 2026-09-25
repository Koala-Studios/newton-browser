import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEngineCommand, normalizeEngineUrl } from '../src/command-contract.ts';
import { encodeEngineReceipt } from '../src/receipt-encoding.ts';
import { NativeAssembly, nativePackets } from '../src/native-packets.ts';
const command={commandId:1,action:{kind:'fill',target:{kind:'ref',ref:'e1'},value:'typed'}};

test('file selection and real-window resize have strict bounded command shapes',()=>{
  for(const action of [{kind:'resize',width:640,height:480},{kind:'set_files',target:command.action.target,files:['C:\\media.png']}])assert.equal(parseEngineCommand({commandId:1,action}).action.kind,action.kind);
  for(const action of [{kind:'resize',width:0,height:480},{kind:'resize',width:640.5,height:480},{kind:'resize',width:640,height:480,scale:2},{kind:'set_files',target:command.action.target,files:[]},{kind:'set_files',files:['C:\\media.png']},{kind:'set_files',target:command.action.target,files:Array(9).fill('C:\\media.png')}])assert.throws(()=>parseEngineCommand({commandId:1,action}),/invalid_arguments/);
});

test('dialog actions require an exact dialog identity and only acceptance accepts prompt text',()=>{
  assert.equal(parseEngineCommand({commandId:1,action:{kind:'dialog_accept',dialogId:'dialog1',promptText:''}}).action.promptText,'');
  for(const action of [{kind:'dialog_accept'}, {kind:'dialog_dismiss',dialogId:'dialog1',promptText:'no'}, {kind:'dialog_accept',dialogId:'dialog1',accept:true}]) assert.throws(()=>parseEngineCommand({commandId:1,action}),/invalid_arguments/);
});

test('pointer variants validate exact targets, button counts and capture provenance',()=>{
  for(const action of [
    {kind:'hover',target:command.action.target},
    {kind:'move',captureId:'capture1',x:5,y:8},
    {kind:'click',target:command.action.target,button:'right',clickCount:2},
    {kind:'scroll',target:command.action.target,x:0,y:100},
  ]) assert.equal(parseEngineCommand({commandId:1,action}).action.kind,action.kind);
  for(const action of [
    {kind:'hover',target:command.action.target,button:'left'},
    {kind:'move',x:5,y:8},
    {kind:'click',target:command.action.target,button:'back'},
    {kind:'click',target:command.action.target,clickCount:0},
  ]) assert.throws(()=>parseEngineCommand({commandId:1,action}),/invalid_arguments/);
});

test('waits require meaningful predicates and one complete targeting strategy',()=>{
  for(const waitFor of [{timeoutMs:100},{state:'detached'},{value:'x'}, {selector:''}, {role:'button'},
    {ref:'e1',selector:'input'}, {selector:'input',state:['visible']}, {selector:'input',state:'value'}, {selector:'input',value:'x'}]) {
    assert.throws(()=>parseEngineCommand({commandId:1,action:{kind:'wait_for',waitFor}}),/invalid_arguments/,JSON.stringify(waitFor));
  }
  for(const waitFor of [{url:'https://example.org'}, {selector:'input',state:'value',value:''}, {role:'button',name:'Save',state:'visible'}])
    assert.equal(parseEngineCommand({commandId:1,action:{kind:'wait_for',waitFor}}).action.kind,'wait_for');
});
test('strict canonical parsing rejects mixed targets and unsupported action bags before admission',()=>{
  const parsed=parseEngineCommand(command);assert.ok(Object.isFrozen(parsed.action.target));assert.equal(parsed.maxBytes,8192);
  assert.throws(()=>parseEngineCommand({...command,action:{...command.action,target:{kind:'ref',ref:'e1',selector:'input'}}}),/invalid_arguments/);
  const click=parseEngineCommand({...command,action:{kind:'click',target:command.action.target}});
  assert.equal(click.action.kind,'click');
  assert.throws(()=>parseEngineCommand({...command,action:{kind:'click',target:command.action.target, value:'unexpected'}}),/invalid_arguments/);
  assert.throws(()=>parseEngineCommand({...command,commandId:0}),/invalid_arguments/);
  assert.throws(()=>parseEngineCommand({...command,maxBytes:2048,action:{kind:'sequence',steps:Array(32).fill(command.action)}}),/output_budget/);
  assert.equal(normalizeEngineUrl('https://example.org/full/path?q=yes#fragment'),'https://example.org/full/path?q=yes#fragment');
  assert.throws(()=>normalizeEngineUrl('https://user:secret@example.org'),/invalid_arguments/);
});
test('encoded receipt preserves mandatory input facts within an escaped UTF8 budget',()=>{
  const receipt={sessionId:'session',commandId:1,state:'finished',reason:'completed',dispatch:'acknowledged',postcondition:{state:'met',kind:'value'},nextCommandId:2,
    page:{pageId:'p',frameId:'f',documentGeneration:1},steps:[],observation:{state:'available',trust:'untrusted_page_content',scope:'page',nodes:Array.from({length:512},(_,i)=>({ref:`e${i}`,role:'textbox',name:'文😀\\"'.repeat(100),readonly:false,disabled:false}))}};
  const encoded=encodeEngineReceipt(receipt,2048);assert.ok(Buffer.byteLength(JSON.stringify(encoded))<=2048);
  const value=JSON.parse(encoded.content[0].text);assert.equal(value.dispatch,'acknowledged');assert.equal(value.postcondition.state,'met');assert.equal(value.observation.errorCode,'output_budget');
});
test('native assembly is bounded, ordered, expires partial data, and reconstructs large Unicode',()=>{
  const value={text:'文😀'.repeat(100000)};const assembly=new NativeAssembly();let result;
  for(const packet of nativePackets('message',value))result=assembly.accept(packet);
  assert.deepEqual(result.value,value);
  let now=0;const expiring=new NativeAssembly(()=>now);const packets=[...nativePackets('partial',value)];expiring.accept(packets[0]);now=10001;
  assert.throws(()=>expiring.accept(packets[1]),/native_reassembly_limit/);
  assert.throws(()=>[...nativePackets('too_big',{text:'x'.repeat(5*1024*1024)})],/native_message_limit/);
});
