import {connectNative} from './native-client.ts';
import {existingPageConnection} from './existing-page-family.ts';
import {createHash} from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import {encodeEngineResult,redactText} from '@newton-browser/core';
import type {EngineConnection} from '@newton-browser/driver/connection';

export type ExistingDiscovery={mode:'existing';available:boolean;trust:'untrusted_page_content';connectionId?:string;instanceId?:string;tabs:{tabId:number;title:string;url:string;claimed:boolean}[];incomplete:boolean;errorCode?:string;connections?:ExistingDiscovery[]};
export const existingConnectionId=(advertisement:string)=>'existing_'+createHash('sha256').update(path.resolve(advertisement)).digest('hex').slice(0,24);
export async function nativeAdvertisements(directory:string):Promise<string[]>{
  let stat;try{stat=await fs.lstat(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('native_directory_invalid');
  const files=(await fs.readdir(directory)).filter(name=>/^connection-[a-f0-9-]{36}\.json$/.test(name));
  if(files.length>32)throw new Error('native_connection_capacity');
  return files.map(name=>path.join(directory,name));
}
export async function discoverExistingDirectory(directory:string):Promise<ExistingDiscovery>{
  const files=await nativeAdvertisements(directory);
  const found=await Promise.allSettled(files.map(file=>discoverExistingBrowser(file)));
  const connections=found.flatMap(result=>result.status==='fulfilled'?[result.value]:[]);
  const incomplete=found.some(result=>result.status==='rejected');
  if(connections.length===1)return {...connections[0]!,incomplete:incomplete||connections[0]!.incomplete};
  const result:ExistingDiscovery={mode:'existing',available:connections.length>0,trust:'untrusted_page_content',tabs:[],connections,incomplete,...(!connections.length?{errorCode:'adapter_unavailable'}:{})};
  while(true){
    try{encodeEngineResult(result,8192);break;}catch{
      result.incomplete=true;
      const largest=connections.reduce<ExistingDiscovery|undefined>((chosen,entry)=>!chosen||entry.tabs.length>chosen.tabs.length?entry:chosen,undefined);
      if(largest?.tabs.length){largest.tabs.pop();largest.incomplete=true;}else if(connections.length)connections.pop();else throw new Error('output_budget_exceeded');
    }
  }
  return result;
}
export async function discoverExistingBrowser(advertisement:string):Promise<ExistingDiscovery>{
  const client=await connectNative(advertisement);
  try{
    if(!['tab_claim','scoped_cdp','tab_inventory'].every(cap=>client.hello.capabilities.includes(cap)))throw new Error('native_protocol_mismatch');
    const inventory=await client.call('inventory',{},true);
    if(!Array.isArray(inventory.tabs))throw new Error('native_protocol_mismatch');
    const result:ExistingDiscovery={mode:'existing',available:true,trust:'untrusted_page_content',connectionId:existingConnectionId(advertisement),instanceId:client.hello.epoch,tabs:[],incomplete:inventory.incomplete===true||inventory.tabs.length>128};
    for(const tab of inventory.tabs.slice(0,128)){
      if(!tab||!Number.isSafeInteger(tab.tabId)||tab.tabId<=0||typeof tab.url!=='string'||typeof tab.title!=='string'||typeof tab.claimed!=='boolean'){result.incomplete=true;continue;}
      let url:URL;try{url=new URL(tab.url);}catch{continue;}
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password)continue;
      const title=redactText(tab.title),location=redactText(url.href);
      result.tabs.push({tabId:tab.tabId,title:title.slice(0,256),url:location.slice(0,2048),claimed:tab.claimed});
      if(title.length>256||location.length>2048)result.incomplete=true;
      try{encodeEngineResult({...result,incomplete:true},8192);}catch{result.tabs.pop();result.incomplete=true;break;}
    }
    return result;
  }finally{client.close();}
}

export async function connectExistingTab(advertisement:string,tabId:number,expectedInstanceId?:string):Promise<EngineConnection>{
  return connectExistingPage(advertisement,tabId,expectedInstanceId);
}
export async function createExistingTab(advertisement:string,expectedInstanceId:string):Promise<EngineConnection>{
  return connectExistingPage(advertisement,undefined,expectedInstanceId);
}
async function connectExistingPage(advertisement:string,tabId:number|undefined,expectedInstanceId?:string):Promise<EngineConnection>{
  const client=await connectNative(advertisement,expectedInstanceId);
  const initial:Record<string,unknown>[]=[];
  const stopBuffer=client.onEvent(message=>{if(initial.length<64)initial.push(message);else client.close();});
  try{
    if(!client.hello.capabilities.includes('tab_claim')||!client.hello.capabilities.includes('scoped_cdp'))throw new Error('native_protocol_mismatch');
    if(tabId===undefined&&!client.hello.capabilities.includes('create_tab'))throw new Error('unsupported_capability');
    const token=tabId===undefined?await client.call('create_tab',{}):await client.call('claim',{tabId});
    if(token.epoch!==client.hello.epoch||!Number.isSafeInteger(token.generation)||Number(token.generation)<1||!Number.isSafeInteger(token.tabId)||Number(token.tabId)<1||(tabId!==undefined&&token.tabId!==tabId))throw new Error('native_protocol_mismatch');
    stopBuffer();
    return existingPageConnection(client,{tabId:Number(token.tabId),epoch:client.hello.epoch,generation:Number(token.generation)},initial);
  }catch(error){stopBuffer();client.close();throw error;}
}
