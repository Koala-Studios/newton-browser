import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { createBrowserEngine } from "../../apps/mcp-server/src/embedding.ts";

// A site that keeps its sign-in in local storage, session storage and IndexedDB, not cookies: a running session that
// adopts an operator's sign-in must reload signed in. Values IndexedDB cannot carry as JSON make it partial.
const STORE = `<!doctype html><title>storing</title><script>
(async()=>{
  localStorage.setItem('token','local-token');sessionStorage.setItem('tab','tab-state');
  const db=await new Promise((resolve,reject)=>{const open=indexedDB.open('auth',3);open.onupgradeneeded=()=>{const db=open.result;
    db.createObjectStore('tokens',{keyPath:'id'}).createIndex('byUser','user');db.createObjectStore('kv');db.createObjectStore('dated');};
    open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
  const tx=db.transaction(['tokens','kv','dated'],'readwrite');
  tx.objectStore('tokens').put({id:'t1',user:'u1',token:'idb-token'});tx.objectStore('kv').put({nested:[1,2]},'k1');
  if(location.search.includes('dated'))tx.objectStore('dated').put(new Date(0),'when');
  await new Promise(resolve=>{tx.oncomplete=resolve;});db.close();document.title='stored';
})();</script>`;
const READ = `<!doctype html><title>reading</title><script>
(async()=>{
  let idb='none';
  try{const db=await new Promise((resolve,reject)=>{const open=indexedDB.open('auth');open.onupgradeneeded=()=>open.transaction.abort();open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
    const get=(store,key)=>new Promise(resolve=>{const request=db.transaction(store).objectStore(store).get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>resolve(undefined);});
    const token=await get('tokens','t1'),kv=await get('kv','k1');idb=(token&&token.token)+'+'+JSON.stringify(kv)+'+v'+db.version;db.close();}catch{}
  document.title='ls:'+localStorage.getItem('token')+'|ss:'+sessionStorage.getItem('tab')+'|idb:'+idb;
})();</script>`;

test("adoptSignIn carries local storage, session storage and IndexedDB into a running session", async (t) => {
  const temp = temporaryRoot("sign-in-storage-adopt");
  const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(req.url.startsWith("/login") ? STORE : READ); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const engine = createBrowserEngine({ configDirectory: temp.root, loginSource: "access" });
  const text = (result) => JSON.parse(result.content.at(-1).text);
  const title = async (sessionId, until) => {
    let seen = "";
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
      seen = text(await engine.call("browser.observe", { sessionId, maxBytes: 2048 })).observation.title;
      if (until(seen)) return seen;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return seen;
  };
  try {
    const worker = text(await engine.call("browser.session.start", { url }));
    if (worker.errorCode) { t.skip(`browser unavailable: ${worker.errorCode}`); return; }
    assert.equal(await title(worker.sessionId, (value) => value.startsWith("ls:")), "ls:null|ss:null|idb:none");

    const signIn = text(await engine.beginSignIn("access", { url: `${url}login` }));
    assert.equal(await title(signIn.sessionId, (value) => value === "stored"), "stored");
    const adopted = await engine.adoptSignIn(signIn.sessionId, worker.sessionId);
    assert.deepEqual(adopted, { cookies: 0, localStorageItems: 1, sessionStorageItems: 1, indexedDb: "copied" });
    assert.equal(await title(worker.sessionId, (value) => value.includes("idb:idb")), 'ls:local-token|ss:tab-state|idb:idb-token+{"nested":[1,2]}+v3');
    await engine.finishSignIn(signIn.sessionId, false);

    // A record IndexedDB cannot carry as JSON (a Date) is left behind and says so; the rest still comes across.
    const dated = text(await engine.beginSignIn("access", { url: `${url}login?dated` }));
    assert.equal(await title(dated.sessionId, (value) => value === "stored"), "stored");
    const partial = await engine.adoptSignIn(dated.sessionId, worker.sessionId);
    assert.equal(partial.indexedDb, "partial");
    assert.equal(partial.localStorageItems, 1);
    await engine.finishSignIn(dated.sessionId, false);
  } finally {
    await engine.close();
    server.close();
    temp.remove();
  }
});
