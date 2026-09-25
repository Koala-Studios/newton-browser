export interface UpdateTabs {
  query(query: Record<string,unknown>):Promise<{id?:number;url?:string;title?:string}[]>;
  create(properties:{url:string;active:false}):Promise<{id?:number;url?:string}>;
  get(tabId:number):Promise<{id?:number;url?:string}>;
  remove(tabId:number):Promise<void>;
  onUpdated:{addListener(listener:(id:number,change:unknown,tab:{url?:string})=>void):void;removeListener(listener:(id:number,change:unknown,tab:{url?:string})=>void):void};
  onRemoved:{addListener(listener:(id:number)=>void):void;removeListener(listener:(id:number)=>void):void};
}

/** Development-update continuity lives in one temporary blank marker tab,
 * never in website storage or a profile-wide process-ID assumption. */
export class UpdateBinding {
  private busy=false;
  private readonly tabs:UpdateTabs;
  private readonly page:string;
  constructor(tabs:UpdateTabs,page:string){
    if(!/^chrome-extension:\/\/[a-p]{32}\/update.html$/.test(page))throw new Error('update_binding_invalid');
    this.tabs=tabs;this.page=`about:blank#newton-browser-update/${new URL(page).hostname}/`;
  }
  private url(ticket:unknown):string{
    if(typeof ticket!=='string'||!/^[a-f0-9]{64}$/.test(ticket))throw new Error('update_ticket_invalid');
    return `${this.page}${ticket}`;
  }
  private async markers(){return (await this.tabs.query({})).filter(tab=>tab.url?.startsWith(this.page));}
  private async marker(ticket:unknown):Promise<number>{
    const url=this.url(ticket),tabs=await this.markers();
    // Multiple markers are ambiguous even if one has the requested ticket.
    if(tabs.length!==1||tabs[0]?.url!==url||!Number.isSafeInteger(tabs[0]?.id)||tabs[0]!.id!<=0)throw new Error('update_binding_lost');
    return tabs[0]!.id!;
  }
  async prepare(ticket:unknown):Promise<{tabId:number}>{
    const url=this.url(ticket);
    if(this.busy)throw new Error('adapter_update_busy');
    this.busy=true;
    try{
      const existing=await this.markers();
      if(existing.length){
        const marker=existing[0];
        if(existing.length===1&&marker?.url===url&&Number.isSafeInteger(marker.id)&&marker.id!>0)return {tabId:marker.id!};
        throw new Error('adapter_update_busy');
      }
      const tab=await this.tabs.create({url,active:false});
      if(!Number.isSafeInteger(tab.id)||tab.id!<=0)throw new Error('update_binding_lost');
      await this.committed(tab.id!,url);
      return {tabId:tab.id!};
    }finally{this.busy=false;}
  }
  async prove(ticket:unknown):Promise<{tabId:number}>{return {tabId:await this.marker(ticket)};}
  async finish(ticket:unknown):Promise<void>{
    const url=this.url(ticket),tabs=await this.markers();
    // Commit precedes marker cleanup. Retrying after a lost cleanup acknowledgement
    // must succeed when the marker is already gone, while foreign markers stay intact.
    if(!tabs.length)return;
    if(tabs.length!==1||tabs[0]?.url!==url||!Number.isSafeInteger(tabs[0]?.id)||tabs[0]!.id!<=0)throw new Error('update_binding_lost');
    await this.tabs.remove(tabs[0]!.id!);
  }
  private committed(tabId:number,url:string):Promise<void>{
    return new Promise((resolve,reject)=>{
      let done=false;
      const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);this.tabs.onUpdated.removeListener(updated);this.tabs.onRemoved.removeListener(removed);error?reject(error):resolve();};
      const updated=(id:number,_change:unknown,tab:{url?:string})=>{if(id===tabId&&tab.url===url)finish();};
      const removed=(id:number)=>{if(id===tabId)finish(new Error('update_binding_lost'));};
      const timer=setTimeout(()=>finish(new Error('update_binding_timeout')),5000);
      this.tabs.onUpdated.addListener(updated);this.tabs.onRemoved.addListener(removed);
      void this.tabs.get(tabId).then(tab=>updated(tabId,{},tab),()=>finish(new Error('update_binding_lost')));
    });
  }
}
