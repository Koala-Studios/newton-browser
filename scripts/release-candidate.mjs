import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const MAX_FILE_BYTES=64*1024*1024;
const fail=code=>{throw new Error(`release_candidate_${code}`);};
const ordinal=(left,right)=>left<right?-1:left>right?1:0;
const unchanged=(left,right)=>left.dev===right.dev&&left.ino===right.ino&&left.mode===right.mode&&left.size===right.size&&left.mtimeMs===right.mtimeMs&&left.ctimeMs===right.ctimeMs&&left.nlink===right.nlink;

/** Hash intended tracked/untracked source bytes, never filesystem timestamps or
 * an inferred clean Git state. Run outputs have narrow, auditable exclusions. */
export function candidateDigest(root=process.cwd()){
  root=fs.realpathSync(root);
  if(!fs.lstatSync(root).isDirectory())fail('root_invalid');
  const listing=execFileSync('git',['ls-files','-co','--exclude-standard','-z'],{
    cwd:root,encoding:'buffer',windowsHide:true,timeout:30000,maxBuffer:16*1024*1024,
  });
  const paths=[...new Set(listing.toString('utf8').split('\0').filter(Boolean))].sort(ordinal);
  const hash=createHash('sha256'),excluded=[];
  let files=0;
  for(const relative of paths){
    const parts=relative.split('/');
    if(relative.includes('\\')||relative.includes('\0')||path.posix.isAbsolute(relative)||path.win32.isAbsolute(relative)||parts.some(part=>!part||part==='.'||part==='..'))fail('path_invalid');
    if(isRunOutput(parts)){excluded.push(relative);continue;}
    const absolute=path.resolve(root,...parts),back=path.relative(root,absolute);
    if(!back||back==='..'||back.startsWith('..'+path.sep)||path.isAbsolute(back))fail('path_escape');
    assertParents(root,parts);
    let before;
    try{before=fs.lstatSync(absolute);}catch(error){
      if(error.code!=='ENOENT')throw error;
      hash.update(relative+'\0deleted\0');files++;continue;
    }
    if(before.isSymbolicLink()){
      const target=fs.readlinkSync(absolute),bytes=Buffer.from(target,'utf8');
      if(!unchanged(before,fs.lstatSync(absolute)))fail('file_changed');
      hash.update(relative+'\0symlink\0'+bytes.length+'\0');hash.update(bytes);hash.update('\0');
    }else{
      if(!before.isFile()||before.nlink!==1)fail('file_invalid');
      if(before.size>MAX_FILE_BYTES)fail('file_too_large');
      const fd=fs.openSync(absolute,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
      try{
        if(!unchanged(before,fs.fstatSync(fd)))fail('file_changed');
        hash.update(relative+'\0file\0'+before.size+'\0');
        const buffer=Buffer.alloc(1024*1024);let size=0;
        for(;;){
          const count=fs.readSync(fd,buffer,0,buffer.length,null);if(!count)break;
          size+=count;if(size>MAX_FILE_BYTES||size>before.size)fail('file_changed');
          hash.update(buffer.subarray(0,count));
        }
        if(size!==before.size||!unchanged(before,fs.fstatSync(fd))||!unchanged(before,fs.lstatSync(absolute)))fail('file_changed');
        hash.update('\0');
      }finally{fs.closeSync(fd);}
    }
    assertParents(root,parts);files++;
  }
  return Object.freeze({sha256:hash.digest('hex'),files,excluded:Object.freeze(excluded)});
}

function isRunOutput(parts){
  if(['artifacts','coverage','node_modules','dist'].includes(parts[0])&&parts.length>1)return true;
  if(parts[0]==='test'&&parts[1]==='evidence'&&parts[2]==='runs'&&parts.length>3)return true;
  return ['apps','packages'].includes(parts[0])&&parts.length>3&&['node_modules','dist'].includes(parts[2]);
}

function assertParents(root,parts){
  let current=root;
  for(const part of parts.slice(0,-1)){
    current=path.join(current,part);
    let stat;try{stat=fs.lstatSync(current);}catch(error){if(error.code==='ENOENT')return;throw error;}
    if(!stat.isDirectory()||stat.isSymbolicLink())fail('parent_invalid');
  }
}
