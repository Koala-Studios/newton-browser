import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { createBrowserEngine } from "../../apps/mcp-server/src/embedding.ts";

// Forgetting one site's sign-in (a taken-back consent): its cookies and stored data go, in a running session and in a
// login source's saved state, while another site's stay. *.localhost names reach the loopback fixture as separate sites.
const page = (url) => url.startsWith("/set")
  ? `<!doctype html><title>set</title><script>localStorage.setItem('token','kept-'+location.hostname);document.title='set';</script>`
  : `<!doctype html><title>reading</title><script>document.title='c:'+(/sid=/.test(document.cookie)?'yes':'no')+'|l:'+(localStorage.getItem('token')?'yes':'no');</script>`;

test("forgetSite removes one site's cookies and storage in a session and in the login source", async (t) => {
  const temp = temporaryRoot("forget-site");
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url.startsWith("/set")) res.setHeader("set-cookie", "sid=fixture-session; Path=/; Max-Age=3600");
    res.end(page(req.url));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const app = (host, path) => `http://${host}.localhost:${port}${path}`;
  const engine = createBrowserEngine({ configDirectory: temp.root });
  const text = (result) => JSON.parse(result.content.at(-1).text);
  try {
    // The login source learns both sites through a person's sign-in session, published on Done.
    const signIn = text(await engine.beginSignIn("default", { url: app("accounts.app", "/set") }));
    if (signIn.errorCode) { t.skip(`browser unavailable: ${signIn.errorCode}`); return; }
    let next = signIn.nextCommandId;
    const go = async (sessionId, url) => { const reply = text(await engine.call("browser.act", { sessionId, command: { commandId: next, action: { kind: "navigate", url } } })); next = reply.nextCommandId ?? next; return reply.observation?.title; };
    assert.equal(await go(signIn.sessionId, app("other", "/set")), "set");
    assert.ok(await engine.finishSignIn(signIn.sessionId, true));

    const started = text(await engine.call("browser.session.start", { url: app("accounts.app", "/read"), sourceId: "default" }));
    assert.equal(started.observation.title, "c:yes|l:yes");
    for (const site of ["app.localhost", "other.localhost"]) assert.ok(started.loginSites.includes(site), JSON.stringify(started.loginSites));
    const { sessionId } = started;
    next = started.nextCommandId;

    // Arguments that cannot name one site are refused.
    for (const bad of [{ site: "*.localhost", sessionId }, { site: "app.localhost", origins: ["http://evil.localhost"], sessionId }, { site: "app.localhost" }, { site: "app.localhost", sessionId, sourceId: "default" }])
      await assert.rejects(engine.forgetSite(bad), /invalid_arguments/);

    // In the running session.
    const inSession = await engine.forgetSite({ sessionId, site: "app.localhost", origins: [app("accounts.app", "")] });
    assert.ok(inSession.cookies >= 1 && inSession.origins >= 1, JSON.stringify(inSession));
    assert.equal(JSON.stringify(inSession).includes("fixture-session"), false, "no cookie value comes back");
    assert.equal(await go(sessionId, app("accounts.app", "/read")), "c:no|l:no");
    assert.equal(await go(sessionId, app("other", "/read")), "c:yes|l:yes");
    await engine.stop(sessionId);

    // In the login source's saved state: the next session starts without the site.
    const inSource = await engine.forgetSite({ sourceId: "default", site: "app.localhost", origins: [app("accounts.app", "")] });
    assert.ok(inSource.cookies >= 1 && typeof inSource.generation === "string", JSON.stringify(inSource));
    const after = text(await engine.call("browser.session.start", { url: app("accounts.app", "/read"), sourceId: "default" }));
    assert.equal(after.observation.title, "c:no|l:no");
    assert.ok(!(after.loginSites ?? []).includes("app.localhost"), JSON.stringify(after.loginSites));
    next = after.nextCommandId;
    assert.equal(await go(after.sessionId, app("other", "/read")), "c:yes|l:yes");
  } finally {
    await engine.close();
    server.close();
    temp.remove();
  }
});
