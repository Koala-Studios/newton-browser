import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { createBrowserEngine } from "../../apps/mcp-server/src/embedding.ts";

// A host-side sign-in code fill: a field marked one-time-code (which model fills never reach), a split input of one box
// per digit that moves focus itself, and a split input that refuses typing and reads the code only from a paste.
const CODE = "482913";
const page = () => `<!doctype html><title>waiting</title>
<label>Code<input id="single" autocomplete="one-time-code" inputmode="numeric"></label>
<div id="split" role="group" aria-label="Split code">${[0, 1, 2, 3, 4, 5].map((i) => `<input class="box" maxlength="1" inputmode="numeric" aria-label="Digit ${i + 1}"${i ? "" : ' autocomplete="one-time-code"'}>`).join("")}</div>
<div id="paste" role="group" aria-label="Paste code">${[0, 1, 2, 3, 4, 5].map((i) => `<input class="p" maxlength="1" aria-label="Paste digit ${i + 1}">`).join("")}</div>
<div id="short">${[0, 1, 2, 3].map((i) => `<input class="s" maxlength="1" aria-label="Short digit ${i + 1}">`).join("")}</div>
<label>Password<input id="pass" type="password" autocomplete="current-password"></label>
<label>Card<input id="card" autocomplete="cc-number"></label>
<script>
const want=${JSON.stringify(CODE)};
const state={single:'empty',split:'empty',paste:'empty'};
const show=()=>{document.title=Object.entries(state).map(([k,v])=>k+':'+v).join('|');};
single.addEventListener('input',()=>{state.single=single.value===want?'ok':'other';show();});
const boxes=[...document.querySelectorAll('.box')];
boxes.forEach((box,i)=>box.addEventListener('input',()=>{box.value=box.value.slice(-1);if(box.value&&boxes[i+1])boxes[i+1].focus();
  const v=boxes.map(b=>b.value).join('');state.split=v===want?'ok':v?'partial':'empty';show();}));
const pastes=[...document.querySelectorAll('.p')];
// This input takes no typing at all: only a pasted code, spread over its boxes.
pastes.forEach(box=>box.addEventListener('beforeinput',event=>event.preventDefault()));
pastes[0].addEventListener('paste',event=>{event.preventDefault();const text=(event.clipboardData.getData('text')||'').trim();
  pastes.forEach((b,i)=>{b.value=text[i]||'';});state.paste=text===want?'ok':'other';show();});
</script>`;

test("fillSignIn fills a sign-in code into one-time-code, split and paste-only code inputs", async (t) => {
  const temp = temporaryRoot("sign-in-code-fill");
  const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(page()); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const engine = createBrowserEngine({ configDirectory: temp.root });
  const text = (result) => JSON.parse(result.content.at(-1).text);
  const leaks = (value) => JSON.stringify(value).includes(CODE);
  try {
    const started = text(await engine.call("browser.session.start", { url: `http://accounts.app.localhost:${port}/verify` }));
    if (started.errorCode) { t.skip(`browser unavailable: ${started.errorCode}`); return; }
    const { sessionId } = started;
    let next = started.nextCommandId;
    const title = async () => text(await engine.call("browser.observe", { sessionId, maxBytes: 4096 })).observation.title;
    const replies = [];
    const fill = async (fields) => { const reply = await engine.fillSignIn(sessionId, { commandId: next, site: "app.localhost", fields }); replies.push(reply); const value = text(reply); next = value.nextCommandId ?? next; return value; };
    const at = (selector) => ({ kind: "selector", selector });
    const code = (selector, value = CODE) => ({ target: at(selector), value, secret: false, code: true });

    // The model's own fill never reaches a one-time-code field, and a plain sign-in value doesn't either.
    const modelFill = text(await engine.call("browser.act", { sessionId, command: { commandId: next, action: { kind: "fill", target: at("#single"), value: "123456" } } }));
    assert.equal(modelFill.errorCode, "sensitive_target");
    next = modelFill.nextCommandId;
    assert.deepEqual((await fill([{ target: at("#single"), value: CODE, secret: false }])).fields, [{ field: 0, state: "refused", errorCode: "sensitive_target" }]);
    // A code goes only into a code field: never a password or payment field, nor a split input of another length.
    for (const selector of ["#pass", "#card", "#short > :first-child"]) assert.deepEqual((await fill([code(selector)])).fields, [{ field: 0, state: "refused", errorCode: "not_code_field" }], selector);
    // A code is never the secret, and is only letters or digits.
    for (const bad of [{ ...code("#single"), secret: true }, code("#single", "12"), code("#single", "12 34"), code("#single", "x".repeat(13))])
      assert.equal(text(await engine.fillSignIn(sessionId, { commandId: next, site: "app.localhost", fields: [bad] })).errorCode, "invalid_arguments");
    assert.equal(await title(), "waiting", "nothing was typed");

    // One field marked one-time-code.
    const single = await fill([code("#single")]);
    assert.equal(single.reason, "completed", JSON.stringify(single));
    assert.deepEqual(single.fields, [{ field: 0, state: "filled" }]);
    // A split input, given by its first box: one digit per box, while the page moves focus on its own.
    const split = await fill([code("#split > :first-child")]);
    assert.deepEqual(split.fields, [{ field: 0, state: "filled" }], JSON.stringify(split));
    // A split input that takes only a paste.
    const pasted = await fill([code("#paste > :first-child")]);
    assert.deepEqual(pasted.fields, [{ field: 0, state: "filled" }], JSON.stringify(pasted));
    assert.equal(await title(), "single:ok|split:ok|paste:ok");
    for (const reply of replies) assert.equal(leaks(reply), false, "no code in any reply");
    assert.equal(leaks(text(await engine.call("browser.command", { sessionId, commandId: pasted.commandId }))), false, "the retained command keeps no code");
  } finally {
    await engine.close();
    server.close();
    temp.remove();
  }
});
