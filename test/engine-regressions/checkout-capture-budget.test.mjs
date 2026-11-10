import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { createBrowserEngine } from "../../apps/mcp-server/src/embedding.ts";

// A checkout page: many hidden card and code inputs, a couple of shown password fields, and an embedded cross-site
// card frame with more shown card fields than the mask budget. The capture must succeed with the frame masked whole.
const FIELDS = Array.from({ length: 40 }, (_, index) => `<input autocomplete="cc-number" name="hidden-${index}" style="display:none">`).join("");
const PAGE = (port) => `<!doctype html><title>checkout</title><style>body{margin:0;background:#0f0}iframe{position:absolute;left:100px;top:100px;width:400px;height:300px;border:0}</style>
${FIELDS}<input type="password" style="position:absolute;left:600px;top:20px"><input type="password" style="position:absolute;left:600px;top:60px">
<iframe title="Card" src="http://localhost:${port}/card"></iframe>`;
const CARD = `<!doctype html><style>body{margin:0;background:#00f}input{display:block;width:60px;height:3px;padding:0;border:0;margin:1px;background:#fff}</style>${Array.from({ length: 40 }, () => '<input autocomplete="cc-number">').join("")}`;

function pixel(png, x, y) {
  // Decode an 8-bit RGB(A) PNG without filters beyond the standard five, enough for one sample.
  const buffer = Buffer.from(png, "base64");
  let offset = 8, width = 0, height = 0, channels = 4;
  const data = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString("ascii", offset + 4, offset + 8), body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") { width = body.readUInt32BE(0); height = body.readUInt32BE(4); channels = body[9] === 6 ? 4 : 3; }
    if (type === "IDAT") data.push(body);
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(data)), stride = width * channels, rows = [];
  let previous = Buffer.alloc(stride);
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)], line = Buffer.from(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)));
    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? line[index - channels] : 0, up = previous[index], corner = index >= channels ? previous[index - channels] : 0;
      const p = left + up - corner, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
      line[index] = (line[index] + [0, left, up, (left + up) >> 1, pa <= pb && pa <= pc ? left : pb <= pc ? up : corner][filter]) & 255;
    }
    rows.push(line); previous = line;
  }
  return [...rows[y].subarray(x * channels, x * channels + 3)];
}

test("a checkout capture masks an over-budget cross-site card frame whole instead of refusing", async (t) => {
  const temp = temporaryRoot("checkout-capture-budget");
  const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(req.url === "/card" ? CARD : PAGE(server.address().port)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const engine = createBrowserEngine({ configDirectory: temp.root });
  const text = (result) => JSON.parse(result.content.at(-1).text);
  try {
    const started = text(await engine.call("browser.session.start", { url: `http://127.0.0.1:${server.address().port}/` }));
    if (started.errorCode) { t.skip(`browser unavailable: ${started.errorCode}`); return; }
    let shot;
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
      shot = await engine.call("browser.screenshot", { sessionId: started.sessionId });
      const observation = text(shot).observation;
      if (observation.state === "available" && observation.provenance?.maskDisposition === "mask_applied") break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const observation = text(shot).observation;
    assert.equal(observation.state, "available", JSON.stringify(observation));
    assert.equal(observation.provenance.maskDisposition, "mask_applied");
    const image = shot.content.find((item) => item.type === "image");
    assert.ok(image, "the screenshot carries its image");
    const blue = [0, 0, 255], green = [0, 255, 0];
    assert.notDeepEqual(pixel(image.data, 300, 380), blue, "the card frame's own background is masked too");
    assert.notDeepEqual(pixel(image.data, 130, 105), blue, "the card frame's fields are masked");
    assert.deepEqual(pixel(image.data, 50, 50), green, "the page outside the frame and its fields shows");
  } finally {
    await engine.close();
    server.close();
    temp.remove();
  }
});

// A checkout as stores lay it out: a hidden cross-site wallet frame holding card fields (no layout box at all), a shown
// cross-site card frame, and the order summary twice: a hidden phone copy first, the desktop one beside the form.
const WALLET_PAGE = (port) => `<!doctype html><title>checkout</title><style>body{margin:0;background:#0f0}#card{position:absolute;left:100px;top:100px;width:300px;height:100px;border:0}
aside.desktop{position:absolute;left:600px;top:100px;width:300px}aside.phone{display:none}</style>
<iframe id="wallet" style="display:none" src="http://localhost:${port}/card"></iframe>
<iframe id="card" title="Card" src="http://localhost:${port}/card"></iframe>
<aside class="phone"><h2>Order summary</h2><p>Total 42.00</p></aside>
<aside class="desktop"><h2>Order summary</h2><p>Subtotal 40.00</p><p>Total 42.00</p></aside>`;
const SMALL_CARD = `<!doctype html><style>body{margin:0;background:#00f}input{display:block;width:60px;height:20px}</style><input autocomplete="cc-number"><input autocomplete="cc-exp">`;

test("a checkout with a hidden wallet frame captures, and its order summary reads past the hidden phone copy", async (t) => {
  const temp = temporaryRoot("checkout-hidden-wallet");
  const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(req.url === "/card" ? SMALL_CARD : WALLET_PAGE(server.address().port)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const engine = createBrowserEngine({ configDirectory: temp.root });
  const text = (result) => JSON.parse(result.content.at(-1).text);
  try {
    const started = text(await engine.call("browser.session.start", { url: `http://127.0.0.1:${server.address().port}/` }));
    if (started.errorCode) { t.skip(`browser unavailable: ${started.errorCode}`); return; }
    let shot;
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
      shot = await engine.call("browser.screenshot", { sessionId: started.sessionId });
      const observation = text(shot).observation;
      if (observation.state === "available" && observation.provenance?.maskDisposition === "mask_applied") break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const observation = text(shot).observation;
    assert.equal(observation.state, "available", JSON.stringify(observation));
    assert.equal(observation.provenance.maskDisposition, "mask_applied", "the shown card fields are masked");
    const image = shot.content.find((item) => item.type === "image");
    assert.notDeepEqual(pixel(image.data, 110, 110), [255, 255, 255], "the card number field is masked");
    assert.deepEqual(pixel(image.data, 50, 50), [0, 255, 0], "the page shows");
    const clipped = text(await engine.call("browser.screenshot", { sessionId: started.sessionId, clip: { x: 600, y: 100, width: 300, height: 200 } })).observation;
    assert.equal(clipped.state, "available", `a clip of the summary captures: ${JSON.stringify(clipped)}`);
    const read = text(await engine.call("browser.document.read", { sessionId: started.sessionId, scope: { kind: "selector", selector: "aside" } })).observation;
    assert.equal(read.state, "available", JSON.stringify(read));
    assert.match(read.text, /Subtotal 40\.00/, "the shown summary is read, not the hidden phone copy");
    assert.equal(read.scopeMatches, 2);
  } finally {
    await engine.close();
    server.close();
    temp.remove();
  }
});
