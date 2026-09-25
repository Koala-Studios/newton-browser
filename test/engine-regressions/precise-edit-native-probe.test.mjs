import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {temporaryRoot} from '../../scripts/prototypes/support.mjs';
import {discoverBrowserExecutable} from '../../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import {createNewtonIdentity,openProfileStore} from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
import {ownedEngineConnection} from '../../apps/mcp-server/src/browser-runtime/engine-host.ts';
import {PageExecutor} from '../../packages/driver/src/page-executor.ts';
import {CommandContext} from '../../packages/driver/src/command-context.ts';

async function setup(t){
  const browser=discoverBrowserExecutable({family:'chrome',env:process.env});
  if(!browser){t.skip('Chrome unavailable');return null;}
  const temporary=temporaryRoot('precise-edit-native-probe'),store=openProfileStore(`${temporary.root}/identities`),identity=createNewtonIdentity(store,{browserFamily:'chrome'});
  const server=http.createServer((_request,response)=>{
    response.setHeader('content-type','text/html; charset=utf-8');
    response.end(`<!doctype html><html><body>
      <input id="input" value="left-middle-right">
      <input id="emoji" value="a😀b😀c">
      <textarea id="textarea">line-one-middle-line</textarea>
      <textarea id="lines">one
middle
two</textarea>
      <div id="editable" contenteditable="true">before-middle-after</div>
      <div id="repeated" contenteditable="true">same same same</div>
      <input id="focus-target" value="focus-target">
      <pre id="events"></pre>
      <script>
        for(const id of ['input','emoji','textarea','lines','editable','repeated','focus-target']){
          const node=document.getElementById(id);
          for(const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input'])node.addEventListener(type,event=>{
            document.querySelector('#events').textContent += id+':'+type+':'+event.isTrusted+':'+(event.inputType||'')+'|';
          });
        }
      </script>
    </body></html>`);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  let executor;
  try{
    const connection=await ownedEngineConnection({executablePath:browser.path,browserFamily:'chrome',profileStore:store,identityId:identity.id,ephemeralIdentity:true,headless:true});
    executor=new PageExecutor(connection);await executor.start(`http://127.0.0.1:${server.address().port}/`);
    return {connection,executor,temporary,server};
  }catch(error){
    await new Promise(resolve=>server.close(resolve));temporary.remove();throw error;
  }
}

async function backendNode(connection,executor,selector){
  const page=executor.bindPage(),binding=executor.directory.binding(page,1),route=executor.directory.route(binding);
  const document=await connection.wire.send('DOM.getDocument',{depth:0},route);
  const selected=await connection.wire.send('DOM.querySelector',{nodeId:document.root.nodeId,selector},route);
  assert.ok(selected.nodeId);
  const described=await connection.wire.send('DOM.describeNode',{nodeId:selected.nodeId},route);
  assert.ok(described.node?.backendNodeId);
  return {backendNodeId:described.node.backendNodeId,route};
}

async function state(connection,executor){
  const page=executor.bindPage(),binding=executor.directory.binding(page,1),route=executor.directory.route(binding);
  const result=await connection.wire.send('Runtime.evaluate',{expression:`({input:document.querySelector('#input').value,emoji:document.querySelector('#emoji').value,textarea:document.querySelector('#textarea').value,lines:document.querySelector('#lines').value,editable:document.querySelector('#editable').textContent,repeated:document.querySelector('#repeated').textContent,active:document.activeElement?.id||'',events:document.querySelector('#events').textContent})`,returnByValue:true},route);
  return result.result.value;
}

test('native precise-edit feasibility uses IME replacement and insertText on input textarea and contenteditable',async t=>{
  const setupState=await setup(t);if(!setupState)return;
  const {connection,executor,temporary,server}=setupState;
  try{
    const targets={input:await backendNode(connection,executor,'#input'),textarea:await backendNode(connection,executor,'#textarea'),editable:await backendNode(connection,executor,'#editable')};
    const ranges={input:[5,11],textarea:[9,15],editable:[7,13]};
    const expected={input:'left-界-right',textarea:'line-one-界-line',editable:'before-界-after'};
    for(const [name,target] of Object.entries(targets)){
      await connection.wire.send('DOM.focus',{backendNodeId:target.backendNodeId},target.route);
      const [replacementStart,replacementEnd]=ranges[name];
      await connection.wire.send('Input.imeSetComposition',{text:'Ω',selectionStart:1,selectionEnd:1,replacementStart,replacementEnd},target.route);
      await connection.wire.send('Input.insertText',{text:'界'},target.route);
      const current=await state(connection,executor);
      const value=current[name==='editable'?'editable':name];
      assert.equal(value,expected[name]);
    }
    const current=await state(connection,executor);
    assert.match(current.events,/input:input:true/);
    assert.match(current.events,/textarea:input:true/);
    assert.match(current.events,/editable:input:true/);
    assert.match(current.events,/composition/);
  }finally{
    await executor.close();await new Promise(resolve=>server.close(resolve));temporary.remove();
  }
});

test('native precise-edit cancellation prevents a queued insertText effect',async t=>{
  const setupState=await setup(t);if(!setupState)return;
  const {connection,executor,temporary,server}=setupState;
  try{
    const target=await backendNode(connection,executor,'#input');
    const before=await state(connection,executor);
    const context=new CommandContext(5000);context.cancel();
    await assert.rejects(context.input(()=>connection.wire.send('Input.insertText',{text:'must-not-appear'},target.route)),error=>error?.code==='cancelled');
    context.dispose();
    const after=await state(connection,executor);
    assert.equal(after.input,before.input);
    assert.equal(after.events,before.events);
  }finally{
    await executor.close();await new Promise(resolve=>server.close(resolve));temporary.remove();
  }
});

test('native precise-edit covers deletion, emoji boundaries, line endings, repeated content and composition cancellation',async t=>{
  const setupState=await setup(t);if(!setupState)return;
  const {connection,executor,temporary,server}=setupState;
  try{
    const targets={input:await backendNode(connection,executor,'#input'),emoji:await backendNode(connection,executor,'#emoji'),lines:await backendNode(connection,executor,'#lines'),repeated:await backendNode(connection,executor,'#repeated'),focus:await backendNode(connection,executor,'#focus-target')};
    await connection.wire.send('DOM.focus',{backendNodeId:targets.input.backendNodeId},targets.input.route);
    await connection.wire.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0,replacementStart:5,replacementEnd:11},targets.input.route);
    assert.equal((await state(connection,executor)).input,'left--right');

    await connection.wire.send('DOM.focus',{backendNodeId:targets.emoji.backendNodeId},targets.emoji.route);
    await connection.wire.send('Input.imeSetComposition',{text:'Ω',selectionStart:1,selectionEnd:1,replacementStart:1,replacementEnd:3},targets.emoji.route);
    await connection.wire.send('Input.insertText',{text:'X'},targets.emoji.route);
    assert.equal((await state(connection,executor)).emoji,'aXb😀c');

    await connection.wire.send('DOM.focus',{backendNodeId:targets.lines.backendNodeId},targets.lines.route);
    await connection.wire.send('Input.imeSetComposition',{text:'Ω',selectionStart:1,selectionEnd:1,replacementStart:4,replacementEnd:10},targets.lines.route);
    await connection.wire.send('Input.insertText',{text:'middle'},targets.lines.route);
    assert.equal((await state(connection,executor)).lines,'one\nmiddle\ntwo');

    await connection.wire.send('DOM.focus',{backendNodeId:targets.repeated.backendNodeId},targets.repeated.route);
    await connection.wire.send('Input.imeSetComposition',{text:'Ω',selectionStart:1,selectionEnd:1,replacementStart:5,replacementEnd:9},targets.repeated.route);
    await connection.wire.send('Input.insertText',{text:'DIFF'},targets.repeated.route);
    assert.equal((await state(connection,executor)).repeated,'same DIFF same');

    await connection.wire.send('DOM.focus',{backendNodeId:targets.input.backendNodeId},targets.input.route);
    await connection.wire.send('Input.imeSetComposition',{text:'Ω',selectionStart:1,selectionEnd:1,replacementStart:5,replacementEnd:5},targets.input.route);
    await connection.wire.send('DOM.focus',{backendNodeId:targets.focus.backendNodeId},targets.focus.route);
    const moved=await state(connection,executor);
    assert.equal(moved.active,'focus-target');
    assert.equal(moved.input,'left-Ω-right');
    assert.match(moved.events,/input:compositionstart:true/);
    assert.match(moved.events,/input:compositionend:(?:true|false)/);
    assert.match(moved.events,/input:input:true/);
  }finally{
    await executor.close();await new Promise(resolve=>server.close(resolve));temporary.remove();
  }
});
