import assert from 'node:assert/strict';
import test from 'node:test';
import {PageExecutor} from '../src/page-executor.ts';
import {CommandContext} from '../src/command-context.ts';

for(const timing of ['before_child','after_child','root'])test('observation preserves only current frame results: '+timing,async()=>{
  let executor;
  const wire={onEvent:()=>()=>{},send:async(method,params)=>{
    assert.equal(method,'Accessibility.getFullAXTree');
    if(params.frameId===(timing==='after_child'?'last':'root')){
      executor.directory.navigate('page',{frameId:timing==='root'?'root':'child',...(timing==='root'?{}:{parentId:'root'}),route:'route',loaderId:'changed'});
    }
    return {nodes:[{nodeId:params.frameId,backendDOMNodeId:params.frameId==='root'?2:params.frameId==='child'?3:4,role:{value:'button'},name:{value:params.frameId}}]};
  }};
  executor=new PageExecutor({epoch:'test',claimGeneration:1,rootTargetId:'page',signal:new AbortController().signal,wire});
  executor.directory.addPage('page');executor.directory.registerRoute('route');
  for(const frameId of ['root','child','last'])executor.directory.navigate('page',{frameId,...(frameId==='root'?{}:{parentId:'root'}),route:'route',loaderId:'original'});
  const page=executor.bindPage(),context=new CommandContext(1000);
  try{
    if(timing==='root'){await assert.rejects(executor.observe(context,page,8192),{code:'stale_target'});return;}
    const observation=await executor.observe(context,page,8192);
    assert.equal(observation.state,'incomplete');
    assert.equal(observation.incompleteReason,'rendered_subset');
    assert.deepEqual(observation.nodes.map(node=>node.name),['root','last']);
    for(const node of observation.nodes)assert.doesNotThrow(()=>executor.directory.resolve(node.ref,page.pageId));
    assert.deepEqual(observation.page,page);
  }finally{context.dispose();}
});
