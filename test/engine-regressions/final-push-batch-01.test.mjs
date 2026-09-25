import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {temporaryRoot} from '../../scripts/prototypes/support.mjs';
import {discoverBrowserExecutable} from '../../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import {createNewtonIdentity,openProfileStore} from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
import {EngineHost,ownedEngineConnection} from '../../apps/mcp-server/src/browser-runtime/engine-host.ts';
import {handleEngineMcp} from '../../apps/mcp-server/src/engine-mcp.ts';
import {PageExecutor} from '../../packages/driver/src/page-executor.ts';
import {CommandContext} from '../../packages/driver/src/command-context.ts';

function deferred(){
  let resolve,reject;
  const promise=new Promise((nextResolve,nextReject)=>{resolve=nextResolve;reject=nextReject;});
  return {promise,resolve,reject};
}

function rootMarkup(port){
  const long='x'.repeat(9000)+'long-after-8192';
  const huge='y'.repeat(262_200)+'beyond-work-cap';
  const oversized=Array.from({length:4097},(_,index)=>`<option value="${index}">${index}</option>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Batch root</title></head><body>
    <main>
      <h1>Visible heading</h1>
      <p id="long">${long}</p>
      <p id="adjacent"><span>adjacent-left</span><span>adjacent-right</span></p>
      <p id="unicode">unicode-left\u{1f600}unicode-right</p>
      <input id="ordinary" aria-label="ordinary" value="before">
      <input id="combo" role="combobox" aria-label="Choose value" aria-expanded="true" aria-controls="combo-options">
      <ul id="combo-options" role="listbox"><li role="option">Alpha</li><li role="option">Beta</li></ul>
      <select id="normal-select" aria-label="Normal select" onchange="this.dataset.changed=this.value"><option value="first">First</option><option value="second">Second</option></select>
      <select id="oversized-select" aria-label="Oversized select" onfocus="this.dataset.focused='yes'" oninput="this.dataset.input='yes'">${oversized}</select>
      <button id="navigate" onclick="location.href='/destination'">Navigate</button>
      <iframe title="Nested child" src="/child"></iframe>
      <iframe title="Hidden child" style="display:none" src="/hidden"></iframe>
    </main>
    <aside id="outside-main">Outside-main status ready</aside>
    <dialog id="outside-dialog" open>Outside-main dialog ready</dialog>
    <script>
      document.querySelector('#ordinary').addEventListener('input',event=>document.body.dataset.ordinary=event.target.value);
      document.querySelector('#normal-select').addEventListener('change',event=>document.body.dataset.normal=event.target.value);
    </script>
  </body></html>`;
}

function childMarkup(){
  return `<!doctype html><html><body><main><p>visible child content</p><iframe title="Nested grandchild" src="/grandchild"></iframe></main></body></html>`;
}

function pageMarkup(text){
  return `<!doctype html><html><body><main>${text}</main></body></html>`;
}

async function withFixture(t,callback){
  const browser=discoverBrowserExecutable({family:'chrome',env:process.env});
  if(!browser){t.skip('Chrome unavailable');return;}
  const temporary=temporaryRoot('final-push-batch-01');
  const navigation=deferred(),slowFrame=deferred();
  let server,executor,slowNavigationResponse,slowFrameResponse;
  await new Promise((resolve,reject)=>{
    server=http.createServer(async(request,response)=>{
      response.setHeader('content-type','text/html; charset=utf-8');
      response.setHeader('cache-control','no-store');
      const url=request.url??'/';
      if(url==='/child')return void response.end(childMarkup());
      if(url==='/grandchild')return void response.end(pageMarkup('deep nested frame needle'));
      if(url==='/hidden')return void response.end(pageMarkup('hidden iframe secret'));
      if(url==='/destination')return void response.end(pageMarkup('destination ready'));
      if(url==='/huge')return void response.end(pageMarkup('y'.repeat(262_200)+'beyond-work-cap'));
      if(url==='/slow-nav'){slowNavigationResponse=response;response.write('<!doctype html><html><body><main>loading navigation</main>');await navigation.promise;return void response.end('</body></html>');}
      if(url==='/slow-frame'){slowFrameResponse=response;response.write('<!doctype html><html><body><main>loading frame');await slowFrame.promise;return void response.end('slow frame ready</main></body></html>');}
      response.end(rootMarkup(server.address().port));
    });
    server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
  });
  try{
    const store=openProfileStore(`${temporary.root}/identities`);
    const identity=createNewtonIdentity(store,{browserFamily:'chrome'});
    const connection=await ownedEngineConnection({executablePath:browser.path,browserFamily:'chrome',profileStore:store,identityId:identity.id,ephemeralIdentity:true,headless:true});
    executor=new PageExecutor(connection);
    const url=path=>`http://127.0.0.1:${server.address().port}${path}`;
    await executor.start(url('/'));
    await callback({browser,connection,executor,url,navigation,slowFrame,releaseNavigation:()=>navigation.resolve(),releaseSlowFrame:()=>slowFrame.resolve(),hasPendingResponses:()=>Boolean(slowNavigationResponse||slowFrameResponse)});
  }finally{
    if(slowNavigationResponse)navigation.resolve();
    if(slowFrameResponse)slowFrame.resolve();
    if(executor)await executor.close();
    await new Promise(resolve=>server.close(resolve));
    temporary.remove();
  }
}

async function withContext(callback,timeout=5000){
  const context=new CommandContext(timeout);
  try{return await callback(context);}finally{context.dispose();}
}

async function evaluate(connection,executor,expression){
  const page=executor.bindPage(),binding=executor.directory.binding(page,1),route=executor.directory.route(binding);
  const result=await connection.wire.send('Runtime.evaluate',{expression,returnByValue:true,throwOnSideEffect:true},route);
  assert.equal(result.exceptionDetails,undefined);
  return result.result.value;
}

function encodedObservation(observation,nextCommandId=Number.MAX_SAFE_INTEGER){
  return Buffer.byteLength(JSON.stringify({resultType:'complete',content:[{type:'text',text:JSON.stringify({observation,nextCommandId})}]}));
}

test('streamed text waits cover long adjacent Unicode, frames, outside-main content, caps and cancellation',async t=>{
  await withFixture(t,async({executor,connection,url})=>{
    const page=executor.bindPage();
    await withContext(async context=>{
      assert.equal(await executor.waitFact(context,page,{text:'long-after-8192'}),true);
      assert.equal(await executor.waitFact(context,page,{text:'adjacent-leftadjacent-right'}),true);
      assert.equal(await executor.waitFact(context,page,{text:'unicode-left\u{1f600}unicode-right'}),true);
      assert.equal(await executor.waitFact(context,page,{text:'deep nested frame needle'}),true);
      assert.equal(await executor.waitFact(context,page,{text:'hidden iframe secret'}),false);
      assert.equal(await executor.waitFact(context,page,{text:'Outside-main status ready'}),true);
      assert.equal(await executor.waitFact(context,page,{text:'Outside-main dialog ready'}),true);
      assert.equal(await executor.waitFact(context,page,{text:'# Visible heading'}),false);

      const originalSend=connection.wire.send.bind(connection.wire);
      let cancelled=false;
      const cancellation=new CommandContext(5000);
      connection.wire.send=async(method,params,routeId)=>{
        const result=await originalSend(method,params,routeId);
        if(!cancelled&&method==='DOM.getDocument'){cancelled=true;queueMicrotask(()=>cancellation.cancel());}
        return result;
      };
      await assert.rejects(executor.waitFact(cancellation,page,{text:'not-present-anywhere'}),error=>error?.code==='cancelled');
      cancellation.dispose();connection.wire.send=originalSend;
    });

    await withContext(async context=>{
      const result=await executor.act(context,page,{kind:'navigate',url:url('/huge')});
      assert.deepEqual(result,{state:'met',kind:'navigation'});
    });
    const hugePage=executor.bindPage();
    await withContext(async context=>{
      await assert.rejects(executor.waitFact(context,hugePage,{text:'not-after-work-cap'}),error=>error?.code==='search_incomplete');
    },10000);
  });
});

test('expanded native combobox feedback stays bounded while ordinary fill remains local',async t=>{
  await withFixture(t,async({executor,connection})=>{
    const page=executor.bindPage();
    const originalSend=connection.wire.send.bind(connection.wire);
    let fullTreeCalls=0;
    connection.wire.send=async(method,params,route)=>{if(method==='Accessibility.getFullAXTree')fullTreeCalls++;return originalSend(method,params,route);};
    await withContext(async context=>{
      const first=await executor.observe(context,page,16384);
      assert.ok(first.nodes.some(node=>node.role==='combobox'&&node.name==='Choose value'));
      assert.ok(first.nodes.some(node=>node.role==='option'&&node.name==='Alpha'));
      assert.ok(first.nodes.some(node=>node.role==='option'&&node.name==='Beta'));
      assert.equal(new Set(first.nodes.map(node=>node.ref)).size,first.nodes.length);
      assert.ok(encodedObservation(first,Number.MAX_SAFE_INTEGER)<=16384);
      const ordinary=first.nodes.find(node=>node.role==='textbox'&&node.name==='ordinary');
      assert.ok(ordinary);
      const beforeFullTree=fullTreeCalls;
      await executor.observe(context,page,16384);
      const afterObserveFullTree=fullTreeCalls;
      const filled=await executor.act(context,page,{kind:'fill',target:{kind:'ref',ref:ordinary.ref},value:'local-fill'});
      assert.equal(filled.state,'met');
      const value=await evaluate(connection,executor,'document.querySelector("#ordinary").value');
      assert.equal(value,'local-fill');
      const afterFillFullTree=fullTreeCalls;
      assert.equal(afterFillFullTree,afterObserveFullTree);
      assert.ok(afterObserveFullTree>=beforeFullTree);
      const oldRefFill=await executor.act(context,page,{kind:'fill',target:{kind:'ref',ref:ordinary.ref},value:'old-ref-still-valid'});
      assert.equal(oldRefFill.state,'met');
    });
  });
});

test('oversized select acquisition refuses before focus/input while normal trusted select works',async t=>{
  await withFixture(t,async({executor,connection})=>{
    const page=executor.bindPage();
    await withContext(async context=>{
      await assert.rejects(executor.act(context,page,{kind:'select',target:{kind:'selector',selector:'#oversized-select'},value:'4096'}),error=>error?.code==='search_incomplete');
      const oversizedState=await evaluate(connection,executor,'({active:document.activeElement?.id||"",focused:document.querySelector("#oversized-select").dataset.focused||"",input:document.querySelector("#oversized-select").dataset.input||""})');
      assert.deepEqual(oversizedState,{active:'',focused:'',input:''});
      const normal=await executor.act(context,page,{kind:'select',target:{kind:'selector',selector:'#normal-select'},value:'second'});
      assert.equal(normal.state,'met');
      const normalState=await evaluate(connection,executor,'({value:document.querySelector("#normal-select").value,changed:document.querySelector("#normal-select").dataset.changed})');
      assert.deepEqual(normalState,{value:'second',changed:'second'});
    });
  });
});

test('navigation waits for loading readiness, preserves metadata on AX failure, reloads generation, and does not replay input',async t=>{
  await withFixture(t,async({executor,connection,url,releaseNavigation})=>{
    let page=executor.bindPage();
    const initialGeneration=page.documentGeneration;
    await withContext(async context=>{
      const originalSend=connection.wire.send.bind(connection.wire);
      let fail=true;
      connection.wire.send=async(method,params,route)=>{
        if(fail&&method==='Accessibility.getFullAXTree'){fail=false;throw new Error('synthetic AX unavailable');}
        return originalSend(method,params,route);
      };
      const failed=await executor.observe(context,page,16384);
      connection.wire.send=originalSend;
      assert.equal(failed.incompleteReason,'evidence_unavailable');
      assert.equal(failed.title,'Batch root');
      assert.match(failed.url??'',/127\.0\.0\.1/);
    });

    const navigationContext=new CommandContext(5000);
    const pending=executor.act(navigationContext,page,{kind:'navigate',url:url('/slow-nav')});
    await Promise.resolve();
    releaseNavigation();
    assert.deepEqual(await pending,{state:'met',kind:'navigation'});
    navigationContext.dispose();
    page=executor.bindPage();
    assert.ok(page.documentGeneration>initialGeneration);
    assert.match(executor.directory.inventory().find(item=>item.pageId===page.pageId)?.url??'',/slow-nav/);

    await withContext(async context=>assert.deepEqual(await executor.act(context,page,{kind:'reload'}),{state:'met',kind:'navigation'}));
    const reloaded=executor.bindPage();
    assert.ok(reloaded.documentGeneration>page.documentGeneration);

    await withContext(async context=>assert.deepEqual(await executor.act(context,reloaded,{kind:'navigate',url:url('/')}),{state:'met',kind:'navigation'}));
    page=executor.bindPage();
    await withContext(async context=>{await executor.observe(context,page,16384);});
    const originalInputSend=connection.wire.send.bind(connection.wire);let pointerDispatches=0;
    connection.wire.send=async(method,params,route)=>{if(method==='Input.dispatchMouseEvent')pointerDispatches++;return originalInputSend(method,params,route);};
    const before=pointerDispatches;
    await withContext(async context=>assert.deepEqual(await executor.act(context,page,{kind:'click',target:{kind:'selector',selector:'#navigate'},waitFor:{url:'/destination',timeoutMs:2000}}),{state:'met',kind:'visible'}));
    const after=pointerDispatches;
    connection.wire.send=originalInputSend;
    assert.equal(after-before,3);
  });
});

test('MDN public search through MCP returns actionable feedback and destination receipt',async t=>{
  const browser=discoverBrowserExecutable({family:'chrome',env:process.env});
  if(!browser){t.skip('Chrome unavailable');return;}
  const temporary=temporaryRoot('final-push-mdn'),store=openProfileStore(`${temporary.root}/identities`),identity=createNewtonIdentity(store,{browserFamily:'chrome'});
  let host;
  try{
    host=new EngineHost(()=>ownedEngineConnection({executablePath:browser.path,browserFamily:'chrome',profileStore:store,identityId:identity.id,ephemeralIdentity:true,headless:true}));
    let requestId=0;
    const call=async(name,argumentsValue)=>{
      const reply=await handleEngineMcp(host,{jsonrpc:'2.0',id:++requestId,method:'tools/call',params:{name,arguments:argumentsValue}},{signal:new AbortController().signal});
      assert.ok(reply?.result?.content?.[0]?.text,JSON.stringify(reply));
      const value=JSON.parse(reply.result.content[0].text);
      assert.equal(reply.result.isError,undefined,JSON.stringify(value));
      return value;
    };
    const start=await call('browser.session.start',{url:'https://developer.mozilla.org/en-US/'});
    const sessionId=start.sessionId;
    const searchButton=start.observation.nodes.find(node=>node.role==='button'&&node.name==='Search');
    assert.ok(searchButton,JSON.stringify(start.observation));
    const opened=await call('browser.act',{sessionId,command:{commandId:start.nextCommandId,action:{kind:'click',target:{kind:'ref',ref:searchButton.ref}}}});
    assert.equal(opened.dispatch,'acknowledged',JSON.stringify(opened));
    const searchView=await call('browser.observe',{sessionId,maxBytes:32768});
    const search=searchView.observation.nodes.find(node=>(node.role==='textbox'||node.role==='combobox')&&/search/i.test(node.name??''));
    assert.ok(search,JSON.stringify(searchView));
    const filled=await call('browser.act',{sessionId,command:{commandId:searchView.nextCommandId,action:{kind:'fill',target:{kind:'ref',ref:search.ref},value:'Input.imeSetComposition'}}});
    assert.equal(filled.postcondition.state,'met',JSON.stringify(filled));
    const links=await call('browser.observe',{sessionId,mode:'records',recordShape:'links',maxBytes:32768});
    const result=links.observation.records.find(record=>/Input\.imeSetComposition/i.test(`${record.name??''} ${record.href??''}`));
    assert.ok(result,JSON.stringify(links));
    const expectedPath=new URL(result.href).pathname;
    const clicked=await call('browser.act',{sessionId,command:{commandId:links.nextCommandId,action:{kind:'click',target:{kind:'ref',ref:result.ref},waitFor:{url:expectedPath,timeoutMs:15000}}}});
    assert.equal(clicked.postcondition.state,'met',JSON.stringify(clicked));
    assert.equal(clicked.observation?.url?.includes(expectedPath),true,JSON.stringify(clicked));
    assert.ok(clicked.observation?.state==='available'||clicked.observation?.state==='incomplete',JSON.stringify(clicked));
  }catch(error){
    t.diagnostic(`MDN public search feedback failed: ${error?.code??error?.message??error}`);
    throw error;
  }finally{
    if(host)await host.close();
    temporary.remove();
  }
});
