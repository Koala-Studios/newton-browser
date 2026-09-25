import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {FRAME_SCOPE_FUNCTION} from '../src/document-reader.ts';

const element=(extra={})=>({tagName:'DIV',getAttribute:()=>'',...extra});
function predicate(){return vm.runInNewContext(`(${FRAME_SCOPE_FUNCTION})`,{getComputedStyle:node=>node.style??{display:'block',visibility:'visible'}});}
test('frame membership checks ancestors beyond scope and excludes document-reader subtrees',()=>{
  const check=predicate(),scope=element();
  for(const ancestor of [element({hidden:true}),element({tagName:'CANVAS'}),element({tagName:'TEXTAREA'}),element({getAttribute:name=>name==='autocomplete'?'one-time-code':''}),element({getAttribute:name=>name==='aria-hidden'?'true':''}),element({style:{display:'none'}}),element({style:{visibility:'collapse'}})]){
    scope.parentElement=ancestor;
    const owner=element({tagName:'IFRAME',parentElement:scope});
    assert.equal(check.call(scope,owner),false);
  }
  scope.parentElement=null;
  assert.equal(check.call(scope,element({tagName:'IFRAME',parentElement:scope})),true);
});
test('outside frames are rejected before style reads; excessive ancestry is uncertain',()=>{
  const owner=element();Object.defineProperty(owner,'style',{get(){throw Error('outside style read');}});
  assert.equal(predicate().call({contains:()=>false},owner),false);
  let deep=element();for(let i=0;i<128;i++)deep=element({parentElement:deep});
  assert.equal(predicate().call({contains:()=>true},deep),null);
});

test('ordinary document membership follows preferred main and hidden-main body fallback',()=>{
  const inside=element({tagName:'IFRAME'}),outside=element({tagName:'IFRAME'});
  const main=element({contains:owner=>owner===inside});
  const body=element({contains:owner=>owner===inside||owner===outside});
  const document={nodeType:9,querySelector:()=>main,body};
  inside.parentElement=main;main.parentElement=body;outside.parentElement=body;
  const check=predicate();
  assert.equal(check.call(document,inside,false),true);
  assert.equal(check.call(document,outside,false),false);
  main.hidden=true;
  assert.equal(check.call(document,outside,false),true);
});
