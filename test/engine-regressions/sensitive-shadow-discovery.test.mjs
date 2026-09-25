import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {inflateSync} from 'node:zlib';
import {temporaryRoot} from '../../scripts/prototypes/support.mjs';
import {discoverBrowserExecutable} from '../../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import {createNewtonIdentity,openProfileStore} from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
import {ownedEngineConnection} from '../../apps/mcp-server/src/browser-runtime/engine-host.ts';
import {PageExecutor} from '../../packages/driver/src/page-executor.ts';
import {projectFrameMaskQuad} from '../../packages/driver/src/frame-mask-geometry.ts';
import {CommandContext} from '../../packages/driver/src/command-context.ts';

test('native DOM search can locate sensitive geometry inside closed shadow roots',async t=>{
  const browser=discoverBrowserExecutable({family:'chrome',env:process.env});
  if(!browser){t.skip('Chrome unavailable');return;}
  const root=temporaryRoot('sensitive-shadow-discovery');
  const store=openProfileStore(`${root.root}/identities`);
  const identity=createNewtonIdentity(store,{browserFamily:'chrome'});
  const fixture=http.createServer((request,response)=>{
    response.setHeader('content-type','text/html');
    if(request.url==='/plain'){response.end('<!doctype html><title>Plain screenshot</title><p>Ordinary page without sensitive controls.</p>');return;}
    if(request.url==='/frame'){
      response.end('<!doctype html><input type=password style="position:absolute;left:10px;top:15px;width:80px;height:20px">');return;
    }
    response.end(`<!doctype html><title>Closed shadow geometry</title>
      <input id=root-secret type=password style="position:absolute;left:20px;top:30px;width:80px;height:20px">
      <iframe src=/frame style="position:absolute;left:300px;top:200px;width:200px;height:100px;border:0"></iframe>
      <iframe src="http://localhost:${fixture.address().port}/frame" style="position:absolute;left:300px;top:330px;width:200px;height:100px;border:0"></iframe>
      <div id=host></div><script>
      const shadow=document.querySelector('#host').attachShadow({mode:'closed'});
      shadow.innerHTML='<input autocomplete="one-time-code" style="position:absolute;left:150px;top:90px;width:80px;height:20px">';
      </script>`);
  });
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
  let executor;
  try{
    const connection=await ownedEngineConnection({executablePath:browser.path,browserFamily:'chrome',profileStore:store,identityId:identity.id,ephemeralIdentity:true,headless:true});
    executor=new PageExecutor(connection);
    await executor.start(`http://127.0.0.1:${fixture.address().port}/`);
    const page=executor.bindPage(),binding=executor.directory.binding(page,1);
    const send=(method,params)=>connection.wire.send(method,params,executor.directory.route(binding));
    await send('Runtime.evaluate',{expression:"document.readyState==='complete'?true:new Promise(resolve=>addEventListener('load',()=>resolve(true),{once:true}))",awaitPromise:true,returnByValue:true});
    await send('DOM.getDocument',{depth:0});
    const search=await send('DOM.performSearch',{query:'input[type="password" i], [autocomplete*="one-time-code" i]',includeUserAgentShadowDOM:true});
    try{
      assert.equal(search.resultCount,3,'ordinary, closed-shadow and same-process frame fields must be discoverable');
      const result=await send('DOM.getSearchResults',{searchId:search.searchId,fromIndex:0,toIndex:search.resultCount});
      const boxes=[],borderBoxes=[];
      for(const nodeId of result.nodeIds){
        const resolved=await send('DOM.resolveNode',{nodeId});
        const objectId=resolved.object.objectId;
        try{
          const geometry=await send('Runtime.callFunctionOn',{objectId,functionDeclaration:'function(){const r=this.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}',returnByValue:true,silent:true,throwOnSideEffect:true});
          assert.equal(geometry.exceptionDetails,undefined);
          boxes.push(geometry.result.value);
          const model=await send('DOM.getBoxModel',{nodeId});
          borderBoxes.push(model.model.border);
        }finally{await send('Runtime.releaseObject',{objectId});}
      }
      assert.deepEqual(boxes.map(box=>[box.x,box.y]).sort((a,b)=>a[0]-b[0]),[[10,15],[20,30],[150,90]]);
      assert.deepEqual(borderBoxes.map(quad=>[quad[0],quad[1]]).sort((a,b)=>a[0]-b[0]),[[20,30],[150,90],[310,215]]);
      assert.ok(boxes.every(box=>box.width>0&&box.height>0));
      console.log('closed-shadow geometry evidence',JSON.stringify({count:search.resultCount,boxes,borderBoxes}));
    }finally{await send('DOM.discardSearchResults',{searchId:search.searchId});}
    const frames=executor.directory.frames(page.pageId);
    const rootRoute=executor.directory.route(binding);
    const remote=frames.find(frame=>executor.directory.route(executor.directory.binding(frame,1))!==rootRoute);
    assert.ok(remote,'cross-site iframe must have an independent CDP route');
    const remoteBinding=executor.directory.binding(remote,1);
    const remoteSend=(method,params)=>connection.wire.send(method,params,executor.directory.route(remoteBinding));
    await remoteSend('DOM.getDocument',{depth:0});
    const remoteSearch=await remoteSend('DOM.performSearch',{query:'input[type="password" i]',includeUserAgentShadowDOM:true});
    try{
      assert.equal(remoteSearch.resultCount,1);
      const result=await remoteSend('DOM.getSearchResults',{searchId:remoteSearch.searchId,fromIndex:0,toIndex:1});
      const childBox=await remoteSend('DOM.getBoxModel',{nodeId:result.nodeIds[0]});
      const owner=await send('DOM.getFrameOwner',{frameId:remote.frameId});
      const ownerBox=await send('DOM.getBoxModel',{backendNodeId:owner.backendNodeId});
      assert.deepEqual(childBox.model.border,[10,15,98,15,98,41,10,41]);
      assert.deepEqual(ownerBox.model.content,[300,330,500,330,500,430,300,430]);
      assert.deepEqual(projectFrameMaskQuad(childBox.model.border,ownerBox.model.content,200,100),[310,345,398,345,398,371,310,371]);
      console.log('cross-site geometry evidence',JSON.stringify({childBorder:childBox.model.border,ownerContent:ownerBox.model.content}));
    }finally{await remoteSend('DOM.discardSearchResults',{searchId:remoteSearch.searchId});}
    const captureContext=new CommandContext(5000);
    try{
      const captured=await executor.screenshot(captureContext,page,65536,{});
      const png=Buffer.from(captured.imageData,'base64'),width=png.readUInt32BE(16),height=png.readUInt32BE(20),idat=[];
      for(let offset=8;offset<png.length;){const length=png.readUInt32BE(offset),type=png.toString('ascii',offset+4,offset+8);if(type==='IDAT')idat.push(png.subarray(offset+8,offset+8+length));offset+=length+12;}
      const channels=png[25]===6?4:3,pixels=inflateSync(Buffer.concat(idat)),stride=width*channels+1;
      for(const [x,y] of [[25,35],[155,95],[315,220],[315,350]]){
        assert.ok(x<width&&y<height);assert.equal(pixels[y*stride],0);
        assert.deepEqual([...pixels.subarray(y*stride+1+x*channels,y*stride+1+x*channels+3)],[0,0,0],`sensitive pixel at ${x},${y}`);
      }
      assert.deepEqual([...pixels.subarray(150*stride+1+250*channels,150*stride+1+250*channels+3)],[255,255,255],'neighbor remains visible');
      console.log('production sensitive mask evidence',JSON.stringify({width,height,verifiedSensitivePixels:4,neighborUnchanged:true}));
    }finally{captureContext.dispose();}
    const plainContext=new CommandContext(5000);
    try{
      await executor.act(plainContext,page,{kind:'navigate',url:`http://127.0.0.1:${fixture.address().port}/plain`});
      const plain=await executor.screenshot(plainContext,executor.bindPage(),65536,{});
      assert.equal(plain.provenance.maskDisposition,'mask_not_applicable');
      assert.ok(Buffer.from(plain.imageData,'base64').readUInt32BE(16)>0);
      console.log('plain screenshot evidence',JSON.stringify({automaticDiscovery:true,maskDisposition:plain.provenance.maskDisposition}));
    }finally{plainContext.dispose();}
  }finally{
    if(executor)await executor.close();
    await new Promise(resolve=>fixture.close(resolve));
    root.remove();
  }
});
