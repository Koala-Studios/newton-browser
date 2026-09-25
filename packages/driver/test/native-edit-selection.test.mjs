import assert from 'node:assert/strict';
import test from 'node:test';
import {nativeSelectionCommands} from '../src/native-edit-selection.ts';
import {resolveTextEditRange} from '../src/text-edit-range.ts';
import {parseEngineCommand} from '../../core/src/command-contract.ts';

test('native selection chooses the closer edge and never splits a grapheme',()=>{
  assert.deepEqual(nativeSelectionCommands('a😀é-last',1,5),['moveToBeginningOfDocument','moveForward','moveForwardAndModifySelection','moveForwardAndModifySelection']);
  assert.deepEqual(nativeSelectionCommands('x'.repeat(50000)+'last',50000,50004),['moveToEndOfDocument',...Array(4).fill('moveBackwardAndModifySelection')]);
  assert.throws(()=>nativeSelectionCommands('é',0,1),{code:'unsupported_structure'});
  assert.throws(()=>nativeSelectionCommands('a😀b',1,2),{code:'unsupported_structure'});
  assert.throws(()=>nativeSelectionCommands('x'.repeat(10000),4999,5001),{code:'work_limit'});
});

test('edit matching requires deliberate disambiguation and preserves exact surrounding bytes',()=>{
  const text='same same same';
  assert.throws(()=>resolveTextEditRange(text,{match:'same',replacement:'new'}),{code:'ambiguous'});
  assert.deepEqual(resolveTextEditRange(text,{match:'same',replacement:'new',prefix:'same ',suffix:' same'}),{start:5,end:9,expected:'same new same'});
  assert.deepEqual(resolveTextEditRange(text,{match:'same',replacement:'',occurrence:3}),{start:10,end:14,expected:'same same '});
  assert.throws(()=>resolveTextEditRange('a😀b',{match:'\ud83d',replacement:'x'}),{code:'invalid_arguments'});
});

test('edit contract rejects unknown fields and malformed constraints before execution',()=>{
  const action={kind:'edit',target:{kind:'selector',selector:'#field'},match:'old',replacement:''};
  for(const extra of [{unknown:true},{value:'whole-field'},{occurrence:0},{occurrence:1.5},{prefix:3},{match:''},{replacement:null}]){
    assert.throws(()=>parseEngineCommand({commandId:1,action:{...action,...extra}}),{code:'invalid_arguments'});
  }
  assert.deepEqual(parseEngineCommand({commandId:1,action}).action,action);
});
