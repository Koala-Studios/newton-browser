import assert from 'node:assert/strict';
import test from 'node:test';
import {CommandContext} from '../src/command-context.ts';
import {nativeSensitiveRegions} from '../src/native-sensitive-regions.ts';
import {PageDirectory} from '../src/page-directory.ts';
import {ReadonlyWorlds} from '../src/readonly-world.ts';

const BORDER=[0,0,1,0,1,1,0,1];

function deferred(){
  let resolve,reject;
  const promise=new Promise((nextResolve,nextReject)=>{resolve=nextResolve;reject=nextReject;});
  return {promise,resolve,reject};
}

function fixture({overrides={},withChild=false,childRoute='root-route',childFrameId='child',extraFrames=[]}={}){
  const directory=new PageDirectory('epoch');
  directory.registerRoute('root-route');
  directory.addPage('page');
  directory.navigate('page',{frameId:'root',route:'root-route',loaderId:'root'});
  if(withChild){
    directory.registerRoute(childRoute);
    directory.navigate('page',{frameId:childFrameId,parentId:'root',route:childRoute,loaderId:'child'});
  }
  for(const frame of extraFrames){
    directory.registerRoute(frame.route);
    directory.navigate('page',frame);
  }
  const calls=[];
  const defaults={
    'DOM.getDocument':{},
    'Page.createIsolatedWorld':{executionContextId:7},
    'DOM.performSearch':{searchId:'search-1',resultCount:1},
    'DOM.getSearchResults':{nodeIds:[11]},
    'DOM.resolveNode':{object:{objectId:'object-1'}},
    'Runtime.callFunctionOn':{result:{value:true}},
    'DOM.getBoxModel':{model:{border:BORDER}},
    'Runtime.releaseObject':{},
    'DOM.discardSearchResults':{},
  };
  const wire={
    async send(method,params={},sessionId){
      calls.push({method,params,sessionId});
      const override=overrides[method];
      if(typeof override==='function')return override({method,params,sessionId,calls,directory});
      if(override!==undefined)return override;
      return defaults[method]??{};
    },
  };
  const worlds=new ReadonlyWorlds(directory,wire);
  const context=new CommandContext(10_000);
  return {calls,context,directory,page:directory.stamp('page'),wire,worlds};
}

async function read(state){
  return nativeSensitiveRegions(state.context,state.directory,state.worlds,state.wire,state.page);
}

async function flushCleanup(){
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForCall(state,method,limit=100){
  for(let attempt=0;attempt<limit;attempt++){
    if(methods(state,method).length)return;
    await Promise.resolve();
  }
  throw new Error(`timed out waiting for ${method}`);
}

function methods(state,method){
  return state.calls.filter(call=>call.method===method);
}

const perNode={
  'DOM.resolveNode':({params})=>({object:{objectId:`object-${params.nodeId}`}}),
};
const results=(count,offset=1)=>({nodeIds:Array.from({length:count},(_,index)=>index+offset)});

test('only visible fields count toward the limit; the page document past it refuses',async()=>{
  // 40 candidates (hidden payment and code inputs among them), two of them shown.
  const hidden=fixture({overrides:{...perNode,'DOM.performSearch':{searchId:'many',resultCount:40},'DOM.getSearchResults':results(40),
    'Runtime.callFunctionOn':({params})=>({result:{value:['object-1','object-2'].includes(params.objectId)}})}});
  try{assert.equal((await read(hidden)).regions.length,2);}finally{hidden.context.dispose();}
  const shown=fixture({overrides:{...perNode,'DOM.performSearch':{searchId:'shown',resultCount:33},'DOM.getSearchResults':results(33)}});
  try{
    await assert.rejects(read(shown),error=>error?.code==='work_limit');
    await flushCleanup();
    assert.deepEqual(methods(shown,'DOM.discardSearchResults').map(call=>call.params),[{searchId:'shown'}]);
  }finally{shown.context.dispose();}
  // Past the examination budget the page document refuses before reading any node.
  const flood=fixture({overrides:{'DOM.performSearch':{searchId:'flood',resultCount:300}}});
  try{
    await assert.rejects(read(flood),error=>error?.code==='work_limit');
    await flushCleanup();
    assert.equal(methods(flood,'DOM.getSearchResults').length,0);
    assert.deepEqual(methods(flood,'DOM.discardSearchResults').map(call=>call.params),[{searchId:'flood'}]);
  }finally{flood.context.dispose();}
});

function childBudget({rootCount=20,childCount=13}={}){
  return {...crossProcessOverrides(),...perNode,
    'DOM.performSearch':({sessionId})=>sessionId==='root-route'?{searchId:'root-search',resultCount:rootCount}:{searchId:'child-search',resultCount:childCount},
    'DOM.getSearchResults':({sessionId})=>sessionId==='root-route'?results(rootCount):results(childCount,101)};
}

test('a cross-site child frame past a budget is masked whole instead of refusing the capture',async()=>{
  const owner={x:10,y:20,width:100,height:100};
  for(const [label,options] of [['visible limit',{rootCount:20,childCount:13}],['examination budget',{rootCount:2,childCount:300}]]){
    const state=fixture({withChild:true,childRoute:'child-route',childFrameId:'z-child',overrides:childBudget(options)});
    try{
      const {regions}=await read(state);
      assert.equal(regions.length,options.rootCount+1,label);
      assert.deepEqual(regions.at(-1),owner,`${label}: the frame's whole box`);
      await flushCleanup();
      assert.deepEqual(methods(state,'DOM.discardSearchResults').map(call=>call.params.searchId).sort(),['child-search','root-search'],label);
      if(options.childCount>256)assert.deepEqual(methods(state,'DOM.getSearchResults').map(call=>call.sessionId),['root-route'],label);
    }finally{state.context.dispose();}
  }
});

test('fields and frames outside the clip do not count',async()=>{
  // 33 shown fields at the page's top-left and a child frame with 13, all outside a clip further down.
  const state=fixture({withChild:true,childRoute:'child-route',childFrameId:'z-child',overrides:childBudget({rootCount:33,childCount:13})});
  try{
    const {regions}=await nativeSensitiveRegions(state.context,state.directory,state.worlds,state.wire,state.page,{x:400,y:400,width:200,height:200});
    assert.deepEqual(regions,[]);
    assert.deepEqual(methods(state,'DOM.getSearchResults').map(call=>call.sessionId),['root-route'],'the child outside the clip is not read');
  }finally{state.context.dispose();}
});

test('successful and failed node reads release remote objects and discard searches',async()=>{
  for(const [label,overrides,expected] of [
    ['success',{},'success'],
    ['visibility error',{'Runtime.callFunctionOn':{exceptionDetails:{text:'blocked'}}},'error'],
  ]){
    const state=fixture({overrides});
    try{
      if(expected==='success')assert.equal((await read(state)).regions.length,1);
      else await assert.rejects(read(state),error=>error?.code==='evidence_unavailable',label);
      await flushCleanup();
      assert.deepEqual(methods(state,'Runtime.releaseObject').map(call=>call.params),[{objectId:'object-1'}],label);
      assert.deepEqual(methods(state,'DOM.discardSearchResults').map(call=>call.params),[{searchId:'search-1'}],label);
    }finally{state.context.dispose();}
  }
});

test('late search and remote-object responses after cancellation are still cleaned up',async()=>{
  const search=deferred();
  const searchState=fixture({overrides:{'DOM.performSearch':()=>search.promise}});
  try{
    const running=read(searchState);
    await waitForCall(searchState,'DOM.performSearch');
    searchState.context.cancel();
    await assert.rejects(running,error=>error?.code==='cancelled');
    search.resolve({searchId:'late-search',resultCount:0});
    await flushCleanup();
    assert.deepEqual(methods(searchState,'DOM.discardSearchResults').map(call=>call.params),[{searchId:'late-search'}]);
  }finally{searchState.context.dispose();}

  const remote=deferred();
  const remoteState=fixture({overrides:{'DOM.resolveNode':()=>remote.promise}});
  try{
    const running=read(remoteState);
    await waitForCall(remoteState,'DOM.resolveNode');
    remoteState.context.cancel();
    await assert.rejects(running,error=>error?.code==='cancelled');
    remote.resolve({object:{objectId:'late-object'}});
    await flushCleanup();
    assert.deepEqual(methods(remoteState,'Runtime.releaseObject').map(call=>call.params),[{objectId:'late-object'}]);
    assert.deepEqual(methods(remoteState,'DOM.discardSearchResults').map(call=>call.params),[{searchId:'search-1'}]);
  }finally{remoteState.context.dispose();}
});

test('invalid identifiers, execution contexts, and geometry refuse evidence',async()=>{
  const cases=[
    ['empty search id',{'DOM.performSearch':{searchId:'',resultCount:1}}],
    ['non-integer result count',{'DOM.performSearch':{searchId:'search-1',resultCount:1.5}}],
    ['invalid node id',{'DOM.getSearchResults':{nodeIds:[0]}}],
    ['invalid execution context',{'Page.createIsolatedWorld':{executionContextId:0}}],
    ['missing remote object id',{'DOM.resolveNode':{object:{}}}],
    ['missing geometry',{'DOM.getBoxModel':{model:{}}}],
  ];
  for(const [label,overrides] of cases){
    const state=fixture({overrides});
    try{
      await assert.rejects(read(state),error=>error?.code==='evidence_unavailable',label);
      await flushCleanup();
    }finally{state.context.dispose();}
  }
});

test('frame removal, navigation, and new membership during the read refuse stale evidence',async()=>{
  const cases=[
    ['frame removal',true,({directory})=>directory.detachFrame('page','child','root-route')],
    ['root navigation',false,({directory})=>directory.navigate('page',{frameId:'root',route:'root-route',loaderId:'new-root'})],
    ['new frame membership',false,({directory})=>directory.navigate('page',{frameId:'child',parentId:'root',route:'root-route',loaderId:'child'})],
  ];
  for(const [label,withChild,mutate] of cases){
    let changed=false;
    const state=fixture({withChild,overrides:{'DOM.getBoxModel':args=>{
      const result={model:{border:BORDER}};
      if(!changed){changed=true;mutate(args);}
      return result;
    }}});
    try{
      await assert.rejects(read(state),error=>error?.code==='stale_target',label);
      assert.equal(changed,true,label);
    }finally{state.context.dispose();}
  }
});

function crossProcessOverrides({activeRoute='child-route',fieldQuad=BORDER,ownerContent={'root-route':[10,20,110,20,110,120,10,120]},sizeByRoute={},mutate}={}){
  return {
    'DOM.performSearch':({sessionId})=>sessionId===activeRoute
      ?{searchId:`${activeRoute}-search`,resultCount:1}
      :{searchId:`${sessionId}-search`,resultCount:0},
    'DOM.getSearchResults':{nodeIds:[11]},
    'DOM.getFrameOwner':({sessionId,params,directory})=>{
      if(mutate)mutate({method:'DOM.getFrameOwner',sessionId,params,directory});
      return {backendNodeId:params.frameId==='grandchild'?102:101};
    },
    'DOM.getBoxModel':({sessionId,params,directory})=>{
      if(mutate)mutate({method:'DOM.getBoxModel',sessionId,params,directory});
      if(params.backendNodeId!==undefined)return {model:{content:ownerContent[sessionId]}};
      return {model:{border:fieldQuad}};
    },
    'Runtime.evaluate':({sessionId,params,directory})=>{
      if(mutate)mutate({method:'Runtime.evaluate',sessionId,params,directory});
      const size=sizeByRoute[sessionId]??{width:100,height:100};
      return {result:{value:size}};
    },
  };
}

test('cross-process field geometry is projected through nested route owners',async()=>{
  const state=fixture({
    withChild:true,
    childRoute:'child-route',
    extraFrames:[{frameId:'grandchild',parentId:'child',route:'grandchild-route',loaderId:'grandchild'}],
    overrides:crossProcessOverrides({
      activeRoute:'grandchild-route',
      fieldQuad:[0,0,10,0,10,10,0,10],
      ownerContent:{
        'root-route':[10,10,110,10,110,110,10,110],
        'child-route':[20,20,120,20,120,120,20,120],
      },
    }),
  });
  try{
    const result=await read(state);
    assert.deepEqual(result.regions,[{x:30,y:30,width:10,height:10}]);
  }finally{state.context.dispose();}
});

test('partially clipped and fully outside child fields do not produce outside regions',async()=>{
  for(const [label,fieldQuad,expected] of [
    ['partially clipped',[-10,20,50,20,50,60,-10,60],[{x:10,y:40,width:50,height:40}]],
    ['fully outside',[-20,10,-10,10,-10,20,-20,20],[]],
  ]){
    const state=fixture({withChild:true,childRoute:'child-route',overrides:crossProcessOverrides({fieldQuad})});
    try{
      const result=await read(state);
      assert.deepEqual(result.regions,expected,label);
    }finally{state.context.dispose();}
  }
});

test('invalid owner geometry and child size refuse cross-process transforms',async()=>{
  const cases=[
    ['invalid owner quad',{ownerContent:{'root-route':[0,0]} }],
    ['invalid child size',{sizeByRoute:{'child-route':{width:0,height:100}}}],
  ];
  for(const [label,options] of cases){
    const state=fixture({withChild:true,childRoute:'child-route',overrides:crossProcessOverrides(options)});
    try{await assert.rejects(read(state),error=>error?.code==='evidence_unavailable',label);}
    finally{state.context.dispose();}
  }
});

test('stale parent or child during cross-process transform refuses evidence',async()=>{
  const cases=[
    ['stale parent','DOM.getFrameOwner',({directory})=>directory.navigate('page',{frameId:'root',route:'root-route',loaderId:'new-root'})],
    ['stale child','Runtime.evaluate',({directory})=>directory.navigate('page',{frameId:'child',route:'child-route',loaderId:'new-child'})],
  ];
  for(const [label,trigger,mutate] of cases){
    const state=fixture({withChild:true,childRoute:'child-route',overrides:crossProcessOverrides({mutate:args=>{
      if(args.method===trigger)mutate(args);
    }})});
    try{await assert.rejects(read(state),error=>error?.code==='stale_target',label);}
    finally{state.context.dispose();}
  }
});

test('a frame whose owner renders no box (a hidden payment or wallet frame) is passed over, not refused',async()=>{
  const noBox=()=>{throw new Error('CDP command failed.: Could not compute box model.');};
  // The owner check answers whether the owner's box is empty; field visibility checks answer true.
  const owner=(rendered)=>({params})=>params.functionDeclaration.startsWith('function(){const rect')?{result:{value:!rendered}}:{result:{value:true}};
  const base=crossProcessOverrides();
  const boxModel=({params,...rest})=>params.backendNodeId!==undefined?noBox():base['DOM.getBoxModel']({params,...rest});
  const hidden=fixture({withChild:true,childRoute:'child-route',overrides:{...base,'DOM.getBoxModel':boxModel,'Runtime.callFunctionOn':owner(false)}});
  try{
    assert.deepEqual((await read(hidden)).regions,[]);
    await flushCleanup();
    assert.equal(methods(hidden,'Runtime.releaseObject').length,methods(hidden,'DOM.resolveNode').length,'every resolved owner is released');
    assert.equal(methods(hidden,'Runtime.evaluate').length,0,'a hidden frame needs no size read');
  }finally{hidden.context.dispose();}
  // An owner that has a box yet no box model is not proven hidden: the capture still refuses.
  const unproven=fixture({withChild:true,childRoute:'child-route',overrides:{...base,'DOM.getBoxModel':boxModel,'Runtime.callFunctionOn':owner(true)}});
  try{await assert.rejects(read(unproven),error=>/box model/.test(error?.message));}finally{unproven.context.dispose();}
  // A zero-area owner (a 0x0 frame) shows nothing either.
  const empty=fixture({withChild:true,childRoute:'child-route',overrides:crossProcessOverrides({ownerContent:{'root-route':[10,20,10,20,10,20,10,20]}})});
  try{assert.deepEqual((await read(empty)).regions,[]);}finally{empty.context.dispose();}
});
