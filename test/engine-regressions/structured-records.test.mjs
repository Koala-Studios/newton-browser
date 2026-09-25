import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {temporaryRoot} from '../../scripts/prototypes/support.mjs';
import {discoverBrowserExecutable} from '../../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import {createNewtonIdentity,openProfileStore} from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
import {EngineHost,ownedEngineConnection} from '../../apps/mcp-server/src/browser-runtime/engine-host.ts';
import {handleEngineMcp} from '../../apps/mcp-server/src/engine-mcp.ts';

test('MCP table, form and link records preserve structure, budgets and actionable refs',{timeout:10000},async()=>{
  const temp=temporaryRoot('structured-records');
  const server=http.createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end(`<!doctype html><title>Structured records</title>
    <table id="roster"><caption>Roster</caption><tfoot><tr><td>Footer last in grid</td><td>End</td></tr></tfoot><thead><tr><th id="name" scope="col">Name</th><th scope="col">Status</th></tr></thead><tbody>
    <tr><td rowspan="2"><a href="/alice">Alice Example</a></td><td>Ready</td></tr><tr><td>Busy</td></tr><tr><td headers="name">Bob</td><td></td></tr></tbody></table>
    <form aria-label="Profile"><label>Name<input id="edit" value="original"></label><label>Password<input type="password" value="SYNTHETIC_PASSWORD_MUST_NOT_LEAK"></label><label><input type="checkbox" checked>Active</label></form>
    <a href="/visible">Visible destination</a><div hidden><a href="/hidden">Hidden destination</a></div>`);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const store=openProfileStore(`${temp.root}/identities`),identity=createNewtonIdentity(store,{browserFamily:'chrome'});
  const host=new EngineHost(()=>ownedEngineConnection({executablePath:discoverBrowserExecutable({family:'chrome'}).path,browserFamily:'chrome',profileStore:store,identityId:identity.id,ephemeralIdentity:true}));
  let requestId=0;
  const call=async(name,args)=>{
    const reply=await handleEngineMcp(host,{jsonrpc:'2.0',id:++requestId,method:'tools/call',params:{name,arguments:args}},{signal:new AbortController().signal});
    if(args.maxBytes)assert.ok(Buffer.byteLength(JSON.stringify(reply.result))<=args.maxBytes);
    const value=JSON.parse(reply.result.content[0].text);assert.ok(!reply.result.isError,JSON.stringify(value));return value;
  };
  try{
    const start=await call('browser.session.start',{url:`http://127.0.0.1:${server.address().port}/`});const sessionId=start.sessionId;
    const full=await call('browser.observe',{sessionId,mode:'records',recordShape:'table',maxBytes:16384});
    assert.equal(full.observation.state,'available',JSON.stringify(full));
    const table=full.observation.records[0];assert.equal(table.kind,'table');assert.equal(table.name,'Roster');assert.equal(table.coverage,'rendered');assert.equal(table.complete,true);
    assert.equal(table.columns.length,2);assert.equal(table.rows.length,5);
    assert.equal(table.cells.find(cell=>cell.id===table.rows[4].slots[0]).text,'Footer last in grid');
    assert.equal(table.rows[1].slots[0],table.rows[2].slots[0]);
    const alice=table.cells.find(cell=>cell.text==='Alice Example');assert.ok(alice);assert.equal(alice.rowSpan,2);assert.equal(alice.links[0].label,'Alice Example');assert.match(alice.links[0].href,/\/alice$/);
    assert.deepEqual(alice.headerIds,[table.rows[0].slots[0]]);assert.equal(table.cells.find(cell=>cell.text==='Bob').headersUnresolved,false);
    assert.equal(table.cells.find(cell=>cell.id===table.rows[3].slots[1]).text,'');
    const same=await call('browser.observe',{sessionId,mode:'records',recordShape:'table',previousSnapshotId:full.observation.snapshotId,maxBytes:16384});
    assert.equal(same.observation.delta.reset,false);assert.deepEqual(same.observation.records,[]);
    assert.deepEqual(same.observation.delta.changed,[]);assert.equal(same.observation.delta.refs[0].recordId,table.recordId);
    assert.notEqual(same.observation.delta.refs[0].ref,table.ref);
    const compact=await call('browser.observe',{sessionId,mode:'records',recordShape:'table',scope:{kind:'selector',selector:'#roster'},maxBytes:2048});
    assert.equal(compact.observation.state,'incomplete');assert.equal(compact.observation.records[0].complete,false);assert.ok(compact.observation.records[0].rows.length>0);
    const formView=await call('browser.observe',{sessionId,mode:'records',recordShape:'form',maxBytes:8192});const form=formView.observation.records[0];
    assert.equal(form.kind,'form');assert.equal(form.name,'Profile');assert.ok(form.fields.find(field=>field.name==='Active').checked);
    assert.ok(!JSON.stringify(formView).includes('SYNTHETIC_PASSWORD'));assert.ok(form.fields.every(field=>field.value===undefined));
    const name=form.fields.find(field=>field.name==='Name');assert.ok(name?.ref);
    const fill=await call('browser.act',{sessionId,command:{commandId:1,action:{kind:'fill',target:{kind:'ref',ref:name.ref},value:'Updated'}}});assert.equal(fill.postcondition.state,'met');
    const links=await call('browser.observe',{sessionId,mode:'records',recordShape:'links',previousSnapshotId:formView.observation.snapshotId,maxBytes:8192});
    assert.equal(links.observation.delta.reset,true);assert.ok(links.observation.records.every(record=>record.kind==='link'));
    assert.ok(links.observation.records.some(record=>record.name==='Visible destination'));assert.ok(!JSON.stringify(links).includes('Hidden destination'));
    assert.equal(links.nextCommandId,2);
  }finally{await host.close();await new Promise(resolve=>server.close(resolve));temp.remove();}
});
