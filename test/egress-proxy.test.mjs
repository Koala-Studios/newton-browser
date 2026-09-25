import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { isPublicAddress, startEgressProxy, egressProxyArgs } from '../apps/mcp-server/src/browser-runtime/egress-proxy.ts';
import { chromiumLaunchArgs } from '../apps/mcp-server/src/browser-runtime/chromium-process.ts';

test('only globally routable addresses are public', () => {
  for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:93.184.216.34'])
    assert.equal(isPublicAddress(address), true, address);
  for (const address of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '0.0.0.0', '169.254.169.254',
    '100.64.0.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1',
    '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:a00:1::', '2001:db8::1', 'ff02::1', 'not-an-ip'])
    assert.equal(isPublicAddress(address), false, address);
});

test('browser launch routes everything through the proxy when configured', () => {
  const args = chromiumLaunchArgs({ userDataDir: '/tmp/x', proxyServer: 'http://127.0.0.1:4321' });
  for (const arg of egressProxyArgs('http://127.0.0.1:4321')) assert.ok(args.includes(arg), arg);
  assert.throws(() => chromiumLaunchArgs({ userDataDir: '/tmp/x', proxyServer: 'http://10.0.0.1:80' }));
});

function connect(proxy, target) {
  const { port } = new URL(proxy.proxyServer);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.once('data', data => { resolve(String(data).split('\r\n')[0]); socket.destroy(); });
    socket.once('error', reject);
  });
}
function get(proxy, url) {
  const { port } = new URL(proxy.proxyServer);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: Number(port), path: url, headers: { host: new URL(url).host } }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.once('error', reject); request.end();
  });
}

test('private, metadata, loopback and mixed destinations are refused before any connection', async () => {
  const names = { 'internal.test': ['10.0.0.5'], 'metadata.test': ['169.254.169.254'], 'mixed.test': ['93.184.216.34', '192.168.0.2'], 'postgres': ['172.18.0.4'] };
  const proxy = await startEgressProxy({ resolve: async name => { if (!(name in names)) throw new Error('ENOTFOUND'); return names[name]; } });
  try {
    for (const target of ['internal.test:443', 'metadata.test:80', 'mixed.test:443', 'postgres:5432', '127.0.0.1:22', '[::1]:443', '169.254.169.254:80', 'unknown.test:443'])
      assert.match(await connect(proxy, target), /403/, target);
    assert.equal((await get(proxy, 'http://metadata.test/latest/meta-data/')).status, 403);
    assert.equal((await get(proxy, 'http://10.1.2.3/')).status, 403);
  } finally { await proxy.close(); }
});

test('allowed destinations are tunnelled and forwarded to the vetted address', async () => {
  const site = http.createServer((request, response) => response.end(`ok ${request.headers.host} ${request.url}`));
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const sitePort = site.address().port;
  const proxy = await startEgressProxy({ resolve: async () => ['127.0.0.1'], allow: () => true });
  try {
    assert.deepEqual(await get(proxy, `http://site.test:${sitePort}/page?q=1`), { status: 200, body: `ok site.test:${sitePort} /page?q=1` });
    assert.match(await connect(proxy, `site.test:${sitePort}`), /200/);
  } finally { await proxy.close(); site.close(); }
});
