import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {deadline} from './support.mjs';

// Registry entry is unique to this disposable run, checked absent before create,
// and removed only after confirming it still points to this run's manifest.
export function prepareNativeProbe(root,extensionId) {
  assert.equal(process.platform,'win32');
  const nonce=randomUUID().replaceAll('-','');
  const hostName=`local.newton.prototype.${nonce}`;
  const pipeName=`newton-prototype-${nonce}`;
  const key=`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`;
  const project=path.join(root,'native-source');
  fs.cpSync(path.resolve('scripts/prototypes/native-host'),project,{recursive:true});
  const output=path.join(root,'native-bin');
  execFileSync('dotnet',['build',path.join(project,'NativeHost.csproj'),'-c','Release','-o',output,'--nologo'],{stdio:'pipe',windowsHide:true,timeout:60000});
  const origin=`chrome-extension://${extensionId}/`;
  fs.writeFileSync(path.join(output,'bridge.json'),JSON.stringify({pipe:pipeName,origin}));
  const manifestPath=path.join(root,'native-manifest.json');
  fs.writeFileSync(manifestPath,JSON.stringify({name:hostName,description:'Disposable local connection probe',path:path.join(output,'NativeHost.exe'),type:'stdio',allowed_origins:[origin]}));
  let existed=false;
  try {execFileSync('reg.exe',['query',key],{stdio:'pipe',windowsHide:true});existed=true;}catch{}
  assert.equal(existed,false,'native registry key collision');
  execFileSync('reg.exe',['add',key,'/ve','/t','REG_SZ','/d',manifestPath],{stdio:'pipe',windowsHide:true});
  let socket, resolveConnection, nextId=0;
  const connected=new Promise(resolve=>{resolveConnection=resolve;});
  const pending=new Map();
  const server=net.createServer(client=>{
    if(socket){client.destroy();return;}socket=client;
    let buffer=Buffer.alloc(0);
    client.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      while(buffer.length>=4) {
        const length=buffer.readUInt32LE(0);
        if(length>1024*1024){client.destroy(new Error('probe_frame_too_large'));return;}
        if(buffer.length<length+4)return;
        const message=JSON.parse(buffer.subarray(4,length+4).toString('utf8'));
        buffer=buffer.subarray(length+4);
        const entry=pending.get(message.id);if(entry){pending.delete(message.id);entry.resolve(message);}
      }
    });
    const rejectPending=()=>{for(const entry of pending.values())entry.reject(new Error('native_disconnected'));pending.clear();};
    client.on('error',rejectPending);client.on('close',rejectPending);
    resolveConnection();
  });
  const listening=new Promise((resolve,reject)=>{server.once('error',reject);server.listen(`\\\\.\\pipe\\${pipeName}`,resolve);});
  return {hostName,listening,
    async call(message) {
      await deadline(connected,'native_connect');
      const id=++nextId;
      const payload=Buffer.from(JSON.stringify({id,...message}));assert.ok(payload.length<1024*1024);
      const frame=Buffer.alloc(4+payload.length);frame.writeUInt32LE(payload.length);payload.copy(frame,4);
      let resolve,reject;const response=new Promise((yes,no)=>{resolve=yes;reject=no;});pending.set(id,{resolve,reject});
      socket.write(frame);
      try{return await deadline(response,'native_reply');}finally{pending.delete(id);}
    },
    async close() {
      socket?.destroy();await new Promise(resolve=>server.close(resolve));
      const current=execFileSync('reg.exe',['query',key,'/ve'],{encoding:'utf8',windowsHide:true});
      assert.ok(current.includes(manifestPath),'native registration ownership changed');
      execFileSync('reg.exe',['delete',key,'/f'],{stdio:'pipe',windowsHide:true});
    },
  };
}
