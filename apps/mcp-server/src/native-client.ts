import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import {NativeChannel} from './native-wire.ts';
import {channel as diagnosticChannel} from 'node:diagnostics_channel';
const nativeTrace=diagnosticChannel('newton-browser.native-command');
let nextTraceConnection=0;

type Value=Record<string,unknown>;
export type NativeHello=Readonly<{epoch:string;digest:string;protocolMajor:1;capabilities:readonly string[]}>;
export interface NativeClient {
  readonly hello:NativeHello;
  readonly signal:AbortSignal;
  call(method:string,args:unknown,readOnly?:boolean):Promise<Value>;
  onEvent(listener:(message:Value)=>void):()=>void;
  close():void;
}

/** One authenticated private peer for discovery, claims and update control. */
export async function connectNative(advertisement:string,expectedInstanceId?:string):Promise<NativeClient>{
  const connection=++nextTraceConnection;
  const trace=(id:number,method:string,phase:string)=>{if(nativeTrace.hasSubscribers)nativeTrace.publish({connection,id,method,phase,at:performance.now()});};
  const stat=await fs.lstat(advertisement);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw new Error('native_advertisement_invalid');
  const info=JSON.parse(await fs.readFile(advertisement,'utf8'));
  if(info?.version!==1||typeof info.endpoint!=='string'||typeof info.token!=='string'||!/^[a-f0-9]{64}$/.test(info.token)||typeof info.epoch!=='string'||!/^[a-f0-9-]{36}$/.test(info.epoch))throw new Error('native_advertisement_invalid');
  const endpoint=process.platform==='win32'?`\\\\.\\pipe\\newton-browser-${info.epoch}`:path.join(path.dirname(path.resolve(advertisement)),`socket-${info.epoch}`);
  if(info.endpoint!==endpoint)throw new Error('native_advertisement_invalid');
  const socket=net.connect(endpoint),controller=new AbortController();
  const pending=new Map<number,{resolve(value:Value):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>;method:string}>();
  const listeners=new Set<(message:Value)=>void>();let nextId=1,greetingReceived=false;
  let greeted!:(value:NativeHello)=>void,failed!:(error:Error)=>void;
  const greeting=new Promise<NativeHello>((resolve,reject)=>{greeted=resolve;failed=reject;});void greeting.catch(()=>{});
  let channel:NativeChannel;
  const close=(error=new Error('connection_lost'))=>{
    if(controller.signal.aborted)return;
    controller.abort(error);failed(error);
    for(const [id,record] of pending){trace(id,record.method,'closed');clearTimeout(record.timer);record.reject(error);}pending.clear();listeners.clear();channel?.close();
  };
  channel=new NativeChannel(socket,socket,raw=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw)){close();return;}
    const message=raw as Value;
    if(message.type==='hello'||message.type==='connected'){
      if(greetingReceived){close(new Error('native_protocol_mismatch'));return;}
      if(message.protocolMajor!==1||typeof message.epoch!=='string'||!/^[a-zA-Z0-9_-]{1,120}$/.test(message.epoch)||typeof message.digest!=='string'||!/^[a-f0-9]{64}$/.test(message.digest)||!Array.isArray(message.capabilities)||message.capabilities.length>16||!message.capabilities.every(cap=>typeof cap==='string'&&/^[a-z_]{1,80}$/.test(cap))){close(new Error('native_protocol_mismatch'));return;}
      if(expectedInstanceId!==undefined&&message.epoch!==expectedInstanceId){close(new Error('browser_instance_changed'));return;}
      greetingReceived=true;greeted(Object.freeze({epoch:message.epoch,digest:message.digest,protocolMajor:1,capabilities:Object.freeze([...message.capabilities])}));return;
    }
    if(message.type==='event'){for(const listener of listeners)listener(message);return;}
    if(message.type!=='response'||!Number.isSafeInteger(message.id)||Number(message.id)<1){close(new Error('native_protocol_mismatch'));return;}
    const hasError=Object.hasOwn(message,'error'),hasResult=Object.hasOwn(message,'result');
    if(hasError===hasResult||(!hasError&&(!message.result||typeof message.result!=='object'||Array.isArray(message.result)))){close(new Error('native_protocol_mismatch'));return;}
    const record=pending.get(Number(message.id));if(!record)return;
    trace(Number(message.id),record.method,hasError?'error':'response');
    pending.delete(Number(message.id));clearTimeout(record.timer);
    if(hasError)record.reject(new Error(typeof message.error==='string'&&/^[a-z_]{1,80}$/.test(message.error)?message.error:'connection_failed'));
    else record.resolve(message.result as Value);
  },()=>close());
  const timer=setTimeout(()=>close(new Error('native_handshake_timeout')),5000);
  try{
    await channel.send({type:'connect',token:info.token,protocolMajor:1});
    const hello=await greeting;
    return {hello,signal:controller.signal,
      call(method,args,readOnly=false){
        if(controller.signal.aborted)return Promise.reject(new Error('connection_lost'));
        if(pending.size>=64||nextId>=Number.MAX_SAFE_INTEGER)return Promise.reject(new Error('native_command_capacity'));
        const id=nextId++;
        const command=method==='command'&&args&&typeof args==='object'?(args as Value).method:method;
        const label=typeof command==='string'&&/^[a-zA-Z][a-zA-Z0-9._]{0,79}$/.test(command)?command:'unknown';
        return new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{trace(id,label,'timeout');pending.delete(id);const error=new Error('native_command_timeout');reject(error);if(!readOnly)close(error);},10000);
          pending.set(id,{resolve,reject,timer,method:label});trace(id,label,'sent');
          void channel.send({type:'request',id,method,args}).catch(()=>close());
        });
      },
      onEvent(listener){if(listeners.size>=16)throw new Error('native_listener_capacity');listeners.add(listener);return()=>{listeners.delete(listener);};},
      close:()=>close(),
    };
  }catch(error){close();throw error;}finally{clearTimeout(timer);}
}
