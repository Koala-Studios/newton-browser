import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTableGrid } from '../src/table-grid.ts';
const cell=(id,extra={})=>({id,header:false,text:id,rowSpan:1,colSpan:1,...extra});
const row=(id,cells,groupId='body')=>({id,cells,groupId});

test('spans retain source-cell identity, missing cells, duplicate labels and link boundaries',()=>{
  const input=[row('head',[cell('h1',{header:true,scope:'col',text:'Name'}),cell('h2',{header:true,scope:'col',text:'Name'})],'head'),
    row('r1',[cell('a',{rowSpan:2,links:[{label:'Actual link',href:'https://example.test/a'}]}),cell('b')]),row('r2',[cell('c')]),row('r3',[cell('d')])];
  const grid=buildTableGrid(input);assert.equal(grid.state,'available');
  assert.deepEqual(grid.rows.map(row=>row.slots),[['h1','h2'],['a','b'],['a','c'],['d',null]]);
  assert.deepEqual(grid.cells.find(cell=>cell.id==='c').headerIds,['h2']);
  assert.equal(grid.cells.filter(cell=>cell.id==='a').length,1);assert.deepEqual(grid.cells.find(cell=>cell.id==='a').links,input[1].cells[0].links);
});

test('rowspan zero extends only through its own contiguous row group',()=>{
  const grid=buildTableGrid([row('a',[cell('span',{rowSpan:0}),cell('x')],'one'),row('b',[cell('y')],'one'),row('c',[cell('z')],'two')]);
  assert.equal(grid.state,'available');assert.equal(grid.cells[0].effectiveRowSpan,2);
  assert.deepEqual(grid.rows.map(row=>row.slots),[['span','x'],['span','y'],['z',null]]);
});

test('overlap and cross-group spans are explicit unsupported structures',()=>{
  assert.deepEqual(buildTableGrid([row('a',[cell('x'),cell('held',{rowSpan:2})]),row('b',[cell('wide',{colSpan:2})])]),{state:'unsupported',reason:'overlap'});
  assert.deepEqual(buildTableGrid([row('a',[cell('cross',{rowSpan:2})],'one'),row('b',[cell('other')],'two')]),{state:'unsupported',reason:'row_group_crossing'});
});

test('explicit headers win, preserve missing/ambiguous associations, and never guess by label',()=>{
  const grid=buildTableGrid([row('a',[cell('h1',{header:true,domId:'name',scope:'col'}),cell('h2',{header:true,domId:'duplicate'}),cell('h3',{header:true,domId:'duplicate'})]),
    row('b',[cell('v1',{explicitHeaders:['name','name']}),cell('v2',{explicitHeaders:['missing','duplicate']}),cell('v3',{explicitHeaders:[]})])]);
  assert.equal(grid.state,'available');
  const byId=new Map(grid.cells.map(cell=>[cell.id,cell]));
  assert.deepEqual(byId.get('v1').headerIds,['h1']);assert.equal(byId.get('v1').headersUnresolved,false);
  assert.deepEqual(byId.get('v2').headerIds,[]);assert.equal(byId.get('v2').headersUnresolved,true);
  assert.deepEqual(byId.get('v3').headerIds,[]);assert.equal(byId.get('v3').headersUnresolved,false);
});

test('row-group headers are restricted to their group and automatic headers remain unresolved',()=>{
  const grid=buildTableGrid([row('a',[cell('group',{header:true,scope:'rowgroup'}),cell('auto',{header:true})],'one'),row('b',[cell('value')],'one'),row('c',[cell('other')],'two')]);
  assert.equal(grid.state,'available');assert.deepEqual(grid.cells.find(cell=>cell.id==='value').headerIds,['group']);
  assert.deepEqual(grid.cells.find(cell=>cell.id==='other').headerIds,[]);assert.equal(grid.cells.find(cell=>cell.id==='group').headersUnresolved,true);
});

test('dimensions, identities and span validation bound work before allocating slots',()=>{
  assert.deepEqual(buildTableGrid(Array.from({length:129},(_,i)=>row(String(i),[]))),{state:'unsupported',reason:'work_limit'});
  assert.deepEqual(buildTableGrid([row('a',[cell('wide',{colSpan:1000000000})])]),{state:'unsupported',reason:'work_limit'});
  assert.deepEqual(buildTableGrid([row('a',[cell('bad',{rowSpan:-1})])]),{state:'unsupported',reason:'invalid_span'});
  assert.deepEqual(buildTableGrid([row('a',[cell('same'),cell('same')])]),{state:'unsupported',reason:'duplicate_identity'});
});
