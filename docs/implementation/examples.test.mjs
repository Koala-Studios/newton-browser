import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExampleBudget, ExampleDispatchLedger, exampleInput,
  classifyCommandId, normalizeStartUrl, packExampleRows,
} from './examples.ts';

test('deadline before input prevents dispatch', async()=>{
  let now=0;const budget=new ExampleBudget(()=>now,10,new AbortController().signal);
  const ledger=new ExampleDispatchLedger();let sends=0;now=10;
  await assert.rejects(exampleInput(budget,ledger,async()=>{sends++;}),/timed_out/);
  assert.equal(sends,0);assert.equal(ledger.summary(),'not_started');
});

test('deadline after acknowledgement preserves input and prevents next primitive',async()=>{
  let now=0;const budget=new ExampleBudget(()=>now,10,new AbortController().signal);
  const ledger=new ExampleDispatchLedger();let sends=0;
  await assert.rejects(exampleInput(budget,ledger,async()=>{sends++;now=10;}),/timed_out/);
  assert.equal(ledger.summary(),'acknowledged');
  await assert.rejects(exampleInput(budget,ledger,async()=>{sends++;}),/timed_out/);
  assert.equal(sends,1);
});

test('lost acknowledgement stays uncertain after a prior acknowledged preparation',async()=>{
  const budget=new ExampleBudget(()=>0,10,new AbortController().signal);
  const ledger=new ExampleDispatchLedger();
  await exampleInput(budget,ledger,async()=>{});
  await assert.rejects(exampleInput(budget,ledger,async()=>{throw new Error('lost_reply');}),/lost_reply/);
  assert.equal(ledger.summary(),'attempted');
});

test('cancellation stops later input without erasing acknowledged preparation',async()=>{
  const abort=new AbortController();const budget=new ExampleBudget(()=>0,10,abort.signal);
  const ledger=new ExampleDispatchLedger();
  await assert.rejects(exampleInput(budget,ledger,async()=>{abort.abort();}),/cancelled/);
  assert.equal(ledger.summary(),'acknowledged');
});

test('command admission distinguishes evicted mutation from new work',()=>{
  const common={highWater:3,incomingHash:'a'};
  assert.equal(classifyCommandId({...common,id:1}),'expired');
  assert.equal(classifyCommandId({...common,id:3,retainedHash:'a'}),'join');
  assert.equal(classifyCommandId({...common,id:3,retainedHash:'b'}),'conflict');
  assert.equal(classifyCommandId({...common,id:4}),'new');
  assert.equal(classifyCommandId({...common,id:5}),'gap');
  assert.throws(()=>classifyCommandId({...common,id:0}),/invalid_command_id/);
});

test('URL normalization preserves the actual destination and rejects credentials',()=>{
  assert.equal(normalizeStartUrl('https://example.com/a/b?q=x#section'),'https://example.com/a/b?q=x#section');
  assert.throws(()=>normalizeStartUrl('file:///tmp/a'),/invalid_url/);
  assert.throws(()=>normalizeStartUrl('https://name:secret@example.com/'),/invalid_url/);
});

test('UTF-8 output cap retains required facts and marks omitted rows incomplete',()=>{
  const base={commandId:1,dispatch:'acknowledged',scope:'page'};
  const rows=[{ref:'e1',label:'😀 "quoted"'},{ref:'e2',label:'漢字'.repeat(30)}];
  const limit=Buffer.byteLength(JSON.stringify({...base,complete:false,rows:rows.slice(0,1)}));
  const result=packExampleRows(base,rows,true,limit);
  const parsed=JSON.parse(result);
  assert.ok(Buffer.byteLength(result)<=limit);
  assert.equal(parsed.dispatch,'acknowledged');assert.equal(parsed.complete,false);
  assert.deepEqual(parsed.rows,rows.slice(0,1));
  const smaller=JSON.parse(packExampleRows(base,rows,true,limit-1));
  assert.equal(smaller.rows.length,0);assert.equal(smaller.complete,false);
  assert.equal(JSON.parse(packExampleRows(base,rows,false,10000)).complete,false);
  assert.equal(JSON.parse(packExampleRows(base,rows,true,10000)).complete,true);
  assert.throws(()=>packExampleRows(base,rows,true,1),/mandatory_envelope_does_not_fit/);
});
