import type {NativeClient} from './native-client.ts';
import type {EngineConnection,EngineWire} from '@newton-browser/driver/connection';

type Token={tabId:number;epoch:string;generation:number};
type Value=Record<string,unknown>;
type Event=Parameters<Parameters<EngineWire['onEvent']>[0]>[0];
function token(value:unknown,epoch:string):Token|undefined{
  if(!value||typeof value!=='object')return;
  const candidate=value as Token;
  if(candidate.epoch===epoch&&Number.isSafeInteger(candidate.tabId)&&candidate.tabId>0&&Number.isSafeInteger(candidate.generation)&&candidate.generation>0)return {tabId:candidate.tabId,epoch,generation:candidate.generation};
}
/** One native owner, multiple explicitly owned debugger claims. Only the trusted
 * adapter's opener-attributed events can add a page; arbitrary target IDs cannot. */
export function existingPageConnection(client:NativeClient,root:Token,initial:Value[]=[]):EngineConnection{
  const claims=new Map<number,Token>([[root.tabId,root]]),routes=new Map<string,number>();
  const listeners=new Set<(event:Event)=>void|Promise<void>>(),queued:Event[]=[];
  let closed=false;
  const emit=(event:Event)=>{
    if(listeners.size){for(const listener of listeners)void listener(event);}
    else if(queued.length<64)queued.push(event);else client.close();
  };
  const receive=(message:Value)=>{
    if(closed)return;
    const received=token(message.token,root.epoch),owned=received&&claims.get(received.tabId);
    if(!received||!owned||owned.generation!==received.generation)return;
    const event=message.event as Event|undefined;
    if(!event||typeof event.method!=='string'||!event.params||typeof event.params!=='object')return;
    if(event.method==='Newton.pageCreated'){
      const child=token(event.params.token,root.epoch);if(!child||claims.has(child.tabId))return;
      if(claims.size>=32){client.close();return;}
      claims.set(child.tabId,child);
      emit({method:'Target.targetCreated',params:{targetInfo:{type:'page',targetId:`tab_${child.tabId}`,openerId:`tab_${owned.tabId}`}},sessionId:null});return;
    }
    if(event.method==='Newton.pageClosed'){
      claims.delete(owned.tabId);for(const [route,id] of routes)if(id===owned.tabId)routes.delete(route);
      emit({method:'Target.targetDestroyed',params:{targetId:`tab_${owned.tabId}`},sessionId:null});return;
    }
    if(event.method==='Target.attachedToTarget'&&typeof event.params.sessionId==='string'){
      const route=event.params.sessionId;
      if((routes.has(route)&&routes.get(route)!==owned.tabId)||(!routes.has(route)&&routes.size>=256)){client.close();return;}
      routes.set(route,owned.tabId);
    }
    if(event.method==='Target.detachedFromTarget'&&typeof event.params.sessionId==='string'&&routes.get(event.params.sessionId)===owned.tabId)routes.delete(event.params.sessionId);
    emit(event);
  };
  const unsubscribe=client.onEvent(receive);for(const event of initial)receive(event);
  const resolve=(sessionId?:string|null):Token=>{
    const match=/^tab_([1-9][0-9]*)$/.exec(sessionId??`tab_${root.tabId}`);
    const tabId=match?Number(match[1]):routes.get(sessionId!);
    const owned=tabId===undefined?undefined:claims.get(tabId);if(!owned)throw new Error('foreign_target');return owned;
  };
  return {rootTargetId:`tab_${root.tabId}`,epoch:root.epoch,claimGeneration:root.generation,signal:client.signal,
    tracksOwnedPages:client.hello.capabilities.includes('owned_popups'),
    wire:{
      async send(method,params={},sessionId){
        if(closed)throw new Error('connection_lost');
        if(method==='Target.attachToTarget'){
          if(typeof params.targetId!=='string'||!/^tab_[1-9][0-9]*$/.test(params.targetId))throw new Error('foreign_target');
          const owned=resolve(params.targetId);return {sessionId:`tab_${owned.tabId}`};
        }
        const owned=resolve(sessionId),rootRoute=`tab_${owned.tabId}`;
        const readOnly=method.startsWith('Accessibility.')||method.startsWith('Runtime.')||method.startsWith('DOM.get')||method.startsWith('DOM.query')||['DOM.describeNode','DOM.resolveNode','DOM.pushNodesByBackendIdsToFrontend'].includes(method)||method.startsWith('Page.get')||method==='Page.captureScreenshot';
        return client.call('command',{token:owned,method,params,...(sessionId&&sessionId!==rootRoute?{sessionId}:{})},readOnly);
      },
      onEvent(listener){
        if(listeners.size>=16)throw new Error('native_listener_capacity');listeners.add(listener);
        for(const event of queued.splice(0))void listener(event);
        return()=>{listeners.delete(listener);};
      },
    },
    async close(){
      if(closed)return;closed=true;unsubscribe();listeners.clear();queued.length=0;
      try{
        if(client.signal.aborted)return;
        const results=await Promise.allSettled([...claims.values()].map(token=>client.call('release',{token})));
        const failed=results.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
      }finally{claims.clear();routes.clear();client.close();}
    },
  };
}
