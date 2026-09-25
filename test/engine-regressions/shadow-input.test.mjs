import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {temporaryRoot} from '../../scripts/prototypes/support.mjs';
import {discoverBrowserExecutable} from '../../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import {createNewtonIdentity,openProfileStore} from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
import {ownedEngineConnection} from '../../apps/mcp-server/src/browser-runtime/engine-host.ts';
import {PageExecutor} from '../../packages/driver/src/page-executor.ts';
import {CommandContext} from '../../packages/driver/src/command-context.ts';

test('returned shadow controls support native click, fill and focused text without piercing selectors',async t=>{
  const browser=discoverBrowserExecutable({family:'chrome',env:process.env});
  if(!browser){t.skip('Chrome unavailable');return;}
  const root=temporaryRoot('shadow-input'),store=openProfileStore(`${root.root}/identities`);
  const identity=createNewtonIdentity(store,{browserFamily:'chrome'});
  const fixture=http.createServer((_request,response)=>{
    response.setHeader('content-type','text/html');
    response.end(`<!doctype html><title>Shadow input repro</title><div id=open></div><div id=closed></div>
      <script>for(const mode of ['open','closed']){
        const host=document.getElementById(mode),shadow=host.attachShadow({mode});
        shadow.innerHTML='<button><span>'+mode+' button</span></button><input aria-label="'+mode+' input">';
        shadow.querySelector('button').onclick=()=>host.dataset.clicked='yes';
        shadow.querySelector('input').oninput=e=>host.dataset.effect=e.target.value;
      }</script>`);
  });
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
  let executor;
  try{
    const connection=await ownedEngineConnection({executablePath:browser.path,browserFamily:'chrome',profileStore:store,identityId:identity.id,ephemeralIdentity:true,headless:true});
    const originalSend=connection.wire.send.bind(connection.wire);
    connection.wire.send=async(...args)=>{const result=await originalSend(...args);if(result.exceptionDetails)console.error('shadow inspection exception',JSON.stringify(result.exceptionDetails));return result;};
    executor=new PageExecutor(connection);await executor.start(`http://127.0.0.1:${fixture.address().port}/`);
    const page=executor.bindPage(),context=new CommandContext(5000);
    try{
      for(const mode of ['open','closed']){
        let observation=await executor.observe(context,page,16384);
        const button=observation.nodes.find(node=>node.name===`${mode} button`);assert.ok(button);
        const clicked=await executor.act(context,page,{kind:'click',target:{kind:'ref',ref:button.ref}});assert.equal(clicked.state,'not_requested');
        observation=await executor.observe(context,page,16384);
        const input=observation.nodes.find(node=>node.name===`${mode} input`);assert.ok(input);
        const filled=await executor.act(context,page,{kind:'fill',target:{kind:'ref',ref:input.ref},value:'alpha'});assert.equal(filled.state,'met');
        const pressed=await executor.act(context,page,{kind:'press',text:'-beta'});assert.equal(pressed.state,'not_requested');
        const route=executor.directory.route(executor.directory.binding(page,1));
        const effects=await connection.wire.send('Runtime.evaluate',{expression:`({clicked:document.querySelector('#${mode}').getAttribute('data-clicked'),value:document.querySelector('#${mode}').getAttribute('data-effect')})`,returnByValue:true,throwOnSideEffect:true},route);
        assert.deepEqual(effects.result.value,{clicked:'yes',value:'alpha-beta'});
      }
    }finally{context.dispose();}
  }finally{if(executor)await executor.close();await new Promise(resolve=>fixture.close(resolve));root.remove();}
});
