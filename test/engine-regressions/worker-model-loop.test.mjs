import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { temporaryRoot } from '../../scripts/prototypes/support.mjs';
import { discoverBrowserExecutable } from '../../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import { createNewtonIdentity, openProfileStore } from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
import { EngineHost, ownedEngineConnection } from '../../apps/mcp-server/src/browser-runtime/engine-host.ts';
import { handleEngineMcp } from '../../apps/mcp-server/src/engine-mcp.ts';

// Model-facing behaviour found by driving real sites (audit D1, D2, D22, D26).
test('a navigating keypress reports the committed page or a pending navigation, never a stalled read',async()=>{
  const temp=temporaryRoot('worker-model-loop');
  let delay=300;
  const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');
    if(req.url.startsWith('/r'))return setTimeout(()=>res.end('<h1>Results</h1><button>Next</button>'),delay);
    if(req.url==='/env')return res.end(`<h1 id=h></h1><p>accept=${req.headers['accept-language']}</p><p>Contact ops@example.com</p><script>h.textContent=navigator.language+' '+Intl.DateTimeFormat().resolvedOptions().timeZone+' '+innerWidth+'x'+innerHeight</script>`);
    res.end('<form action="/r"><input type=search name=q aria-label="Search"><button>Go</button></form>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const store=openProfileStore(`${temp.root}/identities`);
  const host=new EngineHost((_source,display)=>ownedEngineConnection({executablePath:discoverBrowserExecutable({family:'chrome'}).path,browserFamily:'chrome',profileStore:store,
    identityId:createNewtonIdentity(store,{browserFamily:'chrome'}).id,ephemeralIdentity:true,...(display?{display}:{})}));
  let id=0;
  const call=async(name,args)=>{
    const reply=await handleEngineMcp(host,{jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args}},{signal:new AbortController().signal});
    const value=JSON.parse(reply.result.content.at(-1).text);assert.ok(!reply.result.isError,JSON.stringify(value));return value;
  };
  const submit=(sessionId,commandId,timeoutMs)=>call('browser.act',{sessionId,command:{commandId,timeoutMs,action:{kind:'sequence',steps:[
    {kind:'fill',target:{kind:'semantic',role:'searchbox',name:'Search'},value:'otters'},{kind:'press',keys:['Enter']}]}}});
  try {
    const start=await call('browser.session.start',{url:`${origin}/`});const sessionId=start.sessionId;
    const rejected=await handleEngineMcp(host,{jsonrpc:'2.0',id:++id,method:'tools/call',params:{name:'browser.act',arguments:{sessionId,command:{commandId:1,action:{kind:'resize',viewport:{width:1280,height:900}}}}}},{signal:new AbortController().signal});
    assert.deepEqual(JSON.parse(rejected.result.content[0].text),{errorCode:'invalid_arguments',field:'arguments.command.action.viewport',expected:'not allowed here; allowed: kind, width, height',nextCommandId:1});
    const queried=await call('browser.observe',{sessionId,query:{role:'button'}});
    assert.deepEqual(queried.observation.nodes.map(node=>node.name),['Go']);
    const committed=await submit(sessionId,1,10000);
    assert.equal(committed.observation.navigation,undefined);
    assert.ok(committed.observation.nodes.some(node=>node.name==='Next'),JSON.stringify(committed.observation));
    await call('browser.act',{sessionId,command:{commandId:2,action:{kind:'navigate',url:`${origin}/`}}});
    delay=4000;
    const started=performance.now();
    const pending=await submit(sessionId,3,2000);
    assert.ok(performance.now()-started<2500,'the command returns inside its budget');
    assert.equal(pending.observation.navigation.state,'pending');
    assert.match(pending.observation.navigation.url,/\/r\?q=otters$/);
    const early=await call('browser.observe',{sessionId,timeoutMs:1000});
    assert.equal(early.observation.navigation?.state,'pending');
    const later=await call('browser.observe',{sessionId,timeoutMs:10000});
    assert.ok(later.observation.nodes.some(node=>node.name==='Next'),JSON.stringify(later.observation));

    const env=await call('browser.session.start',{url:`${origin}/env`,locale:'fr-CA',timezone:'America/Toronto',viewport:{width:1440,height:1000}});
    const text=(await call('browser.document.read',{sessionId:env.sessionId})).observation.text;
    assert.match(text,/fr-CA America\/Toronto 1440x1000/);
    assert.match(text,/accept=fr-CA/);
    assert.match(text,/ops@example\.com/,'page text is not rewritten');
    const plain=await call('browser.session.start',{url:`${origin}/env`});
    assert.match((await call('browser.document.read',{sessionId:plain.sessionId})).observation.text,/ 1280x900/);
  } finally {await host.close();await new Promise(resolve=>server.close(resolve));temp.remove();}
});
