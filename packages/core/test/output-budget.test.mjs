import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeEngineResult,encodeEngineReceipt,readObservationBudget,receiptObservationBudget } from '../src/receipt-encoding.ts';

const observation={state:'available',trust:'untrusted_page_content',scope:'page',nodes:[{ref:'e1',role:'textbox',name:'文😀 "quoted" \\ line\n'.repeat(5),value:'ordinary',readonly:false,disabled:false}]};
const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
test('reader budgeting and final serialization agree at the exact escaped UTF8 boundary',()=>{
  const envelope={nextCommandId:Number.MAX_SAFE_INTEGER};
  const exact=bytes(encodeEngineResult({...envelope,observation}));
  assert.equal(readObservationBudget(exact).fits(observation),true);
  assert.equal(readObservationBudget(exact-1).fits(observation),false);
  assert.doesNotThrow(()=>encodeEngineResult({...envelope,observation},exact));
  assert.throws(()=>encodeEngineResult({...envelope,observation},exact-1),/output_budget/);
});
test('action reads use their actual receipt envelope, including step facts',()=>{
  const envelope={sessionId:'s1',commandId:1,state:'finished',reason:'completed',dispatch:'acknowledged',postcondition:{state:'met',kind:'value'},nextCommandId:2,page:{pageId:'p1',frameId:'f1',documentGeneration:1},steps:[{index:0,dispatch:'acknowledged',postcondition:{state:'met',kind:'value'}}]};
  const exact=bytes(encodeEngineResult({...envelope,observation}));
  assert.equal(receiptObservationBudget(exact,envelope).fits(observation),true);
  assert.equal(receiptObservationBudget(exact-1,envelope).fits(observation),false);
  assert.deepEqual(JSON.parse(encodeEngineReceipt({...envelope,observation},exact).content[0].text).observation,observation);
});
test('image budgets count image content and its metadata exactly once',()=>{
  const shot={...observation,nodes:[],imageData:'YWJj',mimeType:'image/png'};
  const result=encodeEngineResult({nextCommandId:Number.MAX_SAFE_INTEGER,observation:shot});
  assert.equal(result.content[0].type,'image');assert.equal(result.content[0].data,'YWJj');
  assert.equal(JSON.parse(result.content[1].text).observation.imageData,undefined);
  assert.equal(readObservationBudget(bytes(result)).fits(shot),true);
  assert.equal(readObservationBudget(bytes(result)-1).fits(shot),false);
});
