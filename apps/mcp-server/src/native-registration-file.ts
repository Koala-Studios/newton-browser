import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

type Manifest={name:string;description:string;path:string;type:'stdio';allowed_origins:string[]};
const invalid=()=>new Error('native_registration_changed');

const filePlatform=()=>process.platform==='linux'||process.platform==='darwin';

/** User-local manifest registration (Linux and macOS). The caller holds the installation lock. No
 * system registration, browser profile inspection or registration side effects
 * occur at import time. Existing unrelated registrations are never overwritten. */
export async function publishNativeRegistrationFile(root:string,destination:string):Promise<void>{
  if(!filePlatform())throw new Error('native_install_arguments');
  root=await ownedDirectory(root);
  const source=await readManifest(path.join(root,'manifest.json'));
  validateManifest(source.manifest,root);
  if(path.basename(destination)!==source.manifest.name+'.json')throw invalid();
  const parent=await ensureRegistrationDirectory(path.dirname(destination));
  destination=path.join(parent,path.basename(destination));
  const existing=await optionalManifest(destination);
  if(existing){validateManifest(existing.manifest,root);if(existing.manifest.name!==source.manifest.name)throw invalid();if(existing.text===source.text)return;}
  const stage=path.join(parent,`.newton-${randomUUID()}.stage`);
  const file=await fs.open(stage,'wx',0o600);
  const identity=await file.stat();
  try{
    try{await file.writeFile(source.text);await file.sync();}finally{await file.close();}
    // Recheck ownership immediately before replacement. The OS-user-owned
    // directory and installation lock bound concurrent legitimate writers.
    const current=await optionalManifest(destination);
    if(current?.text!==existing?.text)throw invalid();
    await fs.rename(stage,destination);
    const directory=await fs.open(parent,'r');try{await directory.sync();}finally{await directory.close();}
  }finally{
    await ownedDirectory(parent);
    const current=await fs.lstat(stage).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
    if(current){if(!current.isFile()||current.isSymbolicLink()||current.ino!==identity.ino||current.dev!==identity.dev)throw invalid();await fs.unlink(stage);}
  }
}

export async function removeNativeRegistrationFile(root:string,destination:string):Promise<void>{
  if(!filePlatform())throw new Error('native_install_arguments');
  root=await ownedDirectory(root);
  const source=await readManifest(path.join(root,'manifest.json'));
  validateManifest(source.manifest,root);
  if(path.basename(destination)!==source.manifest.name+'.json')throw invalid();
  await ownedDirectory(path.dirname(destination));
  const current=await optionalManifest(destination);
  if(!current)return;
  validateManifest(current.manifest,root);
  // An installation update or another owner changing registration requires an
  // explicit new removal decision; never unlink merely because the name fits.
  if(current.text!==source.text)throw invalid();
  await fs.unlink(destination);
}

async function ownedDirectory(directory:string):Promise<string>{
  const absolute=path.resolve(directory),stat=await fs.lstat(absolute);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o022)!==0||await fs.realpath(absolute)!==absolute)throw invalid();
  return absolute;
}

async function ensureRegistrationDirectory(directory:string):Promise<string>{
  const absolute=path.resolve(directory);
  if(path.basename(absolute)!=='NativeMessagingHosts')throw invalid();
  // Browser config may already exist. Only create the browser and
  // NativeMessagingHosts components beneath an existing user directory.
  const browser=path.dirname(absolute);
  let base:string,created:string[];
  if(process.platform==='darwin'){
    // ~/Library/Application Support/Google/Chrome or ~/Library/Application Support/Microsoft Edge
    if(path.basename(browser)==='Chrome'&&path.basename(path.dirname(browser))==='Google'){base=path.dirname(path.dirname(browser));created=[path.dirname(browser),browser,absolute];}
    else if(path.basename(browser)==='Microsoft Edge'){base=path.dirname(browser);created=[browser,absolute];}
    else throw invalid();
    if(path.basename(base)!=='Application Support')throw invalid();
  }else{
    if(!['google-chrome','microsoft-edge'].includes(path.basename(browser)))throw invalid();
    base=path.dirname(browser);created=[browser,absolute];
  }
  await ownedDirectory(base);
  for(const item of created){
    await fs.mkdir(item,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    await ownedDirectory(item);
  }
  return absolute;
}

async function optionalManifest(filename:string){
  try{return await readManifest(filename);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
}

async function readManifest(filename:string):Promise<{manifest:Manifest;text:string}>{
  const before=await fs.lstat(filename);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.uid!==process.getuid?.()||(before.mode&0o022)!==0||before.size>16384)throw invalid();
  const file=await fs.open(filename,'r');
  try{
    const opened=await file.stat();
    if(opened.ino!==before.ino||opened.dev!==before.dev)throw invalid();
    const buffer=Buffer.alloc(16385);let size=0;
    while(size<buffer.length){const result=await file.read(buffer,size,buffer.length-size,null);if(!result.bytesRead)break;size+=result.bytesRead;}
    const after=await file.stat();
    if(size!==before.size||size>16384||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw invalid();
    const text=buffer.subarray(0,size).toString('utf8');
    let manifest:Manifest;try{manifest=JSON.parse(text) as Manifest;}catch{throw invalid();}
    return {manifest,text};
  }finally{await file.close();}
}

function validateManifest(manifest:Manifest,root:string):void{
  if(!manifest||typeof manifest!=='object'||typeof manifest.name!=='string'||!/^newton\.browser\.[a-p]{32}$/.test(manifest.name)||manifest.type!=='stdio'||typeof manifest.path!=='string'||!path.isAbsolute(manifest.path)||!Array.isArray(manifest.allowed_origins)||manifest.allowed_origins.length!==1||manifest.allowed_origins[0]!==`chrome-extension://${manifest.name.slice('newton.browser.'.length)}/`)throw invalid();
  const relative=path.relative(path.join(root,'launchers'),manifest.path);
  if(!/^[a-f0-9]{64}\/native-launcher$/.test(relative))throw invalid();
}
