import test from 'node:test';
import assert from 'node:assert/strict';
import { PageExecutor } from '../src/page-executor.ts';
import { CommandContext } from '../src/command-context.ts';

test('navigation chrome cannot crowd search controls out of the compact initial view',async()=>{
  const raw=[{role:{value:'RootWebArea'},name:{value:'A page'},properties:[{name:'url',value:{value:'https://example.test/'}}]},
    ...Array.from({length:200},(_,i)=>({backendDOMNodeId:i+2,role:{value:'link'},name:{value:`Navigation link ${i}`},properties:[]})),
    {backendDOMNodeId:500,role:{value:'searchbox'},name:{value:'Search this site'},properties:[]}].map((node,i)=>({...node,nodeId:String(i+1)}));
  const executor=new PageExecutor({rootTargetId:'p1',epoch:'epoch',claimGeneration:1,signal:new AbortController().signal,close:async()=>{},
    wire:{onEvent:()=>()=>{},send:async method=>{assert.equal(method,'Accessibility.getFullAXTree');return {nodes:raw};}}});
  executor.directory.addPage('p1');executor.directory.registerRoute('route');executor.directory.navigate('p1',{frameId:'f1',route:'route',loaderId:'loader'});
  const context=new CommandContext(1000);
  try{
    const observation=await executor.observe(context,executor.bindPage(),8192);
    assert.equal(observation.nodes[0].role,'searchbox');assert.equal(observation.nodes[0].name,'Search this site');
    assert.ok(observation.nodes.every(node=>node.recordId===undefined));
    assert.equal(observation.url,'https://example.test/');assert.equal(observation.state,'incomplete');
    const records=await executor.observe(context,executor.bindPage(),8192,true);
    assert.match(records.nodes[0].recordId,/^n[0-9a-f]{32}$/);
    assert.ok(Buffer.byteLength(JSON.stringify({resultType:'complete',content:[{type:'text',text:JSON.stringify({observation,nextCommandId:1})}]}))<=8192);
  }finally{context.dispose();await executor.close();}
});
