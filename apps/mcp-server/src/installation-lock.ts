import net from 'node:net';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';

/** Kernel-owned private IPC name reservation. No messages, TCP port, daemon, or
 * stale lock file; process exit releases ownership on Windows and Linux. */
export async function acquireInstallationLock(directory:string):Promise<{directory:string;signal:AbortSignal;release():Promise<void>}>{
  if(!['win32','linux'].includes(process.platform))throw new Error('installation_lock_unsupported');
  const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('adapter_path_invalid');
  const canonical=await fs.realpath(directory);
  const key=createHash('sha256').update(process.platform==='win32'?canonical.toLowerCase():canonical).digest('hex');
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
