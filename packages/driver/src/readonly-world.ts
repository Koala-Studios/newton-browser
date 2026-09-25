import {EngineError} from '@newton-browser/core';
import type {NodeBinding,PageDirectory} from './page-directory.ts';
import type {EngineWire} from './connection.ts';

/** Native DOM wrappers isolated from application prototype overrides. No scripts
 * are registered on navigation, no page globals are written, and no universal
 * cross-origin access is granted. Only the existing bounded read functions run.
 */
export class ReadonlyWorlds {
  private readonly worlds=new Map<string,{generation:number;route:string;context:Promise<number>}>();
  private readonly directory:PageDirectory;
  private readonly wire:EngineWire;
  constructor(directory:PageDirectory,wire:EngineWire){this.directory=directory;this.wire=wire;}
  context(binding:NodeBinding):Promise<number>{
    const route=this.directory.route(binding),cached=this.worlds.get(binding.frameId);
    if(cached?.generation===binding.documentGeneration&&cached.route===route)return cached.context;
    const context=this.wire.send('Page.createIsolatedWorld',{frameId:binding.frameId,worldName:'newton-browser-read',grantUniveralAccess:false},route).then(result=>{
      this.directory.route(binding);
      if(!Number.isSafeInteger(result.executionContextId)||Number(result.executionContextId)<=0)throw new EngineError('evidence_unavailable');
      return Number(result.executionContextId);
    });
    this.worlds.set(binding.frameId,{generation:binding.documentGeneration,route,context});
    void context.catch(()=>{if(this.worlds.get(binding.frameId)?.context===context)this.worlds.delete(binding.frameId);});
    while(this.worlds.size>256)this.worlds.delete(this.worlds.keys().next().value!);
    return context;
  }
  clear():void{this.worlds.clear();}
}
