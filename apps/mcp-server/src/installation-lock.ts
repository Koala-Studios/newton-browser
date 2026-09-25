import net from 'node:net';
import fs from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

/** Darwin open(2) flag for an flock-style exclusive lock taken atomically with
 * the open. Node does not export it, but passes numeric flags through. */
const O_EXLOCK=0x20;

/** Kernel-owned private IPC name reservation. No messages, TCP port, daemon, or
 * stale lock file; process exit releases ownership on Windows and Linux. */
export async function acquireInstallationLock(directory:string):Promise<{directory:string;signal:AbortSignal;release():Promise<void>}>{
  if(!['win32','linux','darwin'].includes(process.platform))throw new Error('installation_lock_unsupported');
  const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('adapter_path_invalid');
  const canonical=await fs.realpath(directory);
  const key=createHash('sha256').update(process.platform==='win32'?canonical.toLowerCase():canonical).digest('hex');
  if(process.platform==='darwin')return acquireDarwinLock(canonical,key);
  const endpoint=process.platform==='win32'?`\\\\.\\pipe\\newton-browser-installation-${key}`:`\0newton-browser-installation-${key}`;
  const controller=new AbortController();let releasing=false,releasePromise:Promise<void>|undefined;
  const server=net.createServer(socket=>socket.destroy());
  server.on('error',()=>{controller.abort(new Error('installation_lock_lost'));server.close();});
  server.on('close',()=>{if(!releasing)controller.abort(new Error('installation_lock_lost'));});
  await new Promise<void>((resolve,reject)=>{
    const failed=(error:NodeJS.ErrnoException)=>{server.off('listening',ready);reject(new Error(['EADDRINUSE','EACCES','EPERM'].includes(error.code??'')?'installation_busy':'installation_lock_failed'));};
    const ready=()=>{server.off('error',failed);resolve();};
    server.once('error',failed);server.once('listening',ready);server.listen({path:endpoint,exclusive:true});
  });
  return {directory:canonical,signal:controller.signal,release(){
    return releasePromise??=new Promise<void>(resolve=>{releasing=true;controller.abort(new Error('installation_lock_released'));server.close(()=>resolve());});
  }};
}

/** macOS has no abstract socket namespace. The per-user 0700 temporary
 * directory holds an empty lock file; the kernel releases the flock when the
 * descriptor closes, including on crash, so the file itself is never stale state. */
async function acquireDarwinLock(canonical:string,key:string):Promise<{directory:string;signal:AbortSignal;release():Promise<void>}>{
  const root=await fs.realpath(os.tmpdir());const rootStat=await fs.lstat(root);
  if(!rootStat.isDirectory()||rootStat.uid!==process.getuid?.()||(rootStat.mode&0o077)!==0)throw new Error('installation_lock_failed');
  const file=path.join(root,`newton-browser-installation-${key}.lock`);
  let handle:fs.FileHandle;
  try{handle=await fs.open(file,fsConstants.O_RDWR|fsConstants.O_CREAT|fsConstants.O_NOFOLLOW|fsConstants.O_NONBLOCK|O_EXLOCK,0o600);}
  catch(error){throw new Error(['EAGAIN','EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code??'')?'installation_busy':'installation_lock_failed');}
  const opened=await handle.stat();
  if(!opened.isFile()||opened.uid!==process.getuid?.()){await handle.close();throw new Error('installation_lock_failed');}
  const controller=new AbortController();let releasePromise:Promise<void>|undefined;
  return {directory:canonical,signal:controller.signal,release(){
    return releasePromise??=(async()=>{controller.abort(new Error('installation_lock_released'));await handle.close();})();
  }};
}
