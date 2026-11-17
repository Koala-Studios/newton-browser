import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {temporaryRoot} from '../../scripts/prototypes/support.mjs';
import {discoverBrowserExecutable} from '../../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import {createNewtonIdentity,openProfileStore} from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
import {ownedEngineConnection} from '../../apps/mcp-server/src/browser-runtime/engine-host.ts';
import {PageExecutor} from '../../packages/driver/src/page-executor.ts';
import {CommandContext} from '../../packages/driver/src/command-context.ts';

// Nov 14: in Cloudflare's Worker editor (VS Code web) type and press were refused as "hidden or has no size", because
// the editor takes keys through a focused textarea it keeps at zero size. Newer VS Code uses an EditContext element.
test('keys and text reach a code editor\'s focused invisible input; an unfocused hidden field is still refused',async t=>{
  const browser=discoverBrowserExecutable({family:'chrome',env:process.env});
  if(!browser){t.skip('Chrome unavailable');return;}
  const root=temporaryRoot('focused-hidden-editor'),store=openProfileStore(`${root.root}/identities`);
  const identity=createNewtonIdentity(store,{browserFamily:'chrome'});
  const fixture=http.createServer((_request,response)=>{
    response.setHeader('content-type','text/html');
    response.end(`<!doctype html><title>Editor</title>
      <div class="monaco-editor"><textarea id="code" aria-label="Editor content" style="position:absolute;top:0;left:0;width:0;height:0;opacity:0;padding:0;border:0"></textarea></div>
      <textarea id="honeypot" style="position:absolute;width:0;height:0;opacity:0;padding:0;border:0"></textarea>
      <div id="native" role="textbox" aria-multiline="true" tabindex="0" style="width:1px;height:1px;opacity:0"></div>
      <script>
        const code=document.getElementById('code');code.dataset.keys='';code.dataset.input='';
        code.addEventListener('keydown',e=>{code.dataset.keys+=e.key+' ';});
        code.addEventListener('input',e=>{code.dataset.input+=e.data??'';});
        const native=document.getElementById('native');native.dataset.text='';
        if(typeof EditContext==='function'){const context=new EditContext();native.editContext=context;
          context.addEventListener('textupdate',e=>{native.dataset.text+=e.text;});native.dataset.supported='yes';}
      </script>`);
  });
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
  let executor;
  try{
    const connection=await ownedEngineConnection({executablePath:browser.path,browserFamily:'chrome',profileStore:store,identityId:identity.id,ephemeralIdentity:true,headless:true});
    executor=new PageExecutor(connection);await executor.start(`http://127.0.0.1:${fixture.address().port}/`);
    const page=executor.bindPage(),context=new CommandContext(10000);
    const route=executor.directory.route(executor.directory.binding(page,1));
    const evaluate=async expression=>(await connection.wire.send('Runtime.evaluate',{expression,returnByValue:true},route)).result.value;
    const attempt=async action=>{try{return await executor.act(context,page,action);}catch(error){return {errorCode:error?.code,detail:error?.detail??error?.message};}};
    try{
      await evaluate("document.getElementById('code').focus()");
      const typed=await attempt({kind:'type',target:{kind:'selector',selector:'#code'},value:'let x = 1;'});
      assert.equal(typed.state,'met',JSON.stringify(typed));
      assert.equal((await attempt({kind:'press',text:'2'})).state,'not_requested');
      // Both reached the input, in order. Where the caret sits in a box of no size is the platform's: macOS Chromium
      // keeps it at the start of a 0x0 textarea, so the value there reads "2let x = 1;" (an editor reads its input events).
      assert.equal(await evaluate("document.getElementById('code').dataset.input"),'let x = 1;2');
      assert.match(await evaluate("document.getElementById('code').value"),/^(let x = 1;2|2let x = 1;)$/u);
      assert.equal((await attempt({kind:'press',keys:['Enter']})).state,'not_requested');
      // A native textarea moves focus on Tab; an editor handles it itself. Either way the key reached the focused input.
      assert.equal((await attempt({kind:'press',target:{kind:'selector',selector:'#code'},keys:['Tab']})).state,'not_requested');
      assert.match(await evaluate("document.getElementById('code').dataset.keys"),/Enter Tab/u);

      // Tab may have moved focus on to the next field (macOS Chromium tabs into the 0x0 honeypot): put it back first.
      await evaluate("document.getElementById('code').focus()");
      assert.equal(await evaluate("document.activeElement.id"),'code');
      const honeypot=await attempt({kind:'type',target:{kind:'selector',selector:'#honeypot'},value:'x'});
      assert.equal(honeypot.errorCode,'target_not_editable','a hidden field nobody focused is still not typed into');
      assert.match(String(honeypot.detail),/hidden or has no size/u);
      assert.equal(await evaluate("document.getElementById('honeypot').value"),'');

      if(await evaluate("document.getElementById('native').dataset.supported")==='yes'){
        await evaluate("document.getElementById('native').focus()");
        const edited=await attempt({kind:'type',target:{kind:'selector',selector:'#native'},value:'abc'});
        assert.ok(!edited.errorCode,JSON.stringify(edited));
        assert.equal(await evaluate("document.getElementById('native').dataset.text"),'abc');
      }
    }finally{context.dispose();}
  }finally{if(executor)await executor.close();await new Promise(resolve=>fixture.close(resolve));root.remove();}
});
