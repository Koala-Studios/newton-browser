import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { createBrowserEngine } from "../../apps/mcp-server/src/embedding.ts";

// A site that keeps its sign-in in local storage, session storage and IndexedDB, not cookies: a running session that
// adopts an operator's sign-in must open the page the person ended on, signed in. Values IndexedDB cannot carry as JSON
// make it partial.
const STORE = `<!doctype html><title>storing</title><script>
(async()=>{
  localStorage.setItem('token','local-token');sessionStorage.setItem('tab','tab-state');
  const db=await new Promise((resolve,reject)=>{const open=indexedDB.open('auth',3);open.onupgradeneeded=()=>{const db=open.result;
    db.createObjectStore('tokens',{keyPath:'id'}).createIndex('byUser','user');db.createObjectStore('kv');db.createObjectStore('dated');};
    open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
  const tx=db.transaction(['tokens','kv','dated'],'readwrite');
  tx.objectStore('tokens').put({id:'t1',user:'u1',token:'idb-token'});tx.objectStore('kv').put({nested:[1,2]},'k1');
  if(location.search.includes('dated'))tx.objectStore('dated').put(new Date(0),'when');
  await new Promise(resolve=>{tx.oncomplete=resolve;});db.close();location.replace('/');
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
      seen = text(await engine.call("browser.observe", { sessionId, maxBytes: 2048 })).observation.title ?? "";
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
    assert.match(await title(signIn.sessionId, (value) => value.includes("idb:idb")), /^ls:local-token/);
    const adopted = await engine.adoptSignIn(signIn.sessionId, worker.sessionId);
    assert.deepEqual(adopted, { cookies: 0, localStorageItems: 1, sessionStorageItems: 1, indexedDb: "copied", opened: url, originsLeftOut: [] });
    assert.equal(await title(worker.sessionId, (value) => value.includes("idb:idb")), 'ls:local-token|ss:tab-state|idb:idb-token+{"nested":[1,2]}+v3');
    await engine.finishSignIn(signIn.sessionId, false);

    // A record IndexedDB cannot carry as JSON (a Date) is left behind and says so; the rest still comes across.
    const dated = text(await engine.beginSignIn("access", { url: `${url}login?dated` }));
    assert.match(await title(dated.sessionId, (value) => value.includes("idb:idb")), /^ls:local-token/);
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

// A sign-in on a separate origin: the app (localhost) keeps its token in session storage and sends a signed-out tab to
// the sign-in origin (127.0.0.1), which hands back to the app's callback. The worker's page sits on the sign-in form,
// an origin with none of the app's storage, when the person finishes. Adoption must open the page the person ended on
// with the app's storage in this tab, and say what it opened.
function twoOrigins(port, widgetPort) {
  const app = `http://localhost:${port}`, auth = `http://127.0.0.1:${port}`, widget = `http://127.0.0.1:${widgetPort}`, tracker = `http://localhost:${widgetPort}`;
  // The dashboard embeds a widget origin (its storage comes across through that frame) and, on its first view only, a
  // tracker origin whose own root redirects away (its storage cannot be written anywhere and is reported).
  const guarded = (title) => `<!doctype html><title>checking</title>${title === "dashboard" ? `<iframe src="${widget}/frame"></iframe>` : ""}<script>
    if(${title === "dashboard"}&&!localStorage.getItem('seen')){localStorage.setItem('seen','1');const f=document.createElement('iframe');f.src='${tracker}/frame';document.body.append(f);}
    if(sessionStorage.getItem('token')==='app-token'&&localStorage.getItem('user')==='u1')document.title='${title}';
    else location.replace('${auth}/login');</script>`;
  return { app, auth, widget, tracker, routes: {
    "localhost /": guarded("home"), "localhost /dashboard": guarded("dashboard"),
    "localhost /callback": `<!doctype html><script>sessionStorage.setItem('token','app-token');localStorage.setItem('user','u1');location.replace('/dashboard');</script>`,
    "127.0.0.1 /login": `<!doctype html><title>sign-in form</title><form action="/authorize"><input name="user"><button>Sign in</button></form>`,
    "widget /frame": `<!doctype html><script>localStorage.setItem('widget','w1')</script>`,
    "tracker /frame": `<!doctype html><script>localStorage.setItem('visitor','v1')</script>`,
  } };
}

test("adoptSignIn opens the page a cross-origin sign-in ended on, with the app's session storage in the worker's tab", async (t) => {
  const temp = temporaryRoot("sign-in-cross-origin");
  let fixture;
  const server = http.createServer((req, res) => {
    const host = String(req.headers.host).split(":")[0], path = req.url.split("?")[0];
    if (host === "127.0.0.1" && path === "/authorize") { res.statusCode = 302; res.setHeader("location", `${fixture.app}/callback?code=one`); res.end(); return; }
    const body = fixture.routes[`${host} ${path}`];
    if (!body) { res.statusCode = 404; res.end(); return; }
    res.setHeader("content-type", "text/html; charset=utf-8"); res.end(body);
  });
  const widgets = http.createServer((req, res) => {
    const host = String(req.headers.host).split(":")[0], path = req.url.split("?")[0];
    if (path === "/") { res.statusCode = 302; res.setHeader("location", fixture.app + "/"); res.end(); return; }
    const body = fixture.routes[`${host === "localhost" ? "tracker" : "widget"} ${path}`];
    if (!body) { res.statusCode = 404; res.end(); return; }
    res.setHeader("content-type", "text/html; charset=utf-8"); res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => widgets.listen(0, "127.0.0.1", resolve));
  fixture = twoOrigins(server.address().port, widgets.address().port);
  const engine = createBrowserEngine({ configDirectory: temp.root, loginSource: "access" });
  const text = (result) => JSON.parse(result.content.at(-1).text);
  const title = async (sessionId, until) => {
    let seen = "";
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
      seen = text(await engine.call("browser.observe", { sessionId, maxBytes: 2048 })).observation.title ?? "";
      if (until(seen)) return seen;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return seen;
  };
  try {
    const worker = text(await engine.call("browser.session.start", { url: `${fixture.app}/` }));
    if (worker.errorCode) { t.skip(`browser unavailable: ${worker.errorCode}`); return; }
    assert.equal(await title(worker.sessionId, (value) => value === "sign-in form"), "sign-in form", "a signed-out worker lands on the sign-in form");

    const signIn = text(await engine.beginSignIn("access", { url: `${fixture.app}/` }));
    assert.equal(await title(signIn.sessionId, (value) => value === "sign-in form"), "sign-in form");
    // The person signs in on the sign-in origin and is handed back to the app.
    const go = text(await engine.call("browser.act", { sessionId: signIn.sessionId, command: { commandId: signIn.nextCommandId, action: { kind: "navigate", url: `${fixture.auth}/authorize` } } }));
    assert.notEqual(go.reason, "rejected", JSON.stringify(go));
    assert.equal(await title(signIn.sessionId, (value) => value === "dashboard"), "dashboard");

    const adopted = await engine.adoptSignIn(signIn.sessionId, worker.sessionId);
    assert.equal(adopted.localStorageItems, 3, `the app's two items and the widget's: ${JSON.stringify(adopted)}`);
    assert.equal(adopted.sessionStorageItems, 1, JSON.stringify(adopted));
    assert.equal(adopted.opened, `${fixture.app}/dashboard`, "the worker's page opens where the person ended");
    assert.deepEqual(adopted.originsLeftOut, [fixture.tracker], "an origin the worker's tab cannot reach is reported");
    assert.equal(await title(worker.sessionId, (value) => value === "dashboard"), "dashboard", "the worker is signed in, not on the sign-in form");
    await engine.finishSignIn(signIn.sessionId, false);
  } finally {
    await engine.close();
    server.close();
    widgets.close();
    temp.remove();
  }
});
