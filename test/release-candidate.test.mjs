import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {candidateDigest} from '../scripts/release-candidate.mjs';
import {temporaryRoot} from '../scripts/prototypes/support.mjs';

function fixture(t){
  const temporary=temporaryRoot('candidate-digest');
  t.after(()=>temporary.remove());
  const root=temporary.root;
  execFileSync('git',['init','--quiet'],{cwd:root,windowsHide:true});
  const write=(name,bytes)=>{
    const file=path.join(root,...name.split('/'));
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
    return file;
  };
  return {root,write,digest:()=>candidateDigest(root)};
}

test('candidate identity includes untracked application, package, docs and test source; ignores mtime',t=>{
  const {root,write,digest}=fixture(t);
  const names=['apps/mcp-server/src/main.ts','packages/driver/src/main.ts','docs/design.md','test/check.test.mjs','packages/driver/src/dist/source.ts'];
  for(const name of names)write(name,'first');
  const first=digest();
  for(const name of names)fs.utimesSync(path.join(root,name),new Date(0),new Date(1000));
  assert.equal(digest().sha256,first.sha256);
  for(const name of names){
    write(name,'other');assert.notEqual(digest().sha256,first.sha256,name);
    write(name,'first');assert.equal(digest().sha256,first.sha256,name);
  }
});

test('candidate output exclusions are exact and inspectable',t=>{
  const {write,digest}=fixture(t);
  write('apps/mcp-server/src/main.ts','source');
  const before=digest();
  const outputs=['artifacts/package.tgz','coverage/data.json','dist/out.js','node_modules/a.js','apps/mcp-server/dist/out.js','packages/driver/node_modules/a.js','test/evidence/runs/current/log.txt'];
  for(const name of outputs)write(name,'generated');
  const after=digest();
  assert.equal(after.sha256,before.sha256);
  assert.deepEqual(after.excluded,[...outputs].sort());
  write('test/evidence/accepted.md','evidence');
  assert.notEqual(digest().sha256,before.sha256);
});

test('tracked deletion is distinct from an empty file and duplicate Git inventory is deduplicated',t=>{
  const {root,write,digest}=fixture(t);
  const file=write('source.ts','');
  const untracked=digest();
  execFileSync('git',['add','source.ts'],{cwd:root,windowsHide:true});
  assert.deepEqual(digest(),untracked);
  fs.unlinkSync(file);
  const removed=digest();
  assert.notEqual(removed.sha256,untracked.sha256);
  assert.equal(removed.files,untracked.files);
});

test('candidate refuses hard links and oversized regular files',t=>{
  const {root,write,digest}=fixture(t);
  const source=write('source.ts','source');
  const link=path.join(root,'linked.ts');fs.linkSync(source,link);
  assert.throws(digest,/release_candidate_file_invalid/);
  fs.unlinkSync(link);
  const huge=write('oversized.ts','');fs.truncateSync(huge,64*1024*1024+1);
  assert.throws(digest,/release_candidate_file_too_large/);
});

test('candidate rejects directory junction traversal before reading target bytes',t=>{
  const {root,write,digest}=fixture(t);
  write('source/file.ts','tracked');
  execFileSync('git',['add','source/file.ts'],{cwd:root,windowsHide:true});
  fs.renameSync(path.join(root,'source'),path.join(root,'actual'));
  fs.symlinkSync(path.join(root,'actual'),path.join(root,'source'),process.platform==='win32'?'junction':'dir');
  assert.throws(digest,/release_candidate_parent_invalid/);
});
