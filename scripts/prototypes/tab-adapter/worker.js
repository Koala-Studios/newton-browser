// Feasibility fixture, not a shipped adapter. No targeting, parsing or waiting.
const epoch=crypto.randomUUID();
const probeBuild=1;
const claims=new Map();
const nativePorts=new Set();
chrome.runtime.onInstalled.addListener(()=>{});
const methods=new Set(['Page.enable','Page.setLifecycleEventsEnabled','Page.navigate','Page.getFrameTree','Accessibility.enable',
  'Accessibility.getFullAXTree','DOM.getDocument','DOM.querySelector','DOM.focus',
  'Input.insertText','Runtime.evaluate','Page.captureScreenshot']);
chrome.debugger.onDetach.addListener(source=>claims.delete(source.tabId));
chrome.tabs.onRemoved.addListener(tabId=>claims.delete(tabId));
chrome.debugger.onEvent.addListener((source,method,params)=>{
  const claim=claims.get(source.tabId);
  if(claim && method==='Page.lifecycleEvent') chrome.runtime.sendMessage({event:true,tabId:source.tabId,epoch,...claim,method,params}).catch(()=>{});
});
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id || !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`)) return false;
  dispatch(message).then(value=>respond({ok:true,value}),error=>respond({ok:false,error:error.message}));
  return true;
});
async function dispatch(m) {
  if(m.op==='hello') return {epoch,protocolMajor:1,probeBuild};
  if(m.op==='connectNative') {
    const port=chrome.runtime.connectNative(m.hostName);nativePorts.add(port);
    port.onDisconnect.addListener(()=>nativePorts.delete(port));
    port.onMessage.addListener(message=>{
      dispatch(message).then(value=>port.postMessage({id:message.id,ok:true,value}),error=>port.postMessage({id:message.id,ok:false,error:error.message}));
    });
    return {connecting:true};
  }
  if(m.op==='create') return (await chrome.tabs.create({url:m.url,active:false})).id;
  if(m.op==='claim') {
    if(claims.has(m.tabId))throw new Error('tab_owned');
    // Reserve synchronously before attach yields: concurrent claim cannot win.
    const claim={owner:m.owner,generation:crypto.randomUUID()};
    claims.set(m.tabId,claim);
    try {await chrome.debugger.attach({tabId:m.tabId},'1.3');}
    catch(error){if(claims.get(m.tabId)===claim)claims.delete(m.tabId);throw error;}
    return {epoch,...claim};
  }
  const claim=claims.get(m.tabId);
  if(m.epoch!==epoch || !claim || claim.owner!==m.owner || claim.generation!==m.generation)throw new Error('claim_invalid');
  if(m.op==='detach') {
    await chrome.debugger.detach({tabId:m.tabId});
    if(claims.get(m.tabId)===claim)claims.delete(m.tabId);
    return {detached:true};
  }
  if(m.op==='cdp' && methods.has(m.method)) return chrome.debugger.sendCommand({tabId:m.tabId},m.method,m.params??{});
  throw new Error('unsupported_command');
}
