import fs from 'node:fs/promises';
import {watch} from 'node:fs';
import path from 'node:path';
import {connectNative,type NativeClient} from './native-client.ts';

/** Subscribe before scanning immutable advertisements. No sleep or periodic poll. */
export async function waitForNativePeer(directory:string,accept:(client:NativeClient)=>Promise<boolean>,options:{timeoutMs?:number;signal?:AbortSignal}={}):Promise<NativeClient>{
  options.signal?.throwIfAborted();
  const stat=await fs.lstat(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('native_directory_invalid');
  const root=await fs.realpath(directory);
  return new Promise((resolve,reject)=>{
    let settled=false,running=false,dirty=false;
    const seen=new Set<string>(),clients=new Set<NativeClient>();
    const finish=(error?:Error,selected?:NativeClient)=>{
      if(settled){selected?.close();return;}settled=true;clearTimeout(timer);watcher.close();options.signal?.removeEventListener('abort',abort);
      for(const client of clients)if(client!==selected)client.close();clients.clear();
      error?reject(error):resolve(selected!);
    };
    const abort=()=>finish(new Error('native_reconnect_cancelled'));
    const scan=async()=>{
      if(settled)return;if(running){dirty=true;return;}running=true;
      try{
        const files=(await fs.readdir(root)).filter(name=>/^connection-[a-f0-9-]{36}\.json$/.test(name));
        if(files.length>32)throw new Error('native_connection_capacity');
        const fresh=files.filter(file=>!seen.has(file));for(const file of fresh)seen.add(file);
        if(seen.size>128)throw new Error('native_connection_capacity');
        // At most four concurrent handshakes; a stale endpoint cannot hold up every peer.
        for(let offset=0;offset<fresh.length&&!settled;offset+=4){
          await Promise.all(fresh.slice(offset,offset+4).map(async file=>{
            let client:NativeClient|undefined;
            try{
              client=await connectNative(path.join(root,file));
              if(settled){client.close();return;}clients.add(client);
              if(await accept(client)){finish(undefined,client);return;}
            }catch{/* An unrelated/stale browser is not the update target. */}
            if(client){clients.delete(client);client.close();}
          }));
        }
      }catch(error){finish(error instanceof Error?error:new Error('native_reconnect_failed'));}
      finally{running=false;if(dirty){dirty=false;void scan();}}
    };
    const watcher=watch(root,()=>{void scan();});watcher.on('error',()=>finish(new Error('native_watch_failed')));
    const timer=setTimeout(()=>finish(new Error('native_reconnect_timeout')),options.timeoutMs??20000);
    options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
    void scan();
  });
}
