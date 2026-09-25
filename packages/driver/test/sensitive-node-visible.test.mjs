import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {SENSITIVE_NODE_VISIBLE_FUNCTION} from '../src/native-sensitive-regions.ts';
const element=(attributes={})=>({nodeType:1,getAttribute:name=>attributes[name]??'',getBoundingClientRect:()=>({width:3,height:4}),get value(){throw Error('field value read');},get textContent(){throw Error('text read');}});
const visible=(node,style={display:'block',visibility:'visible'})=>vm.runInNewContext(`(${SENSITIVE_NODE_VISIBLE_FUNCTION})`,{getComputedStyle:()=>style}).call(node);
test('sensitive node predicate reads only type/autocomplete and geometry, never values or text',()=>{
  for(const attributes of [{type:'PASSWORD'},{autocomplete:'section-payment cc-number'},{autocomplete:'one-time-code'},{autocomplete:'new-password'},{autocomplete:'webauthn'}])assert.equal(visible(element(attributes)),true);
  assert.equal(visible(element({type:'text'})),false);
  assert.equal(visible({nodeType:3,get textContent(){throw Error('text read');}}),false);
});
test('hidden and nonrendered sensitive nodes need no visible mask',()=>{
  assert.equal(visible(element({type:'password'}),{display:'none',visibility:'visible'}),false);
  assert.equal(visible(element({type:'password'}),{display:'block',visibility:'hidden'}),false);
  const empty=element({type:'password'});empty.getBoundingClientRect=()=>({width:0,height:0});assert.equal(visible(empty),false);
});
