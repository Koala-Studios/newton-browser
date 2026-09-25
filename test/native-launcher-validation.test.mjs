import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {temporaryRoot} from '../scripts/prototypes/support.mjs';

const source=fs.readFileSync(new URL('../apps/mcp-server/src/native-launcher.cjs',import.meta.url),'utf8');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(){
  const temp=temporaryRoot('native-launcher'),entry=Buffer.from('inert host'),runtime=Buffer.from('inert runtime');
  const digest=hash(entry),build=path.join(temp.root,'builds',digest);fs.mkdirSync(build,{recursive:true});
  fs.writeFileSync(path.join(build,'native-host.js'),entry);fs.writeFileSync(path.join(build,'node.exe'),runtime);
  fs.writeFileSync(path.join(build,'build.json'),JSON.stringify({version:1,entryDigest:digest,runtimeDigest:hash(runtime)}));
  fs.writeFileSync(path.join(temp.root,'launcher.json'),JSON.stringify({digest}));
  const calls=[];
  const run=()=>vm.runInNewContext(source,{Buffer,process:{platform:'win32',execPath:path.join(temp.root,'launchers','fixture','native-launcher.exe'),env:{NODE_OPTIONS:'untrusted',NODE_PATH:'untrusted'}},
    require(name){if(name==='node:fs')return fs;if(name==='node:path')return path;if(name==='node:crypto')return crypto;if(name==='node:child_process')return {spawn(...args){calls.push(args);return new EventEmitter();}};throw Error('unexpected import');}});
  return {...temp,build,calls,run};
}
test('launcher verifies installed bytes and uses only its pinned runtime with clean Node environment',()=>{
  const f=fixture();try{f.run();assert.equal(f.calls.length,1);const [executable,args,options]=f.calls[0];
    assert.equal(executable,path.join(f.build,'node.exe'));assert.deepEqual([...args],[path.join(f.build,'native-host.js')]);
    assert.equal(options.env.NODE_OPTIONS,undefined);assert.equal(options.env.NODE_PATH,undefined);assert.equal(options.stdio,'inherit');
  }finally{f.remove();}
});
test('launcher refuses tampered runtime and oversized metadata before spawning',()=>{
  const f=fixture();try{
    fs.writeFileSync(path.join(f.build,'node.exe'),'tampered');assert.throws(f.run,/native_installation_changed/);assert.equal(f.calls.length,0);
    fs.writeFileSync(path.join(f.root,'launcher.json'),' '.repeat(4097));assert.throws(f.run,/native_installation_changed/);assert.equal(f.calls.length,0);
  }finally{f.remove();}
});
test('launcher rejects a symlinked build even when the target contains matching bytes',()=>{
  const f=fixture();try{
    const moved=path.join(f.root,'other-build');fs.renameSync(f.build,moved);fs.symlinkSync(moved,f.build,'junction');
    assert.throws(f.run,/native_installation_changed/);assert.equal(f.calls.length,0);
  }finally{f.remove();}
});

// D24: the pinned runtime is a real Node binary (100+ MB), not a stand-in.
test('launcher accepts a real Node runtime and still refuses one that changed',()=>{
  const f=fixture();try{
    const real=fs.readFileSync(process.execPath);assert.ok(real.length>4*1024*1024,'a real runtime is larger than the old cap');
    fs.writeFileSync(path.join(f.build,'node.exe'),real);
    const record=JSON.parse(fs.readFileSync(path.join(f.build,'build.json'),'utf8'));
    fs.writeFileSync(path.join(f.build,'build.json'),JSON.stringify({...record,runtimeDigest:hash(real)}));
    f.run();assert.equal(f.calls.length,1);
    const changed=Buffer.from(real);changed[changed.length-1]^=1;fs.writeFileSync(path.join(f.build,'node.exe'),changed);
    assert.throws(f.run,/native_installation_changed/);assert.equal(f.calls.length,1);
  }finally{f.remove();}
});

test('macOS host manifests go to Chrome and Edge Application Support, with a node runtime',async()=>{
  const {nativePlatformLayout}=await import('../apps/mcp-server/src/native-platform.ts');
  const chrome=nativePlatformLayout({platform:'darwin',browser:'chrome',hostName:'com.newton.browser',homeDirectory:'/Users/operator'});
  const edge=nativePlatformLayout({platform:'darwin',browser:'edge',hostName:'com.newton.browser',homeDirectory:'/Users/operator'});
  assert.equal(chrome.registration.path,'/Users/operator/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.newton.browser.json');
  assert.equal(edge.registration.path,'/Users/operator/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.newton.browser.json');
  assert.equal(chrome.runtimeName,'node');
  assert.throws(()=>nativePlatformLayout({platform:'darwin',browser:'chrome',hostName:'com.newton.browser',homeDirectory:'relative'}),/native_install_arguments/);
});
