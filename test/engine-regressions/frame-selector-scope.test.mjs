import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { temporaryRoot } from '../../scripts/prototypes/support.mjs';
import { discoverBrowserExecutable } from '../../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import { createNewtonIdentity, openProfileStore } from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
import { ownedEngineConnection } from '../../apps/mcp-server/src/browser-runtime/engine-host.ts';
import { PageExecutor } from '../../packages/driver/src/page-executor.ts';
import { CommandContext } from '../../packages/driver/src/command-context.ts';
import { SessionEngine } from '../../packages/driver/src/session-engine.ts';

for (const crossSite of [false, true]) test(`selectors and pointers preserve frame scope (${crossSite ? 'cross-site' : 'same-site'})`, async () => {
  const temp = temporaryRoot('frame-selector-scope');
  const server = http.createServer((req,res) => { res.setHeader('content-type','text/html');
    res.end(req.url === '/child' ? '<input id="child" aria-label="Child"><input type="checkbox" id="check" aria-label="Check"><div id="scrollbox" style="height:60px;overflow:auto" onscroll="document.getElementById(\'scroll-state\').textContent=\'container-scrolled\'"><p style="height:500px">Scrollable content</p></div><p id="scroll-state">initial</p>' : `<input id="parent" aria-label="Parent"><iframe style="margin-left:100px;height:240px" src="http://127.0.0.1:${server.address().port}/child"></iframe>`); });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let executor;
  try {
    const store=openProfileStore(`${temp.root}/identities`);
    const identity=createNewtonIdentity(store,{browserFamily:'chrome'});
    const connection=await ownedEngineConnection({executablePath:discoverBrowserExecutable({family:'chrome'}).path,browserFamily:'chrome',profileStore:store,identityId:identity.id,ephemeralIdentity:true});
    executor=new PageExecutor(connection);
    await executor.start(`http://${crossSite ? 'localhost' : '127.0.0.1'}:${server.address().port}/`);
    const page=executor.bindPage();
    assert.equal(executor.directory.frames(page.pageId).length,2);
    const outcomes=[];
    for(const selector of ['#parent','#child']) {
      const context=new CommandContext(2000);
      try { outcomes.push(await executor.act(context,page,{kind:'fill',target:{kind:'selector',selector},value:'scoped'})); }
      catch(error){outcomes.push({error:error.code??error.message});}
      finally{context.dispose();}
    }
    assert.deepEqual(outcomes,[{state:'met',kind:'value'},{state:'met',kind:'value'}]);
    const clickContext=new CommandContext(2000);
    try { assert.deepEqual(await executor.act(clickContext,page,{kind:'click',target:{kind:'selector',selector:'#check'},waitFor:{selector:'#check',state:'checked',timeoutMs:500}}),{state:'met',kind:'visible'}); }
    finally {clickContext.dispose();}
    const navContext=new CommandContext(1000);
    try {
      const generation=executor.bindPage().documentGeneration;
      const url=`http://${crossSite ? 'localhost' : '127.0.0.1'}:${server.address().port}/#fragment`;
      assert.deepEqual(await executor.act(navContext,executor.bindPage(),{kind:'navigate',url}),{state:'met',kind:'navigation'});
      assert.equal(executor.bindPage().documentGeneration,generation);
      for(const kind of ['back','forward']) assert.deepEqual(await executor.act(navContext,executor.bindPage(),{kind}),{state:'met',kind:'navigation'});
    }finally {navContext.dispose();}
    const engine=new SessionEngine('field-feedback',executor);
    const edited=await engine.submit({commandId:1,action:{kind:'fill',target:{kind:'selector',selector:'#child'},value:'updated'}});
    assert.equal(edited.observation.scope,'target');
    assert.equal(edited.observation.nodes.length,1);
    assert.equal(edited.observation.nodes[0].value,'updated');
    assert.equal(edited.observation.nodes[0].name,'Child');
    assert.ok((await engine.observe()).nodes.length>=3);
    const scrolled=await engine.submit({commandId:2,action:{kind:'scroll',target:{kind:'selector',selector:'#scrollbox'},x:0,y:100}});
    const effect=await engine.submit({commandId:3,action:{kind:'wait_for',waitFor:{text:'container-scrolled',timeoutMs:500}}});
    assert.equal(effect.postcondition.state,'met',JSON.stringify(effect));
    assert.equal(scrolled.postcondition.state,'met',JSON.stringify(scrolled));
  } finally {if(executor)await executor.close();await new Promise(resolve=>server.close(resolve));temp.remove();}
});
