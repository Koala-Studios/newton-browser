import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { createBrowserEngine } from "../../apps/mcp-server/src/embedding.ts";

// A host that restarts its browsers keeps a session's sign-in itself: a closed browser drops session cookies and session
// storage, and a worker session's changes never reach the login source. readSignIn takes the whole sign-in from a running
// session, restoreSignIn writes it into a session of a new engine. *.localhost names reach the loopback fixture as
// separate sites.
const page = (url) => url.startsWith("/set")
  ? `<!doctype html><title>set</title><script>localStorage.setItem('l','1');sessionStorage.setItem('s','1');document.title='set';</script>`
  : `<!doctype html><title>reading</title><script>document.title='p:'+(/p=1/.test(document.cookie)?'yes':'no')+'|s:'+(/s=1/.test(document.cookie)?'yes':'no')+'|l:'+(localStorage.getItem('l')?'yes':'no')+'|ss:'+(sessionStorage.getItem('s')?'yes':'no');</script>`;

test("readSignIn and restoreSignIn carry a sign-in, session cookies and storage included, across an engine restart", async (t) => {
  const temp = temporaryRoot("keep-sign-in");
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url.startsWith("/set")) res.setHeader("set-cookie", ["p=1; Path=/; Max-Age=3600", "s=1; Path=/"]);
    res.end(page(req.url));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const app = (host, path) => `http://${host}.localhost:${port}${path}`;
  const text = (result) => JSON.parse(result.content.at(-1).text);
  let engine = createBrowserEngine({ configDirectory: temp.root });
  try {
    const first = text(await engine.call("browser.session.start", { url: app("app", "/set") }));
    if (first.errorCode) { t.skip(`browser unavailable: ${first.errorCode}`); return; }
    let next = first.nextCommandId;
    const go = async (sessionId, url) => { const reply = text(await engine.call("browser.act", { sessionId, command: { commandId: next, action: { kind: "navigate", url } } })); next = reply.nextCommandId ?? next; return reply.observation?.title; };
    assert.equal(await go(first.sessionId, app("other", "/set")), "set");
    assert.equal(await go(first.sessionId, app("app", "/read")), "p:yes|s:yes|l:yes|ss:yes");

    // One site's only.
    const kept = await engine.readSignIn(first.sessionId, { site: "app.localhost" });
    assert.deepEqual([...new Set(kept.cookies.map((cookie) => cookie.domain))], ["app.localhost"]);
    assert.ok(kept.cookies.some((cookie) => cookie.name === "s" && cookie.session === true), "the session cookie is kept");
    assert.deepEqual(kept.origins.map((origin) => origin.origin), [app("app", "")]);
    assert.equal(kept.url, app("app", "/read"));
    await assert.rejects(engine.readSignIn(first.sessionId, { site: "*.localhost" }), /invalid_arguments/);
    await engine.close();

    // A new engine on the same profile: nothing of the worker session's sign-in is left.
    engine = createBrowserEngine({ configDirectory: temp.root });
    const second = text(await engine.call("browser.session.start", { url: app("app", "/read") }));
    assert.equal(second.observation.title, "p:no|s:no|l:no|ss:no");
    next = second.nextCommandId;

    // Bad states are refused before anything is written.
    for (const bad of [{}, { cookies: "x", origins: [] }, { cookies: [], origins: [{ origin: "file:///etc", local: [], session: [], indexedDb: {} }] },
      { cookies: [], origins: [{ origin: app("app", ""), local: [["k"]], session: [], indexedDb: {} }] }, { cookies: [], origins: [], url: "javascript:1" }])
      await assert.rejects(engine.restoreSignIn(second.sessionId, bad), /invalid_arguments/);

    const restored = await engine.restoreSignIn(second.sessionId, JSON.parse(JSON.stringify(kept)));
    assert.equal(restored.cookies, kept.cookies.length);
    assert.equal(restored.sessionStorageItems, 1);
    assert.equal(restored.localStorageItems, 1);
    assert.equal(restored.opened, app("app", "/read"));
    const read = text(await engine.call("browser.observe", { sessionId: second.sessionId }));
    assert.equal(read.observation.title, "p:yes|s:yes|l:yes|ss:yes");
    // The other site was not kept.
    assert.equal(await go(second.sessionId, app("other", "/read")), "p:no|s:no|l:no|ss:no");
  } finally {
    await engine.close();
    server.close();
    temp.remove();
  }
});
