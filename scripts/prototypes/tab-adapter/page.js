// Harness-side lifecycle waiting; no code is installed in target websites.
const loaded=new Set();
const pending=new Map();
chrome.runtime.onMessage.addListener(message=>{
  if(message.event && message.method==='Page.lifecycleEvent' && message.params.name==='load') {
    const key=`${message.tabId}:${message.params.loaderId}`;
    loaded.add(key);pending.get(key)?.();pending.delete(key);
  }
  return false;
});
globalThis.waitForLoad=(tabId,loaderId)=>{
  const key=`${tabId}:${loaderId}`;
  return loaded.has(key)?Promise.resolve(true):new Promise(resolve=>pending.set(key,()=>resolve(true)));
};
