import { NativeAssembly, nativePackets } from "@newton-browser/core";
import { TabClaims, type ClaimToken, type DebuggerApi } from "./claims.ts";
import { UpdateBinding,type UpdateTabs } from './update-binding.ts';

interface NativePort {
  postMessage(value: unknown): void;
  onMessage: { addListener(fn: (value: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}
declare const chrome: {
  runtime: { connectNative(name: string): NativePort; getURL(file: string): string; reload(): void; lastError?: unknown;
    onMessage: { addListener(fn: (message: unknown, sender: { id?: string; url?: string }, reply: (value: unknown) => void) => boolean): void }; id: string };
  debugger: DebuggerApi & { onEvent: { addListener(fn: (source: { tabId?: number; sessionId?: string }, method: string, params: Record<string, unknown>) => void): void };
    onDetach: { addListener(fn: (source: { tabId?: number }) => void): void } };
  tabs: UpdateTabs & { query(query: Record<string, unknown>): Promise<{ id?: number; url?: string; title?: string }[]> };
  webNavigation:{onCreatedNavigationTarget:{addListener(fn:(details:{tabId:number;sourceTabId:number})=>void):void}};
};
const epoch = crypto.randomUUID();
const authority = new TabClaims(chrome.debugger, epoch);
const updateBinding=new UpdateBinding(chrome.tabs,chrome.runtime.getURL('update.html'));
const owners = new Map<string, object>();
const ids = new Map<object, string>();
const assembly = new NativeAssembly();
const native = chrome.runtime.connectNative(`newton.browser.${chrome.runtime.id}`);
let nativeConnected!: () => void;
let nativeFailed!: (error: Error) => void;
const nativeReady = new Promise<void>((resolve, reject) => { nativeConnected = resolve; nativeFailed = reject; });
void nativeReady.catch(() => undefined);
const post = (value: unknown) => { for (const packet of nativePackets(crypto.randomUUID(), value)) native.postMessage(packet); };
// MV3 service workers cannot use top-level await. Register listeners synchronously.
let digest = "";
const ready = (async () => {
  digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await (await fetch(chrome.runtime.getURL("worker.js"))).arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("");
  post({ type: "hello", protocolMajor: 1, epoch, digest, capabilities: ["tab_claim", "scoped_cdp", "tab_inventory", "native_chunks", "dev_reload", "update_binding", "owned_popups", "create_tab"] });
})();
void ready.catch(() => undefined);

native.onMessage.addListener(raw => {
  try {
    const complete = assembly.accept(raw); if (!complete) return;
    const message = complete.value as Record<string, unknown>;
    if (message.type === "broker_ready") { nativeConnected(); return; }
    const connectionId = String(message.connectionId);
    if (message.type === "open") {
      if (owners.has(connectionId) || owners.size >= 16) return;
      const owner = authority.bindPort(); owners.set(connectionId, owner); ids.set(owner, connectionId); return;
    }
    const owner = owners.get(connectionId); if (!owner) return;
    if (message.type === "close") {
      owners.delete(connectionId); ids.delete(owner); void authority.disconnect(owner).catch(() => undefined); return;
    }
    if (message.type !== "request") return;
    const request = message.request as Record<string, unknown>;
    const args = request.args as Record<string, unknown>;
    void (async () => {
      if (request.method === "claim") return authority.claim(owner, Number(args.tabId));
      if (request.method === 'create_tab') return authority.createTab(owner,chrome.tabs);
      if (request.method === "release") { await authority.release(owner, args.token as ClaimToken); return {}; }
      if (request.method === "command") return authority.command(owner, args.token as ClaimToken, String(args.method), args.params as Record<string, unknown>, args.sessionId as string | undefined);
      if (request.method === "quiesce") { await authority.quiesce(); return { state: "quiescent" }; }
      if (request.method === "reload") { await authority.quiesce(); chrome.runtime.reload(); return {}; }
      if(request.method==='prepare_update')return updateBinding.prepare(args.ticket);
      if(request.method==='prove_update')return updateBinding.prove(args.ticket);
      if(request.method==='finish_update'){await updateBinding.finish(args.ticket);return {};}
      if (request.method === "inventory") {const tabs=await chrome.tabs.query({});return { incomplete:tabs.length>128,tabs:tabs.slice(0,128).map(tab=>({tabId:tab.id,url:(tab.url??'').slice(0,4096),title:(tab.title??'').slice(0,512),claimed:authority.isClaimed(tab.id??0)})) };}
      throw new Error("unsupported_method");
    })().then(result => post({ connectionId, payload: { type: "response", id: request.id, result } }))
      .catch(error => post({ connectionId, payload: { type: "response", id: request.id, error: boundedError(error) } }))
      .catch(() => authority.disconnect(owner).catch(() => undefined));
  } catch { void authority.quiesce().catch(() => undefined); }
});
native.onDisconnect.addListener(() => {
  nativeFailed(new Error("native_connection_failed"));
  assembly.clear(); owners.clear(); ids.clear(); void authority.quiesce().catch(() => undefined);
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) return;
  const destination = authority.event(source.tabId, method, params); if (!destination) return;
  const connectionId = ids.get(destination.owner); if (!connectionId) return;
  post({ connectionId, payload: { type: "event", token: destination.token,
    event: { method, params, sessionId: source.sessionId ?? `tab_${source.tabId}` } } });
});
const pageClosed=(tabId:number)=>{
  const destination=authority.event(tabId,'Newton.pageClosed',{});
  const connectionId=destination&&ids.get(destination.owner);
  if(destination&&connectionId)post({connectionId,payload:{type:'event',token:destination.token,event:{method:'Newton.pageClosed',params:{},sessionId:null}}});
  authority.detached(tabId);
};
chrome.debugger.onDetach.addListener(source => { if (source.tabId) pageClosed(source.tabId); });
chrome.tabs.onRemoved.addListener(pageClosed);
chrome.webNavigation.onCreatedNavigationTarget.addListener(details=>{
  void authority.claimPopup(details.tabId,details.sourceTabId).then(claim=>{
    if(!claim)return;const connectionId=ids.get(claim.owner);if(!connectionId)return;
    post({connectionId,payload:{type:'event',token:claim.opener,event:{method:'Newton.pageCreated',params:{token:claim.token},sessionId:null}}});
  }).catch(()=>{/* Closed, already owned or unattachable popups never grant a claim. */});
});
// Setup page exposes status/reload only. It is never an alternate browser command channel.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("setup.html"))) return false;
  if ((message as Record<string, unknown>).type === "status") { void Promise.all([ready, nativeReady]).then(() => reply({ epoch, digest, protocolMajor: 1 }), () => reply({ error: "bootstrap_failed", detail: String(chrome.runtime.lastError ?? "native_host_unavailable") })); return true; }
  if ((message as Record<string, unknown>).type === "reload") {
    void authority.quiesce().then(() => { reply({ state: "quiescent" }); chrome.runtime.reload(); }); return true;
  }
  if ((message as Record<string, unknown>).type === "quiesce") { void authority.quiesce().then(() => reply({ state: "quiescent" })); return true; }
  return false;
});
function boundedError(error: unknown): string {
  const code = error instanceof Error ? error.message : "connection_failed";
  return /^[a-z_]{1,80}$/.test(code) ? code : "connection_failed";
}
