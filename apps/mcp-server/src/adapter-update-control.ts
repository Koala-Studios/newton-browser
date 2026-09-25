import {connectNative} from './native-client.ts';
import {waitForNativePeer} from './native-reconnect.ts';
import type {AdapterControl} from './adapter-installation.ts';

/** The caller journals ticket before mutation and retains it on interrupted recovery. */
export async function developmentUpdateControl(options:{directory:string;advertisement:string;instanceId:string;ticket:string;smokeTabId:number;signal?:AbortSignal;bindingRequired?:boolean}):Promise<AdapterControl&{finish():Promise<void>;close():void}>{
  if(!/^[a-f0-9]{64}$/.test(options.ticket))throw new Error('update_ticket_invalid');
  if(!Number.isSafeInteger(options.smokeTabId)||options.smokeTabId<=0)throw new Error('invalid_tab');
  let client=await connectNative(options.advertisement,options.instanceId);
  let prepared=false;
  const ticket={ticket:options.ticket};
  const compatible=()=>['tab_claim','scoped_cdp','dev_reload','update_binding'].every(cap=>client.hello.capabilities.includes(cap));
  if(!compatible()){client.close();throw new Error('native_protocol_mismatch');}
  return {
    async quiesce(){
      if(!prepared){
        if(options.bindingRequired)await client.call('prove_update',ticket,true);
        else await client.call('prepare_update',ticket);
        prepared=true;
      }
      await client.call('prove_update',ticket,true);
      const result=await client.call('quiesce',{});if(result.state!=='quiescent')throw new Error('adapter_quiesce_failed');
    },
    async reload(){await client.call('reload',{});},
    async waitBootstrap(){
      const previous=client.hello.epoch;client.close();
      client=await waitForNativePeer(options.directory,async candidate=>{
        if(candidate.hello.epoch===previous||!candidate.hello.capabilities.includes('update_binding'))return false;
        await candidate.call('prove_update',ticket,true);return true;
      },options.signal?{signal:options.signal}:{});
      // Preserve a live same-browser peer even on wrong digest, so rollback can reload it.
      if(!compatible())throw new Error('native_protocol_mismatch');
      return client.hello;
    },
    async smoke(){
      await client.call('prove_update',ticket,true);
      // Browser debugger restrictions apply to blank internal pages. The caller
      // supplies an authorized normal tab; smoke reads its document without input/navigation.
      const token=await client.call('claim',{tabId:options.smokeTabId});
      try{
        const document=await client.call('command',{token,method:'DOM.getDocument',params:{depth:0}},true);
        if(!document.root||typeof document.root!=='object'||(document.root as {nodeName?:unknown}).nodeName!=='#document')throw new Error('adapter_smoke_failed');
      }finally{await client.call('release',{token});}
    },
    async finish(){await client.call('finish_update',ticket);client.close();},
    close(){client.close();},
  };
}
