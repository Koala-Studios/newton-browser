import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {acquireInstallationLock} from './installation-lock.ts';

export type UpdatePhase='prepared'|'publishing'|'published'|'verified'|'committed';
export type UpdateJournal={version:1;installationId:string;ticket:string;previous:string;next:string;previousCode:string;nextCode:string;phase:UpdatePhase;target:string;epoch?:string};
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const sha=/^[a-f0-9]{64}$/;
const cap=3*1024*1024;

/** A single bounded record contains both opaque code snapshots and write-ahead
 * state. It survives worker exit; kernel ownership does not. No browser state is
 * stored here. Retaining the last committed record bounds disk use to one update. */
export async function openUpdateJournal(directory:string){
  const lease=await acquireInstallationLock(directory);
  const rootIdentity=await fs.lstat(lease.directory).catch(async error=>{await lease.release();throw error;});
  let record:UpdateJournal|undefined,poisoned=false;
  const assertOwned=async()=>{
    lease.signal.throwIfAborted();
    if(poisoned)throw new Error('adapter_update_recovery_required');
    const now=await fs.lstat(lease.directory);
    if(!now.isDirectory()||now.isSymbolicLink()||now.dev!==rootIdentity.dev||now.ino!==rootIdentity.ino)throw new Error('adapter_path_changed');
  };
  const filename=path.join(lease.directory,'update.json');
  try{record=await readJournal(filename);}catch(error){await lease.release();throw error;}
  // Operations must finish before release. Serialize even accidental concurrent
  // callers so a late write cannot overwrite a newer journal phase.
  let tail:Promise<unknown>=Promise.resolve(),closing=false;
  const serial=<T>(operation:()=>Promise<T>):Promise<T>=>{
    if(closing)return Promise.reject(new Error('installation_lock_released'));
    const result=tail.then(operation);tail=result.catch(()=>undefined);return result;
  };
  const save=async(next:UpdateJournal)=>{
    await assertOwned();validate(next);
    const stage=path.join(lease.directory,`update-${randomUUID()}.stage`);
    const handle=await fs.open(stage,'wx',0o600);
    try{
      try{await handle.writeFile(JSON.stringify(next)+'\n');await handle.sync();}finally{await handle.close();}
      await assertOwned();await fs.rename(stage,filename);
      // POSIX directory fsync makes the rename durable as well as the file data.
      if(process.platform!=='win32'){const directoryHandle=await fs.open(lease.directory,'r');try{await directoryHandle.sync();}finally{await directoryHandle.close();}}
      record=next;
    }catch(error){poisoned=true;throw error;}
    finally{await fs.unlink(stage).catch(error=>{if(error.code!=='ENOENT'){poisoned=true;throw error;}});}
  };
  return {
    signal:lease.signal,
    assertOwned,
    read():UpdateJournal|undefined{return record?{...record}:undefined;},
    begin(installationId:string,previous:Buffer,next:Buffer){return serial(async()=>{
      if(record&&record.phase!=='committed')throw new Error('adapter_update_recovery_required');
      if(previous.length>1024*1024||next.length>1024*1024)throw new Error('adapter_build_too_large');
      const previousDigest=digest(previous),nextDigest=digest(next);
      await save({version:1,installationId,ticket:randomBytes(32).toString('hex'),previous:previousDigest,next:nextDigest,previousCode:previous.toString('base64'),nextCode:next.toString('base64'),phase:'prepared',target:nextDigest});
      return {...record!};
    });},
    transition(phase:Exclude<UpdatePhase,'prepared'>,target:string,epoch?:string){return serial(async()=>{
      if(!record||record.phase==='committed')throw new Error('adapter_update_transition_invalid');
      if(target!==record.previous&&target!==record.next)throw new Error('adapter_build_unknown');
      const permitted=phase==='publishing'||
        phase==='published'&&record.phase==='publishing'&&record.target===target||
        phase==='verified'&&record.phase==='published'&&record.target===target&&typeof epoch==='string'&&epoch.length>0&&epoch.length<=256||
        phase==='committed'&&record.phase==='verified'&&record.target===target;
      if(!permitted)throw new Error('adapter_update_transition_invalid');
      const next={...record,phase,target};delete next.epoch;
      if(phase==='verified')next.epoch=epoch!;
      if(phase==='committed')next.epoch=record.epoch!;
      await save(next);
    });},
    async close(){closing=true;await tail;await lease.release();},
  };
}

async function readJournal(filename:string):Promise<UpdateJournal|undefined>{
  let stat;try{stat=await fs.lstat(filename);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>cap)throw new Error('adapter_update_journal_invalid');
  const handle=await fs.open(filename,'r');
  try{
    const before=await handle.stat();if(before.dev!==stat.dev||before.ino!==stat.ino||before.size>cap)throw new Error('adapter_update_journal_changed');
    const bytes=Buffer.alloc(before.size+1);let total=0;
    while(total<bytes.length){const {bytesRead}=await handle.read(bytes,total,bytes.length-total,null);if(!bytesRead)break;total+=bytesRead;}
    const after=await handle.stat();
    if(total!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new Error('adapter_update_journal_changed');
    let record;try{record=JSON.parse(bytes.subarray(0,total).toString('utf8'));}catch{throw new Error('adapter_update_journal_invalid');}
    validate(record);return record;
  }finally{await handle.close();}
}
function validate(record:UpdateJournal):void{
  const invalid=()=>{throw new Error('adapter_update_journal_invalid');};
  if(!record||typeof record!=='object'||Array.isArray(record)||record.version!==1||typeof record.installationId!=='string'||!/^[a-f0-9-]{36}$/.test(record.installationId)||!sha.test(record.ticket)||!sha.test(record.previous)||!sha.test(record.next)||!['prepared','publishing','published','verified','committed'].includes(record.phase)||(record.target!==record.previous&&record.target!==record.next))invalid();
  if(Object.keys(record).some(key=>!['version','installationId','ticket','previous','next','previousCode','nextCode','phase','target','epoch'].includes(key)))invalid();
  for(const [code,expected] of [[record.previousCode,record.previous],[record.nextCode,record.next]]){
    if(typeof code!=='string'||code.length>1398104)invalid();
    const bytes=Buffer.from(code!,'base64');
    if(bytes.length>1024*1024||bytes.toString('base64')!==code||digest(bytes)!==expected)invalid();
  }
  if(['verified','committed'].includes(record.phase)){
    if(typeof record.epoch!=='string'||!record.epoch||record.epoch.length>256)invalid();
  }else if(record.epoch!==undefined)invalid();
}
