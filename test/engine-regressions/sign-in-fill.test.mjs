import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { createBrowserEngine } from "../../apps/mcp-server/src/embedding.ts";

// A host-side saved sign-in fill: only on the sign-in's site, a password field only for a secret value, typed like
// input, and the values never come back. *.localhost names reach the loopback fixture as separate sites.
const USER = "ops-user@example.test";
const SECRET = "s3cret-Pw!9";
const LOGIN = (port) => `<!doctype html><title>signed out</title>
<label>Email<input id="user" autocomplete="username"></label>
<label>Password<input id="pass" type="password" autocomplete="current-password"></label>
<label>Note<input id="note"></label>
<iframe title="Embedded sign-in" src="http://127.0.0.1:${port}/frame" style="width:400px;height:120px"></iframe>
<script>let events=0;const show=()=>{document.title='u:'+user.value+'|p:'+(pass.value===${JSON.stringify(SECRET)}?'ok':pass.value?'other':'empty')+'|note:'+(note.value?'set':'empty')+'|events:'+events;};
for(const field of [user,pass,note])field.addEventListener('input',()=>{events++;show();});</script>`;
const FRAME = `<!doctype html><label>Frame password<input id="frame-pass" type="password"></label>
<script>document.getElementById('frame-pass').addEventListener('input',()=>{document.title='frame typed';});</script>`;

test("fillSignIn fills a saved sign-in on its site only and never returns the values", async (t) => {
  const temp = temporaryRoot("sign-in-fill");
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(req.url === "/frame" ? FRAME : LOGIN(server.address().port));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const engine = createBrowserEngine({ configDirectory: temp.root });
  const text = (result) => JSON.parse(result.content.at(-1).text);
  const leaks = (value) => { const json = JSON.stringify(value); return json.includes(SECRET) || json.includes(USER); };
  try {
    assert.equal(typeof engine.fillSignIn, "function");
    assert.ok(!engine.tools().some((tool) => /sign/u.test(tool.name)), "not a model tool");
    const started = text(await engine.call("browser.session.start", { url: `http://accounts.app.localhost:${port}/login` }));
    if (started.errorCode) { t.skip(`browser unavailable: ${started.errorCode}`); return; }
    const { sessionId } = started;
    let next = started.nextCommandId;
    const title = async () => text(await engine.call("browser.observe", { sessionId, maxBytes: 4096 })).observation.title;
    const fill = async (site, fields) => { const reply = await engine.fillSignIn(sessionId, { commandId: next, site, fields }); const value = text(reply); next = value.nextCommandId ?? next; return { reply, value }; };
    const field = (id) => ({ kind: "selector", selector: `#${id}` });
    // A selector is checked across every frame, so the embedded frame loads first (a frame still loading makes the
    // search incomplete, which refuses the fill, under load).
    for (let tries = 0; tries < 40; tries++) {
      const shown = text(await engine.call("browser.observe", { sessionId, query: { text: "Frame password" } })).observation?.nodes ?? [];
      if (shown.some((node) => node.name === "Frame password")) break;
      await new Promise((resolve) => setTimeout(resolve, 125));
    }

    // A secret value into a field that is not a password field: refused before anything is typed.
    const wrongField = await fill("app.localhost", [{ target: field("user"), value: USER, secret: false }, { target: field("note"), value: SECRET, secret: true }]);
    assert.equal(wrongField.value.reason, "rejected");
    assert.equal(wrongField.value.dispatch, "not_started");
    assert.deepEqual(wrongField.value.fields, [{ field: 0, state: "not_started" }, { field: 1, state: "refused", errorCode: "not_password_field" }]);
    // A password field never takes a value that is not the secret.
    const plainIntoPassword = await fill("app.localhost", [{ target: field("pass"), value: USER, secret: false }]);
    assert.deepEqual(plainIntoPassword.value.fields, [{ field: 0, state: "refused", errorCode: "sensitive_target" }]);
    assert.equal(await title(), "signed out", "nothing was typed");

    // The cross-site frame's password field is not on the sign-in's site.
    const nodes = text(await engine.call("browser.observe", { sessionId, query: { text: "Frame password" } })).observation.nodes;
    const framePassword = nodes.find((node) => node.name === "Frame password");
    assert.ok(framePassword, "the embedded field is observable");
    const inFrame = await fill("app.localhost", [{ target: { kind: "ref", ref: framePassword.ref }, value: SECRET, secret: true }]);
    assert.deepEqual(inFrame.value.fields, [{ field: 0, state: "refused", errorCode: "frame_off_site" }]);

    // On the site (a subdomain of it): typed like input, events fire, and only outcomes come back.
    const filled = await fill("app.localhost", [{ target: field("user"), value: USER, secret: false }, { target: field("pass"), value: SECRET, secret: true }]);
    assert.equal(filled.value.reason, "completed", JSON.stringify({ fields: filled.value.fields, steps: filled.value.steps }));
    assert.deepEqual(filled.value.postcondition, { state: "met", kind: "value" });
    assert.deepEqual(filled.value.fields, [{ field: 0, state: "filled" }, { field: 1, state: "filled" }]);
    assert.match(await title(), new RegExp(`^u:${USER.replace(/[.]/gu, "\\.")}\\|p:ok\\|note:empty\\|events:[1-9]`, "u"));
    for (const result of [wrongField, plainIntoPassword, inFrame, filled]) assert.equal(leaks(result.reply), false, "no value in any reply");
    assert.equal(leaks(text(await engine.call("browser.command", { sessionId, commandId: filled.value.commandId }))), false, "the retained command keeps no value");
    // Repeating the command ID joins the first fill instead of typing again.
    const before = await title();
    const repeated = text(await engine.fillSignIn(sessionId, { commandId: filled.value.commandId, site: "app.localhost", fields: [{ target: field("user"), value: USER, secret: false }, { target: field("pass"), value: SECRET, secret: true }] }));
    assert.deepEqual(repeated.fields, filled.value.fields);
    assert.equal(await title(), before);

    // The model's own fill still never reaches a password field.
    const modelFill = text(await engine.call("browser.act", { sessionId, command: { commandId: next, action: { kind: "fill", target: field("pass"), value: "typed-by-model" } } }));
    assert.equal(modelFill.errorCode, "sensitive_target");
    next = modelFill.nextCommandId;
    // A look-alike host is another site.
    const lookAlike = text(await engine.call("browser.act", { sessionId, command: { commandId: next, action: { kind: "navigate", url: `http://app.localhost.evil.localhost:${port}/login` } } }));
    assert.equal(lookAlike.observation.title, "signed out", "the look-alike page loaded");
    next = lookAlike.nextCommandId;
    const elsewhere = await fill("app.localhost", [{ target: field("pass"), value: SECRET, secret: true }]);
    assert.deepEqual(elsewhere.value.fields, [{ field: 0, state: "refused", errorCode: "frame_off_site" }]);
    assert.equal(await title(), "signed out", "nothing was typed there");
    // Arguments that cannot be a sign-in are refused without a command.
    for (const site of ["", "app.localhost/", "*.localhost", ".localhost"]) assert.equal(text(await engine.fillSignIn(sessionId, { commandId: next, site, fields: [{ target: field("pass"), value: SECRET, secret: true }] })).errorCode, "invalid_arguments");
    assert.equal(text(await engine.fillSignIn("missing", { commandId: 1, site: "app.localhost", fields: [] })).errorCode !== undefined, true);
  } finally {
    await engine.close();
    server.close();
    temp.remove();
  }
});
