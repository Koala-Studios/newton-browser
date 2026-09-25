import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { temporaryRoot } from '../../scripts/prototypes/support.mjs';
import { discoverBrowserExecutable } from '../../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import { createNewtonIdentity, openProfileStore } from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
import { ownedEngineConnection } from '../../apps/mcp-server/src/browser-runtime/engine-host.ts';
import { PageExecutor } from '../../packages/driver/src/page-executor.ts';
import { CommandContext } from '../../packages/driver/src/command-context.ts';
import { DOCUMENT_READ_FUNCTION, FRAME_SCOPE_FUNCTION } from '../../packages/driver/src/document-reader.ts';

const GRIN = String.fromCodePoint(0x1f600);

function fixtureMarkup(targetUrl) {
  const repeated = Array.from({ length: 90 }, (_, index) => `<p>Chunk paragraph ${index} carries bounded reader text ${GRIN} and remains visible.</p>`).join('\n');
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><title>Document reader fixture</title>',
    '<style>.style-secret { color: red; }</style></head><body>',
    '<header><p>Outside-main status ready</p><div aria-hidden="true">Outside-main hidden status</div></header><main>',
    '<h1>Document reader fixture</h1>',
    '<p>Paragraph one ends here.</p>',
    '<p>Paragraph two begins here.</p>',
    '<div id="code-host"><span slot="example">slotted-once</span><span>unassigned-secret</span></div>',
    '<div id="excluded-host" aria-hidden="true"></div>',
    `<script>
      const codeShadow=document.getElementById('code-host').attachShadow({mode:'open'});
      codeShadow.innerHTML='<pre>  fetch(resource)\\n\\t.then(useResponse)</pre><slot name="example"><span id="unused-fallback">unused-fallback-secret</span></slot><slot name="missing">visible-fallback</slot><div aria-hidden="true">shadow-hidden-secret</div><input value="shadow-input-secret"><div id="nested"></div>';
      codeShadow.querySelector('#nested').attachShadow({mode:'open'}).innerHTML='<p>nested-visible</p>';
      document.getElementById('excluded-host').attachShadow({mode:'open'}).innerHTML='<div id="inner">excluded-host-secret</div>';
    </script>`,
    `<p><a href="${targetUrl}">Visible destination label</a></p>`,
    `<pre>  const padded = "  ${GRIN}";\n\treturn padded;\n</pre>`,
    '<div aria-hidden="true">hidden-secret</div>',
    '<script>const scriptSecret = "script-secret";</script>',
    '<form><input name="card" value="input-secret"><textarea autocomplete="one-time-code">one-time-code-secret</textarea></form>',
    repeated,
    `<script>
      // Application overrides must never run as a side effect of a Newton read.
      const nativeGetAttribute=Element.prototype.getAttribute;
      Element.prototype.getAttribute=function(...args){
        document.querySelector('h1').textContent='APPLICATION_OVERRIDE_RAN';
        return nativeGetAttribute.apply(this,args);
      };
      HTMLSlotElement.prototype.assignedNodes=function(){throw Error('APPLICATION_SLOT_OVERRIDE_RAN');};
    </script>`,
    '</main></body></html>',
  ].join('\n');
}

function otherMarkup() {
  return '<!doctype html><html><body><main><h1>New document generation</h1><p>generation changed</p></main></body></html>';
}

async function withFixture(callback) {
  const temp = temporaryRoot('document-reader');
  let server;
  let executor;
  await new Promise((resolve, reject) => {
    server = http.createServer((request, response) => {
      const targetUrl = `http://127.0.0.1:${server.address().port}/target?visible=destination`;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      if (request.url === '/other') return void response.end(otherMarkup());
      if (request.url === '/target?visible=destination') return void response.end('<!doctype html><html><body><main>target</main></body></html>');
      response.end(fixtureMarkup(targetUrl));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const store = openProfileStore(`${temp.root}/identities`);
    const identity = createNewtonIdentity(store, { browserFamily: 'chrome' });
    const executablePath = discoverBrowserExecutable({ family: 'chrome' }).path;
    const connection = await ownedEngineConnection({ executablePath, browserFamily: 'chrome', profileStore: store, identityId: identity.id, ephemeralIdentity: true });
    executor = new PageExecutor(connection);
    const rootUrl = `http://127.0.0.1:${server.address().port}/`;
    const targetUrl = `http://127.0.0.1:${server.address().port}/target?visible=destination`;
    await executor.start(rootUrl);
    await callback({ executor, connection, rootUrl, targetUrl, otherUrl: `http://127.0.0.1:${server.address().port}/other` });
  } finally {
    if (executor) await executor.close();
    await new Promise((resolve) => server.close(resolve));
    temp.remove();
  }
}

async function readDocument(executor, page, maxBytes, cursor) {
  const context = new CommandContext(5000);
  try {
    return await executor.readDocument(context, page, maxBytes, cursor);
  } finally {
    context.dispose();
  }
}

async function navigate(executor, page, url) {
  const context = new CommandContext(5000);
  try {
    return await executor.act(context, page, { kind: 'navigate', url });
  } finally {
    context.dispose();
  }
}

function assertNoBrokenSurrogates(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) assert.ok(index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff, `unpaired high surrogate at ${index}`);
    if (code >= 0xdc00 && code <= 0xdfff) assert.ok(index > 0 && text.charCodeAt(index - 1) >= 0xd800 && text.charCodeAt(index - 1) <= 0xdbff, `unpaired low surrogate at ${index}`);
  }
}

function collectAssertion(failures, label, assertion) {
  try {
    assertion();
  } catch (error) {
    failures.push(`${label}: ${error.code ?? error.name}: ${String(error.message).split('\n', 1)[0]}`);
  }
}

test('document reader preserves structure, links, and excludes non-visible values', async () => {
  await withFixture(async ({ executor, targetUrl }) => {
    const page = executor.bindPage();
    const document = await readDocument(executor, page, 65536);
    const failures = [];
    collectAssertion(failures, 'document state', () => assert.equal(document.state, 'available'));
    collectAssertion(failures, 'document completion', () => assert.equal(document.complete, true));
    collectAssertion(failures, 'isolated native wrappers', () => assert.doesNotMatch(document.text, /APPLICATION_OVERRIDE_RAN/));
    collectAssertion(failures, 'paragraph boundaries', () => assert.match(document.text, /Paragraph one ends here\.[ \t]*\n\s*Paragraph two begins here\./));
    collectAssertion(failures, 'visible link label', () => assert.ok(document.text.includes('Visible destination label'), 'visible link label must be readable'));
    collectAssertion(failures, 'visible link destination', () => assert.ok(document.text.includes(targetUrl), 'visible link destination must be readable'));
    collectAssertion(failures, 'preformatted whitespace', () => assert.ok(document.text.includes(`  const padded = "  ${GRIN}";\n\treturn padded;`), 'preformatted code whitespace must survive'));
    collectAssertion(failures, 'shadow code whitespace', () => assert.ok(document.text.includes('  fetch(resource)\n\t.then(useResponse)')));
    collectAssertion(failures, 'composed slot once', () => assert.equal(document.text.split('slotted-once').length-1,1));
    collectAssertion(failures, 'slot fallback', () => assert.match(document.text,/visible-fallback/));
    collectAssertion(failures, 'nested shadow', () => assert.match(document.text,/nested-visible/));
    for(const secret of ['unassigned-secret','unused-fallback-secret','shadow-hidden-secret','shadow-input-secret'])collectAssertion(failures,`excluded ${secret}`,()=>assert.ok(!document.text.includes(secret)));
    for (const secret of ['hidden-secret', 'script-secret', 'style-secret', 'input-secret', 'one-time-code-secret']) collectAssertion(failures, `excluded ${secret}`, () => assert.doesNotMatch(document.text, new RegExp(secret)));
    assert.equal(failures.length, 0, failures.join('\n'));
  });
});

test('scoped document and frame ownership checks inherit shadow-host exclusions',async()=>{
  await withFixture(async({executor,connection})=>{
    const page=executor.bindPage(),binding=executor.directory.binding(page,1);
    const route=executor.directory.route(binding),contextId=await executor.readonlyWorlds.context(binding);
    const send=(method,params)=>connection.wire.send(method,params,route);
    const objects=[];
    async function resolve(expression){
      const result=await send('Runtime.evaluate',{expression,contextId,throwOnSideEffect:true});
      assert.equal(result.exceptionDetails,undefined);assert.ok(result.result.objectId);
      objects.push(result.result.objectId);return result.result.objectId;
    }
    try{
      const hidden=await resolve("document.querySelector('#excluded-host').shadowRoot.querySelector('#inner')");
      const main=await resolve("document.querySelector('main')");
      const visible=await resolve("document.querySelector('#code-host').shadowRoot.querySelector('pre')");
      const unassigned=await resolve("document.querySelector('#code-host > span:not([slot])')");
      const fallback=await resolve("document.querySelector('#code-host').shadowRoot.querySelector('#unused-fallback')");
      const assigned=await resolve("document.querySelector('#code-host > span[slot]')");
      // Also run the old parentElement-only walk to retain a deterministic repro.
      const old=DOCUMENT_READ_FUNCTION.replace('ancestor=parent(ancestor);','ancestor=ancestor.parentElement;');
      const read=declaration=>send('Runtime.callFunctionOn',{objectId:hidden,functionDeclaration:declaration,arguments:[{value:4096},{value:1000},{value:true}],returnByValue:true});
      const before=await read(old);assert.match(before.result.value.text,/excluded-host-secret/);
      const after=await read(DOCUMENT_READ_FUNCTION);assert.equal(after.exceptionDetails,undefined);
      assert.equal(after.result.value.text,'');assert.equal(after.result.value.excluded,true);
      const legacy=DOCUMENT_READ_FUNCTION.replace('if(unrendered(ancestor)){','if(false){');
      const prior=await send('Runtime.callFunctionOn',{objectId:unassigned,functionDeclaration:legacy,arguments:[{value:4096},{value:1000},{value:true}],returnByValue:true});
      assert.match(prior.result.value.text,/unassigned-secret/);
      for(const [objectId,expected] of [[unassigned,''],[fallback,''],[assigned,'slotted-once']]){
        const result=await send('Runtime.callFunctionOn',{objectId,functionDeclaration:DOCUMENT_READ_FUNCTION,arguments:[{value:4096},{value:1000},{value:true}],returnByValue:true});
        assert.equal(result.exceptionDetails,undefined);assert.equal(result.result.value.text,expected);
      }
      for(const [owner,expected] of [[hidden,false],[visible,true],[unassigned,false],[fallback,false],[assigned,true]]){
        const result=await send('Runtime.callFunctionOn',{objectId:main,functionDeclaration:FRAME_SCOPE_FUNCTION,arguments:[{objectId:owner},{value:true}],returnByValue:true});
        assert.equal(result.exceptionDetails,undefined);assert.equal(result.result.value,expected);
      }
    }finally{for(const objectId of objects)await send('Runtime.releaseObject',{objectId});}
  });
});

test('page text waits include visible content outside main while document reads stay focused',async()=>{
  await withFixture(async({executor})=>{
    const context=new CommandContext(1000),page=executor.bindPage();
    try{
      const document=await readDocument(executor,page,65536);
      assert.ok(!document.text.includes('Outside-main status ready'));
      assert.equal(await executor.waitFact(context,page,{text:'Outside-main status ready'}),true);
      assert.equal(await executor.waitFact(context,page,{text:'Outside-main hidden status'}),false);
    }finally{context.dispose();}
  });
});

test('document reader chunks reconstruct exactly without splitting Unicode', async () => {
  await withFixture(async ({ executor }) => {
    const page = executor.bindPage();
    const complete = await readDocument(executor, page, 65536);
    assert.equal(complete.state, 'available');
    const chunks = [];
    const cursors = new Set();
    let chunk = await readDocument(executor, page, 2048);
    while (true) {
      assert.equal(typeof chunk.text, 'string');
      assertNoBrokenSurrogates(chunk.text);
      assert.ok(Buffer.byteLength(JSON.stringify({resultType:'complete',content:[{type:'text',text:JSON.stringify({observation:chunk,nextCommandId:Number.MAX_SAFE_INTEGER})}]}))<=2048);
      chunks.push(chunk.text);
      if (!chunk.cursor) break;
      assert.ok(!cursors.has(chunk.cursor) && cursors.size < 100, 'continuation must make bounded forward progress');
      cursors.add(chunk.cursor);
      chunk = await readDocument(executor, page, 2048, chunk.cursor);
    }
    assert.ok(chunks.length > 1, 'tiny maxBytes must produce continuation chunks');
    assert.equal(chunks.join(''), complete.text);
  });
});

test('document cursors expire after a document-generation change', async () => {
  await withFixture(async ({ executor, otherUrl }) => {
    const firstPage = executor.bindPage();
    const first = await readDocument(executor, firstPage, 2048);
    assert.equal(first.state, 'incomplete');
    assert.match(first.cursor ?? '', /^doc:d[1-9][0-9]*:[0-9]+$/);
    assert.deepEqual(await navigate(executor, executor.bindPage(), otherUrl), { state: 'met', kind: 'navigation' });
    const changedPage = executor.bindPage();
    await assert.rejects(() => readDocument(executor, changedPage, 2048, first.cursor), (error) => error?.code === 'cursor_expired');
  });
});
