import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {channel} from 'node:diagnostics_channel';
import { NativeChannel } from "../apps/mcp-server/src/native-wire.ts";
import { connectNative } from "../apps/mcp-server/src/native-client.ts";

const DIGEST = "a".repeat(64);

test('opt-in native diagnostics contain correlation and timing but no command data',async t=>{
  const root=await temporaryRoot(t,'diagnostics');
  const peer=await createFakePeer(t,root,{onRequest:(request,wire)=>response(wire,request,{})});
  const events=[],diagnostic=channel('newton-browser.native-command'),listener=event=>events.push(event);
  diagnostic.subscribe(listener);const client=await connect(peer);
  try{
    await client.call('command',{method:'Input.insertText',params:{text:'private-fixture-value'},token:'private-fixture-token'});
    assert.deepEqual(events.map(event=>event.phase),['sent','response']);
    assert.equal(events[0].connection,events[1].connection);assert.equal(events[0].id,events[1].id);
    assert.ok(events[1].at>=events[0].at);
    assert.ok(events.every(event=>Object.keys(event).sort().join()==='at,connection,id,method,phase'));
    assert.ok(!JSON.stringify(events).includes('private-fixture'));
  }finally{client.close();diagnostic.unsubscribe(listener);}
});

test('malformed native result envelopes cannot acknowledge an input command',async t=>{
  for(const [name,payload] of Object.entries({missing:{},null:{result:null},array:{result:[]},scalar:{result:true},conflicting:{result:{},error:'failed'}})){
    await t.test(name,async t=>{
      const root=await temporaryRoot(t,`result-${name}`);
      const peer=await createFakePeer(t,root,{onRequest:(request,channel)=>channel.send({type:'response',id:request.id,...payload})});
      const client=await connect(peer);
      try{await assert.rejects(client.call('command',{}),/native_protocol_mismatch/);assert.equal(client.signal.aborted,true);}
      finally{client.close();}
    });
  }
});

function endpointFor(root, epoch) {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\newton-browser-${epoch}`
    : path.join(root, `socket-${epoch}`);
}

async function temporaryRoot(t, label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `newton-native-client-${label}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function createFakePeer(t, root, { hello = { epoch: "browser-instance", digest: DIGEST, protocolMajor: 1, capabilities: ["tab_claim", "inventory"] }, onRequest = () => {} } = {}) {
  const epoch = randomUUID();
  const endpoint = endpointFor(root, epoch);
  const advertisement = path.join(root, "connection.json");
  const token = "b".repeat(64);
  const sockets = new Set();
  const peers = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let peer;
    peer = new NativeChannel(socket, socket, (raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      if (raw.type === "connect") {
        if (raw.protocolMajor !== 1 || raw.token !== token) {
          socket.destroy();
          return;
        }
        void peer.send({ type: "connected", ...hello });
        return;
      }
      if (raw.type === "request") {
        void Promise.resolve(onRequest(raw, peer)).catch((error) => peer.send({ type: "response", id: raw.id, error: error instanceof Error ? error.message : "connection_failed" }));
      }
    }, () => { peers.delete(peer); });
    peers.add(peer);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  await fs.writeFile(advertisement, JSON.stringify({ version: 1, endpoint, token, epoch }));
  t.after(async () => {
    for (const peer of peers) peer.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
  });
  return { advertisement, endpoint, epoch, token, hello, peers, sockets };
}

function response(peer, request, result) {
  return peer.send({ type: "response", id: request.id, result });
}

async function connect(peer, expectedInstanceId = peer.hello.epoch) {
  return connectNative(peer.advertisement, expectedInstanceId);
}

test("malformed advertisements cannot redirect the client to an arbitrary endpoint", async (t) => {
  const root = await temporaryRoot(t, "advertisement");
  const epoch = randomUUID();
  const advertisement = path.join(root, "connection.json");
  await fs.writeFile(advertisement, JSON.stringify({
    version: 1,
    endpoint: process.platform === "win32" ? "\\\\.\\pipe\\arbitrary-native-pipe" : path.join(root, "arbitrary.sock"),
    token: "c".repeat(64),
    epoch,
  }));
  let connectCalls = 0;
  t.mock.method(net, "connect", () => {
    connectCalls++;
    throw new Error("unexpected_socket_selection");
  });
  await assert.rejects(connectNative(advertisement), /native_advertisement_invalid/);
  assert.equal(connectCalls, 0);
});

test("malformed or mismatched peer hello is rejected without exposing the client", async (t) => {
  const cases = [
    { name: "epoch", hello: { epoch: "bad epoch", digest: DIGEST, protocolMajor: 1, capabilities: [] } },
    { name: "digest", hello: { epoch: "browser-instance", digest: "invalid", protocolMajor: 1, capabilities: [] } },
    { name: "capability", hello: { epoch: "browser-instance", digest: DIGEST, protocolMajor: 1, capabilities: ["bad-capability"] } },
  ];
  for (const current of cases) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `newton-native-client-hello-${current.name}-`));
    const peer = await createFakePeer(t, root, { hello: current.hello });
    try {
      await assert.rejects(connectNative(peer.advertisement), /native_protocol_mismatch/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
  const root = await temporaryRoot(t, "instance");
  const peer = await createFakePeer(t, root);
  await assert.rejects(connectNative(peer.advertisement, "different-instance"), /browser_instance_changed/);
});

test("correlates concurrent responses by request id even when the peer replies out of order", async (t) => {
  const root = await temporaryRoot(t, "correlation");
  const requests = [];
  const peer = await createFakePeer(t, root, {
    onRequest: async (raw, channel) => {
      requests.push(raw);
      if (requests.length === 2) {
        await response(channel, requests[1], { value: requests[1].args.value });
        await response(channel, requests[0], { value: requests[0].args.value });
      }
    },
  });
  const client = await connect(peer);
  try {
    const [first, second] = await Promise.all([
      client.call("first", { value: 1 }),
      client.call("second", { value: 2 }),
    ]);
    assert.deepEqual(first, { value: 1 });
    assert.deepEqual(second, { value: 2 });
    assert.equal(requests.length, 2);
  } finally {
    client.close();
    client.close();
  }
});

test("native disconnect rejects every pending request and close is idempotent", async (t) => {
  const root = await temporaryRoot(t, "disconnect");
  const peer = await createFakePeer(t, root, { onRequest: async () => {} });
  const client = await connect(peer);
  const pending = client.call("pending", {});
  for (const socket of peer.sockets) socket.destroy();
  await assert.rejects(pending, /connection_lost/);
  assert.equal(client.signal.aborted, true);
  client.close();
  client.close();
});

test("read-only timeout rejects without closing the connection, while mutation timeout closes it", async (t) => {
  const readRoot = await temporaryRoot(t, "readonly-timeout");
  let respondToReadRecovery = false;
  const readPeer = await createFakePeer(t, readRoot, {
    onRequest: async (raw, channel) => {
      if (respondToReadRecovery) await response(channel, raw, { state: "alive" });
    },
  });
  const readClient = await connect(readPeer);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pendingRead = readClient.call("inventory", {}, true);
    t.mock.timers.tick(10_000);
    await assert.rejects(pendingRead, /native_command_timeout/);
    assert.equal(readClient.signal.aborted, false);
    respondToReadRecovery = true;
    assert.deepEqual(await readClient.call("inventory", {}, true), { state: "alive" });
  } finally {
    t.mock.timers.reset();
    readClient.close();
  }

  const mutationRoot = await temporaryRoot(t, "mutation-timeout");
  const mutationPeer = await createFakePeer(t, mutationRoot, { onRequest: async () => {} });
  const mutationClient = await connect(mutationPeer);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pendingMutation = mutationClient.call("claim", {}, false);
    t.mock.timers.tick(10_000);
    await assert.rejects(pendingMutation, /native_command_timeout/);
    assert.equal(mutationClient.signal.aborted, true);
    await assert.rejects(mutationClient.call("claim", {}), /connection_lost/);
  } finally {
    t.mock.timers.reset();
    mutationClient.close();
  }
});

test("malformed response errors are normalized and never leak peer text", async (t) => {
  const root = await temporaryRoot(t, "response-error");
  const peer = await createFakePeer(t, root, {
    onRequest: async (raw, channel) => channel.send({ type: "response", id: raw.id, error: "private renderer detail: secret-token" }),
  });
  const client = await connect(peer);
  try {
    await assert.rejects(client.call("inventory", {}), (error) => {
      assert.equal(error.message, "connection_failed");
      assert.equal(error.message.includes("secret-token"), false);
      return true;
    });
  } finally {
    client.close();
  }
});

test('a second hello cannot change connection identity after startup',async t=>{
  const root=await temporaryRoot(t,'duplicate-hello');
  const peer=await createFakePeer(t,root,{onRequest:async(_request,channel)=>channel.send({type:'hello',epoch:'replacement',digest:DIGEST,protocolMajor:1,capabilities:[]})});
  const client=await connect(peer);
  try{await assert.rejects(client.call('inventory',{},true),/native_protocol_mismatch/);assert.equal(client.signal.aborted,true);}finally{client.close();}
});

test('untyped messages cannot satisfy a pending request',async t=>{
  const root=await temporaryRoot(t,'untyped-reply');
  const peer=await createFakePeer(t,root,{onRequest:async(request,channel)=>channel.send({id:request.id,result:{accepted:true}})});
  const client=await connect(peer);
  try{await assert.rejects(client.call('claim',{}),/native_protocol_mismatch/);assert.equal(client.signal.aborted,true);}finally{client.close();}
});
