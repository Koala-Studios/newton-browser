import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { NativeAssembly, nativePackets } from '../packages/core/src/native-packets.ts';

test('actual adapter worker returns an oversized-response error and retains the same tab claim', {timeout:5000},async()=>{
  const bundled=await build({entryPoints:[fileURLToPath(new URL('../apps/tab-adapter/src/worker.ts',import.meta.url))],bundle:true,write:false,platform:'browser',format:'iife',logLevel:'silent'});
  let receive;let next=0;let detached=0;
  const pending=new Map(),assembly=new NativeAssembly();
  const listener={addListener(){}};
  const chrome={
    runtime:{id:'a'.repeat(32),getURL:file=>'chrome-extension://'+'a'.repeat(32)+'/'+file,reload(){},onMessage:listener,
      connectNative:name=>{assert.equal(name,'newton.browser.'+'a'.repeat(32));return {onMessage:{addListener(fn){receive=fn;}},onDisconnect:listener,postMessage(packet){
        const result=assembly.accept(packet)?.value;if(result?.payload?.type!=='response')return;
        const resolve=pending.get(result.payload.id);pending.delete(result.payload.id);resolve?.(result.payload);
      }};}},
    debugger:{attach:async()=>{},detach:async()=>{detached++;},onEvent:listener,onDetach:listener,
      sendCommand:async(_target,method)=>method==='Accessibility.getFullAXTree'?{nodes:[{name:{value:'x'.repeat(5*1024*1024)}}]}:{root:{nodeId:1}}},
    tabs:{query:async()=>[],onCreated:listener,onRemoved:listener},
    webNavigation:{onCreatedNavigationTarget:listener},
  };
  vm.runInNewContext(bundled.outputFiles[0].text,{chrome,crypto:webcrypto,fetch:async()=>({arrayBuffer:async()=>new ArrayBuffer(0)}),URL,TextEncoder,TextDecoder,performance,setTimeout,clearTimeout});
  const deliver=value=>{for(const packet of nativePackets('message'+(++next),value))receive(packet);};
  const request=(method,args)=>{const id=++next;const result=new Promise(resolve=>pending.set(id,resolve));deliver({type:'request',connectionId:'worker',request:{id,method,args}});return result;};
  deliver({type:'open',connectionId:'worker'});
  const claim=await request('claim',{tabId:1});assert.ok(claim.result?.generation);
  const oversized=await request('command',{token:claim.result,method:'Accessibility.getFullAXTree',params:{}});
  assert.equal(oversized.error,'native_message_limit');
  const following=await request('command',{token:claim.result,method:'DOM.getDocument',params:{depth:0}});
  assert.equal(following.result.root.nodeId,1);assert.equal(detached,0);
  await request('release',{token:claim.result});assert.equal(detached,1);assert.equal(pending.size,0);
});
