import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { temporaryRoot } from '../../scripts/prototypes/support.mjs';
import { discoverBrowserExecutable } from '../../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import { createNewtonIdentity, openProfileStore } from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
import { ownedEngineConnection } from '../../apps/mcp-server/src/browser-runtime/engine-host.ts';
import { PageExecutor } from '../../packages/driver/src/page-executor.ts';
import { SessionEngine } from '../../packages/driver/src/session-engine.ts';

test('a real oversized AX name fails observation without destroying document reads or navigation',async()=>{
  const temp=temporaryRoot('oversized-observation');let executor;
  const server=http.createServer((req,res)=>{
    res.setHeader('content-type','text/html');
    res.end(req.url==='/large'?`<title>Large AX fixture</title><main><p>Normal article remains readable.</p><button aria-label="${'X'.repeat(5*1024*1024)}">Go</button></main>`:'<title>Recovered</title><main>Navigation remains available.</main>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const store=openProfileStore(`${temp.root}/identities`),identity=createNewtonIdentity(store,{browserFamily:'chrome'});
    const connection=await ownedEngineConnection({executablePath:discoverBrowserExecutable({family:'chrome'}).path,browserFamily:'chrome',profileStore:store,identityId:identity.id,ephemeralIdentity:true});
    executor=new PageExecutor(connection);
    const initial=await executor.start(`http://127.0.0.1:${server.address().port}/large`);
    assert.equal(initial.state,'incomplete');
    const engine=new SessionEngine('large-observation',executor);
    const read=await engine.observe({mode:'document',maxBytes:2048});assert.match(read.text,/Normal article remains readable/);
    const receipt=await engine.submit({commandId:1,action:{kind:'navigate',url:`http://127.0.0.1:${server.address().port}/ok`}});
    assert.equal(receipt.reason,'completed');assert.equal(receipt.postcondition.state,'met');
    const after=await engine.observe({mode:'document',maxBytes:2048});assert.match(after.text,/Navigation remains available/);
  }finally{await executor?.close();await new Promise(resolve=>server.close(resolve));temp.remove();}
});
