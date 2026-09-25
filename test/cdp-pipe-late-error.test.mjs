import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
// A late pipe error after close must not crash the host process.
import { CdpPipeTransport } from '../apps/mcp-server/src/browser-runtime/cdp-pipe.ts';

test('late pipe errors retain the original closed result without crashing the host', async () => {
  const readable = new PassThrough(), writable = new PassThrough();
  const transport = new CdpPipeTransport(readable, writable);
  const pending = transport.send('Browser.getVersion');
  const rejected = assert.rejects(pending, { code: 'cdp_transport_closed' });
  readable.emit('end');
  await rejected;
  for (const stream of [readable, writable]) {
    assert.doesNotThrow(() => stream.emit('error', Object.assign(new Error('synthetic reset'), { code: 'ECONNRESET' })));
    assert.doesNotThrow(() => stream.emit('error', new Error('second late reset')));
  }
  assert.equal(transport.pendingRequestCount, 0);
  await assert.rejects(transport.send('Browser.getVersion'), { code: 'cdp_transport_closed' });
  transport.close();
  readable.destroy(); writable.destroy();
});
