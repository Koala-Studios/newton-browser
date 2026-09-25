import { temporaryRoot } from '../prototypes/support.mjs';
import { discoverBrowserExecutable } from '../../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import { createNewtonIdentity, openProfileStore } from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
import { ownedEngineConnection } from '../../apps/mcp-server/src/browser-runtime/engine-host.ts';
import { PageExecutor } from '../../packages/driver/src/page-executor.ts';
import { SessionEngine } from '../../packages/driver/src/session-engine.ts';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

// Development-only live diagnosis. Record protocol failures, never profile data.
const temp=temporaryRoot('navigation-diagnosis');let executor;
const evidence={checkedAt:new Date().toISOString(),runtime:'current source, not packed release acceptance',calls:[],axRequests:0,maxAXResponseBytes:0,protocolErrors:[],timeline:[],passed:false};
let closing=false;
const github=process.argv.includes('--github');
try {
  const store=openProfileStore(`${temp.root}/identities`);
  const identity=createNewtonIdentity(store,{browserFamily:'chrome'});
  const connection=await ownedEngineConnection({executablePath:discoverBrowserExecutable({family:'chrome'}).path,browserFamily:'chrome',profileStore:store,identityId:identity.id,ephemeralIdentity:true});
  const original=connection.wire.send.bind(connection.wire);
  connection.wire.onEvent(event=>{if(['DOM.documentUpdated','Page.frameNavigated','Page.frameStartedLoading','Page.frameStoppedLoading'].includes(event.method))evidence.timeline.push({event:event.method,at:performance.now()});});
  connection.wire.send=async(method,params,route)=>{
    try {const result=await original(method,params,route);if(result.exceptionDetails)evidence.protocolErrors.push({method,exception:result.exceptionDetails.exception?.description??result.exceptionDetails.text});if(method.startsWith('Accessibility.')){evidence.axRequests++;evidence.maxAXResponseBytes=Math.max(evidence.maxAXResponseBytes,Buffer.byteLength(JSON.stringify(result)));}return result;}
    catch(error){if(!closing){evidence.protocolErrors.push({method,code:error.code,detail:error.detail});evidence.timeline.push({failure:method,at:performance.now()});}throw error;}
  };
  executor=new PageExecutor(connection);
  const initial=await executor.start(github?'https://github.com/microsoft/vscode/issues':'https://www.wikipedia.org/');
  const engine=new SessionEngine('navigation-diagnosis',executor);
  let commandId=0;
  const act=async(action)=>{const started=performance.now();const receipt=await engine.submit({commandId:++commandId,action,timeoutMs:10000,maxBytes:16384});evidence.calls.push({action:action.kind,elapsedMs:performance.now()-started,reason:receipt.reason,errorCode:receipt.errorCode,dispatch:receipt.dispatch,postcondition:receipt.postcondition,url:receipt.observation?.url});assert.equal(receipt.reason,'completed');return receipt;};
  if(github){
    const field=initial.nodes?.find(node=>['textbox','searchbox','combobox'].includes(node.role)&&/issue|filter/i.test(node.name));
    evidence.initialFields=initial.nodes?.filter(node=>['textbox','searchbox','combobox'].includes(node.role));
    assert.ok(field,'issue filter must appear in initial view');
    const query='is:issue is:open label:bug';
    const filled=await act({kind:'fill',target:{kind:'ref',ref:field.ref},value:query});
    const fresh=filled.observation.nodes.find(node=>node.value===query);assert.ok(fresh);
    await act({kind:'press',target:{kind:'ref',ref:fresh.ref},keys:['Enter']});
    await act({kind:'wait_for',waitFor:{url:'label%3Abug',timeoutMs:5000}});
    const view=await engine.observe({mode:'controls',maxBytes:32768});
    assert.equal(new URL(view.url).searchParams.get('q'),query);
    evidence.filtered={url:view.url,issues:view.nodes.filter(node=>/github\.com\/microsoft\/vscode\/issues\/\d+/.test(node.href??'')).map(node=>({name:node.name,href:node.href}))};
    assert.ok(evidence.filtered.issues.length);assert.deepEqual(evidence.protocolErrors,[]);evidence.passed=true;
  }else{
  await act({kind:'fill',target:{kind:'semantic',role:'searchbox',name:'Search Wikipedia',exact:true},value:'Ada Lovelace'});
  await act({kind:'wait_for',waitFor:{text:'Ada Lovelace',timeoutMs:5000}});
  const controls=await engine.observe({mode:'controls',maxBytes:32768});
  const link=controls.nodes?.find(node=>node.href?.endsWith('/wiki/Ada_Lovelace'));
  if(!link)throw Error('missing result link');
  await act({kind:'click',target:{kind:'ref',ref:link.ref},waitFor:{text:'Countess of Lovelace',timeoutMs:5000}});
  const view=await engine.observe({mode:'controls',maxBytes:16384});assert.equal(view.url,'https://en.wikipedia.org/wiki/Ada_Lovelace');
  const doc=await engine.observe({mode:'document',maxBytes:16384});assert.match(doc.text,/Countess of Lovelace/);
  evidence.article={url:view.url,controls:view.nodes.length,documentState:doc.state,articleIdentityVerified:true};
  // A proven DOM-ID invalidation may be recovered inside the acknowledged click's
  // read-only wait. Keep those errors in evidence; require the actual receipt and
  // article oracle above, and do not allow unrelated protocol failures.
  assert.ok(evidence.protocolErrors.every(error=>error.method==='DOM.describeNode'&&error.detail==='Could not find node with given id'));
  evidence.passed=true;
  }
} finally {closing=true;await executor?.close();temp.remove();writeFileSync(new URL(`../../test/evidence/${github?'github':'navigation'}-diagnosis.json`,import.meta.url),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));}
