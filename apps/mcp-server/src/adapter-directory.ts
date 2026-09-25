import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';

type Installation={version:1;installationId:string;extensionId:string;files:Record<string,string>};
const names=['manifest.json','worker.js','setup.html'] as const;
const hash=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
async function checkedFile(root:string,name:string,cap:number):Promise<Buffer>{
  const filename=path.join(root,name),stat=await fs.lstat(filename);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>cap)throw new Error('adapter_file_invalid');
  return fs.readFile(filename);
}
async function checkedRoot(root:string):Promise<string>{
  const resolved=path.resolve(root),stat=await fs.lstat(resolved);
  if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(resolved)!==resolved)throw new Error('adapter_path_invalid');
  return resolved;
}
export async function readAdapterDirectory(directory:string):Promise<Installation&{directory:string}>{
  return readVerifiedDirectory(directory);
}
/** Recovery may encounter either journaled worker version on disk or in metadata.
 * All other installed files and the installation identity must still verify. */
export async function readAdapterUpdateDirectory(directory:string,update:{installationId:string;previous:string;next:string}):Promise<Installation&{directory:string}>{
  return readVerifiedDirectory(directory,update);
}
async function readVerifiedDirectory(directory:string,update?:{installationId:string;previous:string;next:string}):Promise<Installation&{directory:string}>{
  const root=await checkedRoot(directory);
  let record:Installation;
  try{record=JSON.parse((await checkedFile(root,'installation.json',4096)).toString('utf8'));}catch{throw new Error('adapter_installation_invalid');}
  if(!record||typeof record!=='object'||Array.isArray(record)||record.version!==1||typeof record.installationId!=='string'||!/^[a-f0-9-]{36}$/.test(record.installationId)||typeof record.extensionId!=='string'||!/^[a-p]{32}$/.test(record.extensionId)||!record.files||typeof record.files!=='object'||Array.isArray(record.files)||Object.keys(record.files).sort().join()!==[...names].sort().join())throw new Error('adapter_installation_invalid');
  if(update&&record.installationId!==update.installationId)throw new Error('adapter_installation_changed');
  for(const name of names){
    const actual=hash(await checkedFile(root,name,1024*1024));
    if(!/^[a-f0-9]{64}$/.test(record.files[name]??''))throw new Error('adapter_installation_changed');
    if(name==='worker.js'&&update){
      if(![update.previous,update.next].includes(actual)||![update.previous,update.next].includes(record.files[name]!))throw new Error('adapter_installation_changed');
    }else if(actual!==record.files[name])throw new Error('adapter_installation_changed');
  }
  const manifest=JSON.parse((await checkedFile(root,'manifest.json',16384)).toString('utf8'));
  if(typeof manifest.key!=='string'||extensionId(manifest.key)!==record.extensionId)throw new Error('adapter_installation_changed');
  return {...record,directory:root};
}

/** Caller retains installation ownership and journals bootstrap/smoke verification
 * before committing metadata. Repeating after a process crash is idempotent. */
export async function commitAdapterWorker(directory:string,update:{installationId:string;previous:string;next:string},target:string,assertOwned:()=>Promise<void>):Promise<void>{
  await assertOwned();
  const installed=await readAdapterUpdateDirectory(directory,update);
  if(![update.previous,update.next].includes(target)||hash(await checkedFile(installed.directory,'worker.js',1024*1024))!==target)throw new Error('adapter_installation_changed');
  if(installed.files['worker.js']===target)return;
  const record:Installation={version:1,installationId:installed.installationId,extensionId:installed.extensionId,files:{...installed.files,'worker.js':target}};
  const stage=path.join(installed.directory,`installation-${randomUUID()}.stage`);
  const handle=await fs.open(stage,'wx',0o600);
  try{
    try{await handle.writeFile(JSON.stringify(record)+'\n');await handle.sync();}finally{await handle.close();}
    await assertOwned();await fs.rename(stage,path.join(installed.directory,'installation.json'));
  }finally{await fs.unlink(stage).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  await readAdapterDirectory(directory);
}

/** Copy packaged bytes once; ordinary setup never silently updates installed code. */
export async function prepareAdapterDirectory(directory:string,artifacts:string):Promise<Installation&{directory:string}>{
  const root=path.resolve(directory);
  let exists=true;try{await fs.lstat(root);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')exists=false;else throw error;}
  if(exists)return readAdapterDirectory(root);
  const source=await checkedRoot(artifacts);
  const buffers=await Promise.all(names.map(name=>checkedFile(source,name,name==='worker.js'?1024*1024:16384)));
  const manifest=JSON.parse(buffers[0]!.toString('utf8'));
  if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)||Object.keys(manifest).some(name=>!['manifest_version','name','version','permissions','background'].includes(name))||manifest.manifest_version!==3||manifest.background?.service_worker!=='worker.js'||manifest.background.type!=='module'||Object.keys(manifest.background).sort().join()!=='service_worker,type'||JSON.stringify(manifest.permissions)!==JSON.stringify(['debugger','tabs','nativeMessaging','webNavigation']))throw new Error('adapter_artifact_invalid');
  const {publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  manifest.key=publicKey.export({type:'spki',format:'der'}).toString('base64');
  buffers[0]=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  const parent=path.dirname(root);await fs.mkdir(parent,{recursive:true,mode:0o700});await checkedRoot(parent);
  const stage=await fs.mkdtemp(path.join(parent,'.newton-adapter-stage-'));
  const stageIdentity=await fs.lstat(stage);
  const record:Installation={version:1,installationId:randomUUID(),extensionId:extensionId(manifest.key),files:Object.fromEntries(names.map((name,index)=>[name,hash(buffers[index]!)]))};
  try{
    for(let i=0;i<names.length;i++)await fs.writeFile(path.join(stage,names[i]!),buffers[i]!,{flag:'wx',mode:0o600});
    await fs.writeFile(path.join(stage,'installation.json'),JSON.stringify(record)+'\n',{flag:'wx',mode:0o600});
    try{await fs.rename(stage,root);}catch(error){
      if(!['EEXIST','ENOTEMPTY','EPERM'].includes((error as NodeJS.ErrnoException).code??''))throw error;
      return await readAdapterDirectory(root);
    }
    return {...record,directory:root};
  }finally{
    // Only this function's unpublished exact staging files can be removed.
    const current=await fs.lstat(stage).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
    if(current){
      if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==stageIdentity.dev||current.ino!==stageIdentity.ino)throw new Error('adapter_stage_changed');
      for(const name of [...names,'installation.json'])await fs.unlink(path.join(stage,name)).catch(error=>{if(error.code!=='ENOENT')throw error;});
      await fs.rmdir(stage);
    }
  }
}
function extensionId(key:string):string{
  return [...createHash('sha256').update(Buffer.from(key,'base64')).digest().subarray(0,16)].map(byte=>String.fromCharCode(97+(byte>>4),97+(byte&15))).join('');
}
