export interface DebuggerApi {
  attach(target: { tabId: number }, version: string): Promise<void>;
  detach(target: { tabId: number }): Promise<void>;
  sendCommand(target: { tabId: number; sessionId?: string }, method: string, params: Record<string, unknown>): Promise<unknown>;
}
type Owner = object;
type HeldInput = { sessionId: string | undefined; method: string; params: Record<string, unknown> };
type Claim = { owner: Owner; tabId: number; generation: number; state: "reserved" | "attached" | "revoking" | "quarantined";
  attachment: Promise<void>; active: Set<Promise<unknown>>; cancellations:Map<(error:Error)=>void,string|undefined>; routes: Map<string,object>; heldInputs: Map<string, HeldInput> };
export type ClaimToken = Readonly<{ tabId: number; epoch: string; generation: number }>;
const methods = new Set([
  "Page.enable", "Page.setLifecycleEventsEnabled", "Page.getFrameTree", "Page.navigate", "Page.captureScreenshot",
  "Page.reload", "Page.getNavigationHistory", "Page.navigateToHistoryEntry", "Page.getLayoutMetrics",
  "Page.handleJavaScriptDialog", "Page.createIsolatedWorld", "Page.startScreencast", "Page.stopScreencast", "Overlay.enable",
  "Accessibility.getPartialAXTree", "Accessibility.enable", "Accessibility.getChildAXNodes", "Accessibility.queryAXTree", "Accessibility.getAXNodeAndAncestors",
  "Accessibility.getFullAXTree", "DOM.enable", "DOM.getDocument", "DOM.querySelector", "DOM.querySelectorAll", "DOM.describeNode", "DOM.resolveNode", "DOM.focus",
  "DOM.getFrameOwner", "DOM.pushNodesByBackendIdsToFrontend", "DOM.setFileInputFiles",
  "DOM.getContentQuads", "DOM.getNodeForLocation", "DOM.scrollIntoViewIfNeeded",
  "DOM.performSearch", "DOM.getSearchResults", "DOM.discardSearchResults", "DOM.getBoxModel",
  "Runtime.evaluate", "Runtime.callFunctionOn", "Runtime.releaseObject", "Input.dispatchKeyEvent", "Input.dispatchMouseEvent", "Input.insertText", "Target.setAutoAttach",
]);

/** Browser-local authority. Owner capabilities are created by bound native connections. */
export class TabClaims {
  readonly epoch: string;
  private readonly api: DebuggerApi;
  private readonly owners = new WeakSet<Owner>();
  private readonly claims = new Map<number, Claim>();
  private nextGeneration = 1;
  private accepting = true;
  private creating=0;
  private readonly closingCreatedTabs=new Set<number>();
  private readonly creationJobs=new Map<Promise<ClaimToken>,Owner>();
  constructor(api: DebuggerApi, epoch: string) { this.api = api; this.epoch = epoch; }
  bindPort(): Owner { const owner = Object.freeze({}); this.owners.add(owner); return owner; }
  isClaimed(tabId:number):boolean{return this.claims.has(tabId)||this.closingCreatedTabs.has(tabId);}
  createTab(owner:Owner,tabs:{create(properties:{url:string;active:false}):Promise<{id?:number}>;remove(tabId:number):Promise<void>}):Promise<ClaimToken>{
    const operation=this.createOwnedTab(owner,tabs);this.creationJobs.set(operation,owner);
    void operation.finally(()=>this.creationJobs.delete(operation)).catch(()=>undefined);
    return operation;
  }
  private async createOwnedTab(owner:Owner,tabs:{create(properties:{url:string;active:false}):Promise<{id?:number}>;remove(tabId:number):Promise<void>}):Promise<ClaimToken>{
    if(!this.accepting||!this.owners.has(owner))throw new Error('connection_closed');
    if(this.claims.size+this.creating+this.closingCreatedTabs.size>=32)throw new Error('claim_capacity');
    this.creating++;let reserved=true,tabId:number|undefined;
    try{
      const tab=await tabs.create({url:'about:blank',active:false});
      if(!Number.isSafeInteger(tab.id)||tab.id!<=0)throw new Error('invalid_tab');
      tabId=tab.id!;this.creating--;reserved=false;
      return await this.claim(owner,tabId);
    }catch(error){
      // Only the tab just created by this request can be removed on failed setup.
      // An intervening owner or quarantined attachment must never be overwritten.
      if(tabId!==undefined&&!this.claims.has(tabId)){
        this.closingCreatedTabs.add(tabId);
        try{await tabs.remove(tabId);}finally{this.closingCreatedTabs.delete(tabId);}
      }
      throw error;
    }finally{if(reserved)this.creating--;}
  }
  /** Called only with opener metadata from the browser's tab-created event. A
   * model request cannot nominate an opener to gain ownership of another tab. */
  async claimPopup(tabId:number,openerTabId:number):Promise<{owner:Owner;token:ClaimToken;opener:ClaimToken}|undefined>{
    const opener=this.claims.get(openerTabId);
    if(!opener||opener.state!=='attached'||!this.owners.has(opener.owner))return;
    const openerToken={tabId:openerTabId,epoch:this.epoch,generation:opener.generation};
    const token=await this.claim(opener.owner,tabId);
    // Opener revocation while debugger attachment was pending cannot transfer
    // a late popup into a session that has already released its parent.
    if(this.claims.get(openerTabId)!==opener||opener.state!=='attached'||!this.owners.has(opener.owner)){
      const child=this.claims.get(tabId);
      if(child&&child.generation===token.generation)await this.revoke(child);
      throw new Error('claim_revoked');
    }
    return {owner:opener.owner,token,opener:openerToken};
  }
  async claim(owner: Owner, tabId: number): Promise<ClaimToken> {
    if (!this.accepting || !this.owners.has(owner)) throw new Error("connection_closed");
    if (!Number.isSafeInteger(tabId) || tabId <= 0) throw new Error("invalid_tab");
    if (this.claims.has(tabId)||this.closingCreatedTabs.has(tabId)) throw new Error("tab_owned");
    if (this.claims.size+this.creating+this.closingCreatedTabs.size >= 32) throw new Error("claim_capacity");
    const claim: Claim = { owner, tabId, generation: this.nextGeneration++, state: "reserved", attachment: Promise.resolve(), active: new Set(), cancellations:new Map(), routes: new Map(), heldInputs: new Map() };
    this.claims.set(tabId, claim); // Reserve synchronously before attach can yield.
    claim.attachment = Promise.resolve().then(() => this.api.attach({ tabId }, "1.3"));
    try { await claim.attachment; }
    catch {
      if (this.claims.get(tabId) === claim && claim.state === "reserved") this.claims.delete(tabId);
      throw new Error("attach_failed");
    }
    if (claim.state !== "reserved" || this.claims.get(tabId) !== claim) throw new Error("claim_revoked");
    claim.state = "attached";
    return Object.freeze({ tabId, epoch: this.epoch, generation: claim.generation });
  }
  async command(owner: Owner, token: ClaimToken, method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    const claim = this.require(owner, token);
    if (!methods.has(method)) throw new Error("unsupported_method");
    if (sessionId && !claim.routes.has(sessionId)) throw new Error("foreign_route");
    const route=sessionId?claim.routes.get(sessionId):undefined;
    if (claim.active.size >= 64) throw new Error("command_capacity");
    // Browser-level target discovery, attach and close are never forwarded from an engine.
    const key = method === "Input.dispatchKeyEvent" && typeof params.key === "string" ? params.key : undefined;
    const button = method === "Input.dispatchMouseEvent" && typeof params.button === "string" && params.button !== "none" ? params.button : undefined;
    const inputId = key || button ? JSON.stringify([sessionId ?? "", key ? "key" : "button", key ?? button]) : undefined;
    if (key && ["keyDown", "rawKeyDown"].includes(String(params.type))) {
      if (claim.heldInputs.size >= 16 && !claim.heldInputs.has(inputId!)) throw new Error("held_input_limit");
      claim.heldInputs.set(inputId!, { sessionId, method, params: { type: "keyUp", key, code: params.code, windowsVirtualKeyCode: params.windowsVirtualKeyCode, modifiers: 0 } });
    }
    if (button && params.type === "mousePressed") {
      if (claim.heldInputs.size >= 16 && !claim.heldInputs.has(inputId!)) throw new Error("held_input_limit");
      claim.heldInputs.set(inputId!, { sessionId, method, params: { type: "mouseReleased", button, x: params.x, y: params.y, buttons: 0, clickCount: params.clickCount ?? 1 } });
    }
    let cancel!:(error:Error)=>void;
    const operation=new Promise<unknown>((resolve,reject)=>{
      cancel=reject;claim.cancellations.set(cancel,sessionId);
      try{void this.api.sendCommand({tabId:claim.tabId,...(sessionId?{sessionId}:{})},method,params).then(resolve,reject);}
      catch(error){reject(error);}
    });
    claim.active.add(operation);
    try {
      const result=await operation;
      if(claim.state!=='attached'||this.claims.get(claim.tabId)!==claim)throw new Error('connection_lost');
      if(sessionId&&claim.routes.get(sessionId)!==route)throw new Error('route_lost');
      if(inputId&&(params.type==='keyUp'||params.type==='mouseReleased'))claim.heldInputs.delete(inputId);
      return result;
    }finally{claim.active.delete(operation);claim.cancellations.delete(cancel);}
  }
  event(tabId: number, method: string, params: Record<string, unknown>): { owner: Owner; token: ClaimToken } | undefined {
    const claim = this.claims.get(tabId);
    if (!claim || claim.state !== "attached") return;
    if (method === "Target.attachedToTarget" && typeof params.sessionId === "string") {
      if (!claim.routes.has(params.sessionId) && claim.routes.size >= 128) {
        claim.state = "quarantined";
        this.endCommands(claim,'route_capacity');
        return;
      }
      if(!claim.routes.has(params.sessionId))claim.routes.set(params.sessionId,{});
    }
    if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
      claim.routes.delete(params.sessionId);
      for(const [cancel,route] of claim.cancellations)if(route===params.sessionId){cancel(new Error('route_lost'));claim.cancellations.delete(cancel);}
      for(const [id,input] of claim.heldInputs)if(input.sessionId===params.sessionId)claim.heldInputs.delete(id);
    }
    return { owner: claim.owner, token: { tabId, epoch: this.epoch, generation: claim.generation } };
  }
  detached(tabId: number): void {
    const claim = this.claims.get(tabId);
    if (!claim) return;
    if (claim.state === "revoking" || claim.state === "quarantined") return;
    if (claim.state === "reserved") { void this.revoke(claim).catch(() => undefined); return; }
    // Human/DevTools detach is terminal for this claim. No automatic reattach.
    claim.state = "revoking";
    this.endCommands(claim,'connection_lost');
    claim.heldInputs.clear();this.claims.delete(tabId);
  }
  async release(owner: Owner, token: ClaimToken): Promise<void> {
    const claim = this.require(owner, token);
    await this.revoke(claim);
  }
  async disconnect(owner: Owner): Promise<void> {
    this.owners.delete(owner);
    await this.releaseAll(owner);
  }
  /** Releases one connection's tabs and pending creations; other connections keep theirs. */
  async releaseAll(owner: Owner): Promise<void> {
    const creations=[...this.creationJobs].filter(([,creator])=>creator===owner).map(([job])=>job.catch(()=>undefined));
    const results = await Promise.allSettled([...creations.map(job=>bounded(job)),...[...this.claims.values()].filter(claim => claim.owner === owner).map(claim => this.revoke(claim))]);
    if (results.some(result => result.status === "rejected")) throw new Error("detach_failed");
  }
  async quiesce(): Promise<void> {
    this.accepting = false;
    const results = await Promise.allSettled([
      ...[...this.creationJobs.keys()].map(job=>bounded(job.catch(()=>undefined))),
      ...[...this.claims.values()].map(claim=>this.revoke(claim)),
    ]);
    if (results.some(result => result.status === "rejected")) throw new Error("update_quiescence_failed");
  }
  private require(owner: Owner, token: ClaimToken): Claim {
    const claim = this.claims.get(token.tabId);
    if (!this.owners.has(owner) || token.epoch !== this.epoch || !claim || claim.owner !== owner || claim.generation !== token.generation || claim.state !== "attached") throw new Error("stale_claim");
    return claim;
  }
  private async revoke(claim: Claim): Promise<void> {
    if (this.claims.get(claim.tabId) !== claim) return;
    claim.state = "revoking";
    try {
      await bounded(claim.attachment.catch(() => undefined));
      // A modal can withhold acknowledgements for already dispatched input. Revoke
      // admission first, issue only held releases, and use debugger detach as the
      // lifecycle barrier. Waiting for those acknowledgements before detach deadlocks.
      const releases = [...claim.heldInputs.values()].reverse().map(input => {
        try { return this.api.sendCommand({ tabId: claim.tabId, ...(input.sessionId ? { sessionId: input.sessionId } : {}) }, input.method, input.params); }
        catch (error) { return Promise.reject(error); }
      });
      void Promise.allSettled(releases);
      await bounded(this.api.detach({ tabId: claim.tabId }));
      this.endCommands(claim,'connection_lost');
      claim.heldInputs.clear();
      if (this.claims.get(claim.tabId) === claim) this.claims.delete(claim.tabId);
    } catch {
      claim.state = "quarantined";
      this.endCommands(claim,'cleanup_uncertain');
      // Detach remains independent when reconciliation stalls. Quarantine is not cleared by success here.
      await bounded(Promise.resolve().then(() => this.api.detach({ tabId: claim.tabId }))).catch(() => undefined);
      throw new Error("detach_failed");
    }
  }
  private endCommands(claim:Claim,code:string):void{
    for(const cancel of claim.cancellations.keys())cancel(new Error(code));
    claim.cancellations.clear();
  }
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("reconciliation_timeout")), 1000); })]); }
  finally { clearTimeout(timer); }
}
