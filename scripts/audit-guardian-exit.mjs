// Synthetic process-tree reproduction. Never launches or targets user browsers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const self = fileURLToPath(import.meta.url);
if (process.argv[2] === '--leaf-fixture') {
  process.stdout.write('ready\n'); setTimeout(()=>process.exit(0),15000);
} else if (process.argv[2] === '--browser-fixture') {
  const leaf = spawn(process.execPath,[self,'--leaf-fixture'],{stdio:['ignore','pipe','ignore'],windowsHide:true});
  leaf.stdout.once('data',()=>{fs.writeFileSync(process.argv[3],String(leaf.pid));process.exit(0);});
} else {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'newton-guardian-audit-'));
  const storeRoot=path.join(root,'store'); fs.mkdirSync(storeRoot);
  const identityId=`nbi_${randomBytes(16).toString('hex')}`;
  const identityPath=path.join(storeRoot,identityId); fs.mkdirSync(identityPath);
  const identity=fs.lstatSync(identityPath,{bigint:true});
  const nonce=randomBytes(32).toString('hex'); const createdAt=new Date().toISOString();
  fs.writeFileSync(path.join(identityPath,'.newton-browser-profile-identity'),JSON.stringify({nonce,storeNonce:nonce,identity:identityId,dev:String(identity.dev),ino:String(identity.ino)}));
  const leasePath=path.join(identityPath,'.newton-browser-profile-lease');
  fs.writeFileSync(leasePath,JSON.stringify({nonce,pid:process.pid,createdAt,id:identityId}));
  const lease=fs.lstatSync(leasePath,{bigint:true});
  const pidFile=path.join(root,'synthetic-leaf-pid');
  const guardian=spawn(process.execPath,[path.resolve('apps/mcp-server/src/browser-runtime/browser-guardian.ts')],{stdio:['ignore','ignore','pipe','pipe','pipe','ipc'],windowsHide:true});
  let leafPid; let receipt;
  try {
    const ended=once(guardian,'exit');
    guardian.send({type:'launch',executablePath:process.execPath,args:[self,'--browser-fixture',pidFile],cleanup:{
      storeRoot,identityPath,identityId,identityDev:String(identity.dev),identityIno:String(identity.ino),identityMarkerNonce:nonce,storeNonce:nonce,
      leasePath,leaseDev:String(lease.dev),leaseIno:String(lease.ino),leaseNonce:nonce,leasePid:process.pid,leaseCreatedAt:createdAt,removeIdentity:true,
    }});
    await ended;
    leafPid=Number(fs.readFileSync(pidFile,'utf8')); assert.ok(Number.isSafeInteger(leafPid)&&leafPid>0);
    const descendantAlive=exists(leafPid);
    receipt={date:'2026-09-07',platform:process.platform,node:process.version,fixture:'synthetic Node root exits while its non-detached child remains',guardianExited:true,descendantAlive,identityRemoved:!fs.existsSync(identityPath),defectObserved:descendantAlive&&!fs.existsSync(identityPath)};
  } finally {
    if (leafPid&&exists(leafPid)) process.kill(leafPid,'SIGKILL');
    if (guardian.exitCode===null&&guardian.signalCode===null) guardian.kill('SIGKILL');
    const resolved=fs.realpathSync(root);
    assert.ok(path.basename(resolved).startsWith('newton-guardian-audit-'));
    assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());
    fs.rmSync(resolved,{recursive:true,force:true});
  }
  receipt.cleanupConfirmed=!fs.existsSync(root)&&!exists(leafPid);
  fs.writeFileSync('test/evidence/audit-guardian-exit-2026-09-07.json',JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify(receipt));
  if(process.argv.includes('--assert-correct')&&receipt.defectObserved)process.exitCode=1;
}
function exists(pid){try{process.kill(pid,0);return true;}catch{return false;}}
