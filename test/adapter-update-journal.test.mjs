import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {temporaryRoot} from '../scripts/prototypes/support.mjs';
import {openUpdateJournal} from '../apps/mcp-server/src/adapter-update-journal.ts';

test('interrupted publication retains exact rollback bytes and blocks a new update',async()=>{
  const temp=temporaryRoot('update-journal-interrupted');let journal;
  try{
    journal=await openUpdateJournal(temp.root);
    const record=await journal.begin(randomUUID(),Buffer.from('old code'),Buffer.from('new code'));
    await journal.transition('publishing',record.next);await journal.close();
    journal=await openUpdateJournal(temp.root);
    assert.equal(journal.read().phase,'publishing');assert.equal(journal.read().ticket,record.ticket);
    assert.equal(Buffer.from(journal.read().previousCode,'base64').toString(),'old code');
    await assert.rejects(journal.begin(randomUUID(),Buffer.from('third'),Buffer.from('fourth')),/recovery_required/);
    await journal.transition('publishing',record.previous);
    await journal.transition('published',record.previous);
    await journal.transition('verified',record.previous,'fresh-epoch');
    await journal.transition('committed',record.previous);await journal.close();
    journal=await openUpdateJournal(temp.root);assert.equal(journal.read().phase,'committed');
    assert.equal(journal.read().target,record.previous);assert.equal(journal.read().epoch,'fresh-epoch');
    await journal.begin(randomUUID(),Buffer.from('old code'),Buffer.from('third code'));
    assert.deepEqual((await fs.readdir(temp.root)).filter(name=>name!=='.prototype-owner'),['update.json']);
  }finally{await journal?.close();temp.remove();}
});

test('verification cannot skip publication or commit a different build',async()=>{
  const temp=temporaryRoot('update-journal-order');let journal;
  try{
    journal=await openUpdateJournal(temp.root);
    const record=await journal.begin(randomUUID(),Buffer.from('old'),Buffer.from('new'));
    await assert.rejects(journal.transition('committed',record.next),/transition_invalid/);
    await assert.rejects(journal.transition('verified',record.next,'epoch'),/transition_invalid/);
    await journal.transition('publishing',record.next);await journal.transition('published',record.next);
    await assert.rejects(journal.transition('verified',record.previous,'epoch'),/transition_invalid/);
    await assert.rejects(journal.transition('verified',record.next,''),/transition_invalid/);
    await journal.transition('verified',record.next,'epoch');
    await assert.rejects(journal.transition('committed',record.previous),/transition_invalid/);
    await journal.transition('committed',record.next);
  }finally{await journal?.close();temp.remove();}
});

test('close drains queued writes and refuses later writes while releasing ownership',async()=>{
  const temp=temporaryRoot('update-journal-close');let journal,other;
  try{
    journal=await openUpdateJournal(temp.root);
    const record=await journal.begin(randomUUID(),Buffer.from('old'),Buffer.from('new'));
    await assert.rejects(openUpdateJournal(temp.root),/installation_busy/);
    const publishing=journal.transition('publishing',record.next);
    const published=journal.transition('published',record.next);
    const closing=journal.close();
    await assert.rejects(journal.transition('verified',record.next,'epoch'),/installation_lock_released/);
    await Promise.all([publishing,published,closing]);
    other=await openUpdateJournal(temp.root);assert.equal(other.read().phase,'published');
  }finally{await journal?.close();await other?.close();temp.remove();}
});

test('corrupt snapshot bytes are rejected and a failed open releases the lock',async()=>{
  const temp=temporaryRoot('update-journal-corrupt');let journal;
  try{
    journal=await openUpdateJournal(temp.root);
    const record=await journal.begin(randomUUID(),Buffer.from('old'),Buffer.from('new'));await journal.close();
    await fs.writeFile(path.join(temp.root,'update.json'),JSON.stringify({...record,previousCode:Buffer.from('corrupt').toString('base64')}));
    await assert.rejects(openUpdateJournal(temp.root),/journal_invalid/);
    await fs.writeFile(path.join(temp.root,'update.json'),JSON.stringify(record));
    journal=await openUpdateJournal(temp.root);assert.equal(journal.read().ticket,record.ticket);
  }finally{await journal?.close();temp.remove();}
});
