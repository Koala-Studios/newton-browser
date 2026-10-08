import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { temporaryRoot } from '../../scripts/prototypes/support.mjs';
import { createBrowserEngine } from '../../apps/mcp-server/src/embedding.ts';

const report = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(300_000, 7)]);

// Headless Chromium refuses downloads unless a client allows them: a click on a download link saved nothing.
test('a download link saves the file into the session, listed for the model and readable by the host', async () => {
  const temp = temporaryRoot('downloads');
  const site = http.createServer((req, res) => {
    if (req.url === '/files/report.pdf') {
      res.setHeader('content-type', 'application/pdf');
      res.setHeader('content-disposition', 'attachment; filename="Q3 report.pdf"');
      res.end(report);
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>files</title><a href="/files/report.pdf">Download the report</a>');
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const engine = createBrowserEngine({ configDirectory: temp.root, loginSource: 'access' });
  const json = result => JSON.parse(result.content.at(-1).text);
  try {
    const started = json(await engine.start({ url: `${origin}/` }));
    const { sessionId } = started;
    assert.deepEqual(json(await engine.call('browser.downloads', { sessionId })).downloads, []);
    const receipt = json(await engine.call('browser.act', { sessionId, command: { commandId: started.nextCommandId,
      action: { kind: 'click', target: { kind: 'semantic', role: 'link', name: 'Download the report' } } } }));
    assert.notEqual(receipt.outcome, 'outcome_unknown', JSON.stringify(receipt).slice(0, 400));
    let listed;
    for (let attempt = 0; attempt < 50; attempt++) {
      listed = json(await engine.call('browser.downloads', { sessionId }));
      if (listed.downloads[0]?.state === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const [download] = listed.downloads;
    assert.equal(download.state, 'completed', JSON.stringify(listed));
    assert.equal(download.filename, 'Q3 report.pdf');
    assert.equal(download.url, `${origin}/files/report.pdf`);
    assert.equal(download.receivedBytes, report.length);
    assert.equal(JSON.stringify(listed).includes(temp.root), false, 'the model never sees a host path');
    const file = engine.downloadFile(sessionId, download.downloadId);
    assert.equal(file.filename, 'Q3 report.pdf');
    assert.equal(file.bytes, report.length);
    assert.deepEqual(fs.readFileSync(file.path), report);
    assert.throws(() => engine.downloadFile(sessionId, 'not-a-download'), /invalid_arguments/u);
    await engine.stop(sessionId);
    assert.throws(() => engine.downloadFile(sessionId, download.downloadId), /session_closed/u);
  } finally {
    await engine.close().catch(() => undefined);
    site.close();
    temp.remove();
  }
});
