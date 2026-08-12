import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import {
  policyProxyLaunchConfiguration,
  startPolicyProxy,
} from "../../src/browser-runtime/policy-proxy.ts";

test("policy proxy listens only on loopback and forwards an exact allowed HTTP origin", async () => {
  let connections = 0;
  let authority = "";
  const upstream = http.createServer((request, response) => {
    assert.equal(request.url, "/allowed?q=1");
    assert.equal(request.headers.host, authority);
    assert.equal(request.headers["proxy-connection"], undefined);
    response.end("allowed");
  });
  upstream.on("connection", () => { connections += 1; });
  await listen(upstream);
  authority = addressAuthority(upstream);
  const origin = `http://${authority}`;
  const proxy = await startPolicyProxy({ allowedOrigins: [origin] });
  try {
    assert.equal(proxy.host, "127.0.0.1");
    const response = await rawExchange(proxy.port,
      `GET ${origin}/allowed?q=1 HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: keep-alive\r\nConnection: close\r\n\r\n`);
    assert.match(response, /^HTTP\/1\.1 200/u);
    assert.match(response, /allowed$/u);
    assert.equal(connections, 1);
    const ledger = proxy.ledger();
    assert.equal(ledger.requestsAllowed, 1);
    assert.equal(ledger.requestsDenied, 0);
    assert.equal(ledger.upstreamConnections, 1);
    assert.equal(ledger.tunnelsOpened, 0);
    assert.equal(ledger.upgradesOpened, 0);
    assert.equal(ledger.activeUpstreamConnections, 0);
    assert.equal(ledger.closed, false);
    assert.deepEqual(ledger.reasons, {});
  } finally {
    await proxy.close();
    await closeServer(upstream);
  }
  assert.equal(proxy.ledger().closed, true);
  assert.equal(proxy.ledger().activeClientConnections, 0);
  assert.equal(proxy.ledger().activeUpstreamConnections, 0);
  await proxy.closed;
});

test("policy proxy reaches an IPv4-only localhost origin when DNS prefers IPv6", async () => {
  const upstream = http.createServer((_request, response) => response.end("ipv4-localhost"));
  await listen(upstream);
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const authority = `localhost:${address.port}`;
  const proxy = await startPolicyProxy({ allowedOrigins: [`http://${authority}`] });
  try {
    const response = await rawExchange(proxy.port,
      `GET http://${authority}/ipv4 HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`);
    assert.match(response, /^HTTP\/1\.1 200/u);
    assert.match(response, /ipv4-localhost$/u);
    assert.equal(proxy.ledger().upstreamConnections, 1);
  } finally {
    await proxy.close();
    await closeServer(upstream);
  }
});

test("denied HTTP destination is rejected before any upstream connection", async () => {
  const allowed = http.createServer((_request, response) => response.end("allowed"));
  const denied = http.createServer((_request, response) => response.end("must-not-arrive"));
  let deniedConnections = 0;
  denied.on("connection", () => { deniedConnections += 1; });
  await listen(allowed);
  await listen(denied);
  const proxy = await startPolicyProxy({ allowedOrigins: [`http://${addressAuthority(allowed)}`] });
  try {
    const deniedAuthority = addressAuthority(denied);
    const response = await rawExchange(proxy.port,
      `GET http://${deniedAuthority}/blocked HTTP/1.1\r\nHost: ${deniedAuthority}\r\nConnection: close\r\n\r\n`);
    assert.match(response, /^HTTP\/1\.1 403/u);
    assert.equal(deniedConnections, 0);
    assert.equal(proxy.ledger().upstreamConnections, 0);
    assert.equal(proxy.ledger().reasons.origin_denied, 1);
  } finally {
    await proxy.close();
    await Promise.all([closeServer(allowed), closeServer(denied)]);
  }
});

test("policy decisions remain aggregate-only and cannot be temporally attributed to an action", async () => {
  const allowed = http.createServer((_request, response) => response.end("allowed"));
  const denied = http.createServer((_request, response) => response.end("must-not-arrive"));
  let deniedConnections = 0;
  denied.on("connection", () => { deniedConnections += 1; });
  await Promise.all([listen(allowed), listen(denied)]);
  const allowedAuthority = addressAuthority(allowed);
  const deniedAuthority = addressAuthority(denied);
  const proxy = await startPolicyProxy({ allowedOrigins: [`http://${allowedAuthority}`] });
  try {
    const before = await rawExchange(proxy.port,
      `GET http://${deniedAuthority}/before HTTP/1.1\r\nHost: ${deniedAuthority}\r\nConnection: close\r\n\r\n`);
    assert.match(before, /^HTTP\/1\.1 403/u);

    const deniedResponse = await rawExchange(proxy.port,
      `GET http://${deniedAuthority}/worker.js HTTP/1.1\r\nHost: ${deniedAuthority}\r\nSec-Fetch-Dest: worker\r\nConnection: close\r\n\r\n`);
    assert.match(deniedResponse, /^HTTP\/1\.1 403/u);
    const allowedResponse = await rawExchange(proxy.port,
      `GET http://${allowedAuthority}/allowed HTTP/1.1\r\nHost: ${allowedAuthority}\r\nConnection: close\r\n\r\n`);
    assert.match(allowedResponse, /^HTTP\/1\.1 200/u);
    const after = await rawExchange(proxy.port,
      `GET http://${deniedAuthority}/after HTTP/1.1\r\nHost: ${deniedAuthority}\r\nConnection: close\r\n\r\n`);
    assert.match(after, /^HTTP\/1\.1 403/u);
    assert.equal(deniedConnections, 0);
    assert.equal(proxy.ledger().requestsDenied, 3);
    assert.equal("command" in proxy.ledger(), false);
  } finally {
    await proxy.close();
    await Promise.all([closeServer(allowed), closeServer(denied)]);
  }
});

test("ungranted read-only resources, documents, and fetches all remain zero-request denied", async () => {
  const granted = http.createServer((_request, response) => response.end("granted"));
  const destination = http.createServer((_request, response) => response.end("resource"));
  let destinationConnections = 0;
  destination.on("connection", () => { destinationConnections += 1; });
  await Promise.all([listen(granted), listen(destination)]);
  const proxy = await startPolicyProxy({ allowedOrigins: [`http://${addressAuthority(granted)}`] });
  try {
    const authority = addressAuthority(destination);
    const origin = `http://${authority}`;
    const image = await rawExchange(proxy.port,
      `GET ${origin}/pixel.svg HTTP/1.1\r\nHost: ${authority}\r\nSec-Fetch-Dest: image\r\nConnection: close\r\n\r\n`);
    assert.match(image, /^HTTP\/1\.1 403/u);
    const document = await rawExchange(proxy.port,
      `GET ${origin}/page HTTP/1.1\r\nHost: ${authority}\r\nSec-Fetch-Dest: iframe\r\nConnection: close\r\n\r\n`);
    assert.match(document, /^HTTP\/1\.1 403/u);
    const fetch = await rawExchange(proxy.port,
      `GET ${origin}/data HTTP/1.1\r\nHost: ${authority}\r\nSec-Fetch-Dest: empty\r\nConnection: close\r\n\r\n`);
    assert.match(fetch, /^HTTP\/1\.1 403/u);
    assert.equal(destinationConnections, 0);
  } finally {
    await proxy.close();
    await Promise.all([closeServer(granted), closeServer(destination)]);
  }
});

test("CONNECT permits only an exact granted HTTPS authority and tunnels after validation", async () => {
  const allowed = net.createServer((socket) => socket.pipe(socket));
  const denied = net.createServer((socket) => socket.destroy());
  let allowedConnections = 0;
  let deniedConnections = 0;
  allowed.on("connection", () => { allowedConnections += 1; });
  denied.on("connection", () => { deniedConnections += 1; });
  await listen(allowed);
  await listen(denied);
  const allowedAuthority = addressAuthority(allowed);
  const proxy = await startPolicyProxy({ allowedOrigins: [`https://${allowedAuthority}`] });
  let tunnelClient: net.Socket | undefined;
  try {
    const deniedAuthority = addressAuthority(denied);
    const deniedResponse = await rawExchange(proxy.port,
      `CONNECT ${deniedAuthority} HTTP/1.1\r\nHost: ${deniedAuthority}\r\n\r\n`);
    assert.match(deniedResponse, /^HTTP\/1\.1 403/u);
    assert.equal(deniedConnections, 0);

    tunnelClient = net.connect(proxy.port, "127.0.0.1");
    await connected(tunnelClient);
    const established = waitForData(tunnelClient, (value) => value.includes("\r\n\r\n"));
    tunnelClient.write(`CONNECT ${allowedAuthority} HTTP/1.1\r\nHost: ${allowedAuthority}\r\n\r\n`);
    assert.match(await established, /^HTTP\/1\.1 200/u);
    const echoed = waitForData(tunnelClient, (value) => value.includes("tunnel-payload"));
    tunnelClient.write("tunnel-payload");
    assert.match(await echoed, /tunnel-payload/u);
    assert.equal(allowedConnections, 1);
    assert.equal(proxy.ledger().tunnelsOpened, 1);
    assert.equal(proxy.ledger().upstreamConnections, 1);
  } finally {
    await proxy.close();
    assert.equal(tunnelClient?.closed, true);
    assert.equal(await connectionCount(allowed), 0);
    await Promise.all([closeServer(allowed), closeServer(denied)]);
  }
});

test("WebSocket upgrade shares the exact HTTP origin grant and denied upgrades make zero connections", async () => {
  const allowed = http.createServer();
  allowed.on("upgrade", (_request, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    socket.pipe(socket);
  });
  const denied = http.createServer();
  let allowedConnections = 0;
  let deniedConnections = 0;
  allowed.on("connection", () => { allowedConnections += 1; });
  denied.on("connection", () => { deniedConnections += 1; });
  await listen(allowed);
  await listen(denied);
  const allowedAuthority = addressAuthority(allowed);
  const proxy = await startPolicyProxy({ allowedOrigins: [`http://${allowedAuthority}`] });
  try {
    const deniedAuthority = addressAuthority(denied);
    const deniedResponse = await rawExchange(proxy.port,
      websocketRequest(`ws://${deniedAuthority}/socket`, deniedAuthority));
    assert.match(deniedResponse, /^HTTP\/1\.1 403/u);
    assert.equal(deniedConnections, 0);

    const socket = net.connect(proxy.port, "127.0.0.1");
    await connected(socket);
    const upgraded = waitForData(socket, (value) => value.includes("\r\n\r\n"));
    socket.write(websocketRequest(`ws://${allowedAuthority}/socket`, allowedAuthority));
    assert.match(await upgraded, /^HTTP\/1\.1 101/u);
    const echoed = waitForData(socket, (value) => value.includes("frame"));
    socket.write("frame");
    assert.match(await echoed, /frame/u);
    socket.end();
    await closed(socket);
    assert.equal(allowedConnections, 1);
    assert.equal(proxy.ledger().upgradesOpened, 1);
  } finally {
    await proxy.close();
    await Promise.all([closeServer(allowed), closeServer(denied)]);
  }
});

test("authority, authentication, target, method, and framing ambiguities fail closed without upstream", async () => {
  const upstream = http.createServer((_request, response) => response.end("unexpected"));
  let connections = 0;
  upstream.on("connection", () => { connections += 1; });
  await listen(upstream);
  const authority = addressAuthority(upstream);
  const proxy = await startPolicyProxy({ allowedOrigins: [`http://${authority}`] });
  const cases = [
    `GET http://${authority}/ HTTP/1.1\r\nConnection: close\r\n\r\n`,
    `GET http://${authority}/ HTTP/1.1\r\nHost: ${authority}\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`,
    `GET http://${authority}/ HTTP/1.1\r\nHost: example.invalid\r\nConnection: close\r\n\r\n`,
    `GET http://user@${authority}/ HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`,
    `GET http://127.0.0.01:${portOf(upstream)}/ HTTP/1.1\r\nHost: 127.0.0.01:${portOf(upstream)}\r\nConnection: close\r\n\r\n`,
    `GET http://127.0.0.1:00080/ HTTP/1.1\r\nHost: 127.0.0.1:00080\r\nConnection: close\r\n\r\n`,
    `GET https://${authority}/ HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`,
    `TRACE http://${authority}/ HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`,
    `GET http://${authority}/ HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Basic dGVzdA==\r\nConnection: close\r\n\r\n`,
    `GET http://${authority}/ HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: upgrade\r\nConnection: close\r\n\r\n`,
    `POST http://${authority}/ HTTP/1.1\r\nHost: ${authority}\r\nContent-Length: 1048577\r\nConnection: close\r\n\r\n`,
    `POST http://${authority}/ HTTP/1.1\r\nHost: ${authority}\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n`,
  ];
  try {
    for (const raw of cases) {
      const response = await rawExchange(proxy.port, raw);
      assert.match(response, /^HTTP\/1\.1 (?:400|403|405|407|413)/u);
    }
    assert.equal(connections, 0);
    assert.equal(proxy.ledger().upstreamConnections, 0);
    assert.ok((proxy.ledger().reasons.invalid_framing ?? 0) >= 1);
    assert.equal(proxy.ledger().reasons.proxy_auth_forbidden, 1);
    assert.equal(proxy.ledger().reasons.userinfo_forbidden, 1);
    assert.equal(proxy.ledger().reasons.unsupported_scheme, 1);
    assert.equal(proxy.ledger().reasons.unsupported_method, 1);
    assert.equal(proxy.ledger().reasons.request_too_large, 1);
  } finally {
    await proxy.close();
    await closeServer(upstream);
  }
});

test("allowlist and lifecycle limits are strict, bounded, and immutable", async () => {
  await assert.rejects(startPolicyProxy({ allowedOrigins: [] }), /policy_proxy_invalid_allowlist/u);
  await assert.rejects(startPolicyProxy({ allowedOrigins: ["http://example.com/path"] }), /policy_proxy_invalid_allowlist/u);
  await assert.rejects(startPolicyProxy({ allowedOrigins: ["http://user@example.com"] }), /policy_proxy_invalid_allowlist/u);
  await assert.rejects(startPolicyProxy({ allowedOrigins: ["ftp://example.com"] }), /policy_proxy_invalid_allowlist/u);
  await assert.rejects(startPolicyProxy({ allowedOrigins: ["http://example.com"], maxConnections: 0 }), /policy_proxy_invalid_limit/u);

  const proxy = await startPolicyProxy({ allowedOrigins: ["http://example.com"] });
  assert.equal(Object.isFrozen(proxy), true);
  const launch = policyProxyLaunchConfiguration(proxy);
  assert.deepEqual(launch, {
    host: "127.0.0.1",
    port: proxy.port,
    args: [
      `--proxy-server=http://127.0.0.1:${proxy.port}`,
      "--proxy-bypass-list=<-loopback>",
      "--disable-quic",
    ],
  });
  assert.equal(Object.isFrozen(launch), true);
  assert.equal(Object.isFrozen(launch.args), true);
  assert.throws(
    () => policyProxyLaunchConfiguration({ ...proxy } as PolicyProxy),
    /policy_proxy_capability_invalid/u,
  );
  assert.throws(
    () => policyProxyLaunchConfiguration({ ...proxy, port: proxy.port + 1, proxyUrl: "http://127.0.0.1:1" } as PolicyProxy),
    /policy_proxy_capability_invalid/u,
  );
  assert.throws(
    () => policyProxyLaunchConfiguration(Object.create(proxy) as PolicyProxy),
    /policy_proxy_capability_invalid/u,
  );
  const ledgerText = JSON.stringify(proxy.ledger());
  assert.doesNotMatch(ledgerText, /example\.com|https?:|\/|content|header|path|url/iu);
  const first = proxy.close();
  const second = proxy.close();
  assert.equal(first, second);
  await Promise.all([first, proxy.closed]);
  assert.equal(proxy.ledger().closed, true);
  assert.equal(Object.isFrozen(proxy.ledger().reasons), true);
  assert.throws(() => policyProxyLaunchConfiguration(proxy), /policy_proxy_not_ready/u);

  const capped = await startPolicyProxy({ allowedOrigins: ["http://example.com"], maxConnections: 1 });
  const held = net.connect(capped.port, "127.0.0.1");
  await connected(held);
  const rejected = net.connect(capped.port, "127.0.0.1");
  await connected(rejected);
  await closed(rejected);
  assert.equal(capped.ledger().reasons.connection_limit, 1);
  assert.equal(capped.ledger().upstreamConnections, 0);
  held.destroy();
  await capped.close();
  assert.equal(held.closed, true);
});

test("close prevents a queued keep-alive request from registering a late upstream resource", async () => {
  let markFirstRequest!: () => void;
  const firstRequest = new Promise<void>((resolve) => { markFirstRequest = resolve; });
  const first = http.createServer(() => markFirstRequest());
  const queued = http.createServer((_request, response) => response.end("must-not-arrive"));
  let firstConnections = 0;
  let queuedConnections = 0;
  first.on("connection", () => { firstConnections += 1; });
  queued.on("connection", () => { queuedConnections += 1; });
  await Promise.all([listen(first), listen(queued)]);
  const firstAuthority = addressAuthority(first);
  const queuedAuthority = addressAuthority(queued);
  const proxy = await startPolicyProxy({
    allowedOrigins: [`http://${firstAuthority}`, `http://${queuedAuthority}`],
  });
  const client = net.connect(proxy.port, "127.0.0.1");
  client.on("error", () => undefined);
  try {
    await connected(client);
    client.write(`GET http://${firstAuthority}/held HTTP/1.1\r\nHost: ${firstAuthority}\r\nConnection: keep-alive\r\n\r\n`);
    await firstRequest;
    assert.equal(firstConnections, 1);

    // The second request is queued to the already-accepted client socket. close()
    // flips the state and begins draining synchronously in this same turn, before
    // the proxy can dispatch the queued request on a later I/O callback.
    client.write(`GET http://${queuedAuthority}/late HTTP/1.1\r\nHost: ${queuedAuthority}\r\nConnection: close\r\n\r\n`);
    await proxy.close();

    assert.equal(queuedConnections, 0);
    assert.equal(client.closed, true);
    assert.equal(proxy.ledger().activeClientConnections, 0);
    assert.equal(proxy.ledger().activeUpstreamConnections, 0);
    assert.equal(await connectionCount(first), 0);
    assert.equal(await connectionCount(queued), 0);
  } finally {
    await proxy.close();
    client.destroy();
    await Promise.all([closeServer(first), closeServer(queued)]);
  }
});

test("browser-style speculative connection resets cannot crash or close the proxy", async () => {
  const proxy = await startPolicyProxy({ allowedOrigins: ["http://example.com"] });
  try {
    const socket = net.connect(proxy.port, "127.0.0.1");
    await connected(socket);
    if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
    else socket.destroy();
    await closed(socket);
    assert.equal(proxy.ledger().closed, false);
  } finally {
    await proxy.close();
  }
  assert.equal(proxy.ledger().activeClientConnections, 0);
});

function websocketRequest(target: string, authority: string): string {
  return `GET ${target} HTTP/1.1\r\nHost: ${authority}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`;
}

async function rawExchange(port: number, raw: string): Promise<string> {
  const socket = net.connect(port, "127.0.0.1");
  await connected(socket);
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.write(raw);
  await closed(socket);
  return Buffer.concat(chunks).toString("utf8");
}

function waitForData(socket: net.Socket, predicate: (value: string) => boolean): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      value += chunk.toString("utf8");
      if (!predicate(value)) return;
      cleanup();
      resolve(value);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error("socket_closed_before_expected_data")); };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function connected(socket: net.Socket): Promise<void> {
  if (!socket.connecting) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

function closed(socket: net.Socket): Promise<void> {
  if (socket.closed) return Promise.resolve();
  return new Promise<void>((resolve) => socket.once("close", resolve));
}

function listen(server: net.Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function connectionCount(server: net.Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.getConnections((error, count) => error ? reject(error) : resolve(count));
  });
}

function addressAuthority(server: net.Server): string {
  return `127.0.0.1:${portOf(server)}`;
}

function portOf(server: net.Server): number {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}
