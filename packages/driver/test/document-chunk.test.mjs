import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { DOCUMENT_READ_FUNCTION, documentChunk, boundDocumentUtf8 } from '../src/document-reader.ts';

const page={pageId:'p1',frameId:'f1',documentGeneration:1};
test('document text preserves native and semantic heading hierarchy without inventing levels',()=>{
  const text=nodeValue=>({nodeType:3,nodeValue});
  const element=(tagName,value,attributes={})=>({nodeType:1,tagName,getAttribute:name=>attributes[name]??'',childNodes:[text(value)]});
  const root={nodeType:1,tagName:'MAIN',getAttribute:()=>'',childNodes:[element('H1','Guide'),element('H3','Nested section'),element('DIV','Semantic section',{role:'heading','aria-level':'2'}),element('DIV','Default level',{role:'heading'}),element('DIV','Invalid level',{role:'heading','aria-level':'999'}),element('P','Body text')]};
  const read=vm.runInNewContext(`(${DOCUMENT_READ_FUNCTION})`,{document:{querySelector:()=>root,body:root},location:{href:'https://example.test/'},getComputedStyle:()=>({display:'block',visibility:'visible',whiteSpace:'normal'}),URL});
  assert.equal(read(1000,100).text,'# Guide\n### Nested section\n## Semantic section\n## Default level\nInvalid level\nBody text');
  const bounded=read(2,100);assert.equal(bounded.text,'# ');assert.equal(bounded.truncated,true);
});
test('a parsing document is not returned as complete empty text',()=>{
  const doc={readyState:'loading',querySelector(){throw Error('partial DOM must not be cached');}};
  const read=vm.runInNewContext(`(${DOCUMENT_READ_FUNCTION})`,{document:doc});
  const result=read(1000,100);assert.equal(result.loading,true);assert.equal(result.truncated,true);assert.equal(result.text,'');
});
test('a hidden ancestor prevents scoped text access and unscoped main falls back to visible body',()=>{
  let childReads=0;
  const hidden={nodeType:1,tagName:'DIV',hidden:true,getAttribute:()=>'',childNodes:[]};
  const root={nodeType:1,tagName:'MAIN',parentElement:hidden,getAttribute:()=>'',get childNodes(){childReads++;throw new Error('hidden subtree read');}};
  hidden.childNodes=[root];
  const body={nodeType:1,tagName:'BODY',getAttribute:()=>'',childNodes:[hidden,{nodeType:3,nodeValue:'Visible fallback'}]};
  const doc={querySelector:()=>root,body,title:'Fixture'};root.ownerDocument=doc;
  const read=vm.runInNewContext(`(${DOCUMENT_READ_FUNCTION})`,{document:doc,location:{href:'https://example.test/'},getComputedStyle:()=>({display:'block',visibility:'visible',whiteSpace:'normal'}),URL});
  assert.equal(read.call(root,1000,100,true).text,'');assert.equal(read(1000,100).text,'Visible fallback');assert.equal(childReads,0);
});
test('excluded sensitive field subtrees are rejected before reading their children',()=>{
  let childReads=0;
  const field={nodeType:1,tagName:'TEXTAREA',getAttribute:()=>'',get childNodes(){childReads++;throw new Error('excluded field children accessed');}};
  const root={nodeType:1,tagName:'MAIN',getAttribute:()=>'',childNodes:[field]};
  const read=vm.runInNewContext(`(${DOCUMENT_READ_FUNCTION})`,{document:{querySelector:()=>root,body:root,title:'Fixture'},location:{href:'https://example.test/'},getComputedStyle:()=>({display:'block',visibility:'visible',whiteSpace:'normal'}),URL});
  assert.equal(read(1000,100).text,'');assert.equal(childReads,0);
});
test('HTML indentation does not consume document tokens while preformatted spacing survives',()=>{
  const element=(tagName,childNodes,extra={})=>({nodeType:1,tagName,childNodes,getAttribute:()=>'',...extra});
  const text=nodeValue=>({nodeType:3,nodeValue});
  const main=element('MAIN',[text('\n  '),element('P',[text('First paragraph. ')]),text('\n    '),element('P',[text('Second paragraph.')]),text('\n  '),element('PRE',[text('  code  \n    next')]),text('\n   ')]);
  const read=vm.runInNewContext(`(${DOCUMENT_READ_FUNCTION})`,{document:{querySelector:()=>main,body:main},location:{href:'https://example.test/'},getComputedStyle:()=>({display:'block',visibility:'visible',whiteSpace:'normal'}),URL});
  assert.equal(read(1000,100).text,'First paragraph.\nSecond paragraph.\n  code  \n    next');
});
test('a hidden preferred main itself falls back without reading its children',()=>{
  const main={nodeType:1,tagName:'MAIN',hidden:true,getAttribute:()=>'',get childNodes(){throw Error('hidden main read');}};
  const body={nodeType:1,tagName:'BODY',getAttribute:()=>'',childNodes:[main,{nodeType:3,nodeValue:'Visible body'}]};
  const read=vm.runInNewContext(`(${DOCUMENT_READ_FUNCTION})`,{document:{querySelector:()=>main,body},location:{href:'https://example.test/'},getComputedStyle:()=>({display:'block',visibility:'visible',whiteSpace:'normal'}),URL});
  assert.equal(read(1000,100).text,'Visible body');
});
test('Unicode chunks fit their fully escaped response and reconstruct the retained source',()=>{
  const text='文😀 "quoted" \\ line\n'.repeat(500);let offset=0;let reconstructed='';
  while(offset<text.length){
    const chunk=documentChunk(text,page,'d1',offset,2048,true);
    assert.ok(chunk.text.isWellFormed());
    assert.ok(Buffer.byteLength(JSON.stringify({resultType:'complete',content:[{type:'text',text:JSON.stringify({observation:chunk,nextCommandId:Number.MAX_SAFE_INTEGER})}]}))<=2048);
    reconstructed+=chunk.text;offset+=chunk.text.length;
    if(chunk.cursor)assert.equal(Number(chunk.cursor.split(':').at(-1)),offset);
    else assert.equal(chunk.complete,true);
  }
  assert.equal(reconstructed,text);
});
test('work-limited source can still be continued but never claims a complete document',()=>{
  const text='work '.repeat(1000);let offset=0,last;
  do{last=documentChunk(text,page,'d1',offset,2048,false);offset+=last.text.length;}while(last.cursor);
  assert.equal(offset,text.length);assert.equal(last.complete,false);assert.equal(last.incompleteReason,'work_limit');
  const bounded=boundDocumentUtf8('a😀b',4);assert.equal(bounded,'a');assert.ok(bounded.isWellFormed());
  assert.throws(()=>documentChunk('a😀b',page,'d1',2,2048,true),/cursor_expired/);
});
