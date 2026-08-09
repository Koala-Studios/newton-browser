import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

import { WebSocket } from "ws";

import { createNewtonBrowserHost } from "../src/bridge.ts";

type Message = Record<string, any>;

function createInbox(socket: WebSocket) {
  const messages: Message[] = [];
  const waiters: Array<{ predicate: (message: Message) => boolean; resolve: (message: Message) => void }> = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Message;
    messages.push(message);
    const index = waiters.findIndex(({ predicate }) => predicate(message));
    if (index < 0) return;
    const [waiter] = waiters.splice(index, 1);
    waiter!.resolve(message);
  });
  return {
    messages,
    next(predicate: (message: Message) => boolean): Promise<Message> {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
  };
}

async function connectExtension(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { Origin: "chrome-extension://aip01-acceptance" },
  });
  const inbox = createInbox(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const ready = inbox.next((message) => message.type === "client_ready");
  socket.send(JSON.stringify({
    type: "client_hello",
    clientId: `aip01_${randomUUID().replaceAll("-", "")}`,
    browserFamily: "chrome",
    browserMajor: 130,
  }));
  await ready;
  return { socket, inbox };
}

async function request(socket: WebSocket, inbox: ReturnType<typeof createInbox>, method: string, params: unknown) {
  const requestId = `aip01_${randomUUID()}`;
  const response = inbox.next((message) => message.type === "bridge_response" && message.requestId === requestId);
  socket.send(JSON.stringify({ type: "bridge_request", requestId, method, params }));
  return response;
}

async function complete(
  socket: WebSocket,
  inbox: ReturnType<typeof createInbox>,
  envelope: Message,
  result: unknown,
) {
  return request(socket, inbox, "postResult", {
    event: {
      commandId: envelope.command.commandId,
      sessionEpoch: envelope.command.sessionEpoch,
      sequence: envelope.command.sequence,
      ok: true,
      outcome: "completed",
      retrySafe: false,
      result,
    },
  });
}

test("AIP-01 acceptance: FIFO, cross-session progress, and timeout phases compose", { timeout: 10_000 }, async () => {
  const bridge = createNewtonBrowserHost({
    authMode: "local_trust",
    browserTarget: "chrome",
    limits: { maxCommandTimeoutMs: 2_000 },
  });
  const address = await bridge.listen(0, "127.0.0.1");
  const { socket, inbox } = await connectExtension(address.port);

  try {
    const sessionA = bridge.createSession({ origin: "https://a.example", allowedOrigins: ["https://a.example"], tabMode: "owned_group" });
    const sessionB = bridge.createSession({ origin: "https://b.example", allowedOrigins: ["https://b.example"], tabMode: "owned_group" });
    await request(socket, inbox, "subscribeSession", { sessionId: sessionA.sessionId });
    await request(socket, inbox, "subscribeSession", { sessionId: sessionB.sessionId });

    const wireA1Promise = inbox.next((message) => message.type === "bridge_command" && message.command?.sessionId === sessionA.sessionId && message.command.sequence === 1);
    const wireB1Promise = inbox.next((message) => message.type === "bridge_command" && message.command?.sessionId === sessionB.sessionId && message.command.sequence === 1);
    const a1 = bridge.dispatch(sessionA.sessionId, { kind: "observe", query: "a1" }, 2_000);
    const a2 = bridge.dispatch(sessionA.sessionId, { kind: "observe", query: "a2" }, 2_000);
    const b1 = bridge.dispatch(sessionB.sessionId, { kind: "observe", query: "b1" }, 2_000);

    const [wireA1, wireB1] = await Promise.all([wireA1Promise, wireB1Promise]);
    const aCommandsBeforeRelease = inbox.messages.filter((message) => message.type === "bridge_command" && message.command?.sessionId === sessionA.sessionId);
    assert.deepEqual(aCommandsBeforeRelease.map((message) => message.command.sequence), [1]);

    await complete(socket, inbox, wireB1, { marker: "b1" });
    assert.equal((await b1).outcome, "completed", "session B must progress while session A is blocked");

    const wireA2Promise = inbox.next((message) => message.type === "bridge_command" && message.command?.sessionId === sessionA.sessionId && message.command.sequence === 2);
    await complete(socket, inbox, wireA1, { marker: "a1" });
    const wireA2 = await wireA2Promise;
    await complete(socket, inbox, wireA2, { marker: "a2" });
    assert.deepEqual([(await a1).sequence, (await a2).sequence], [1, 2]);

    const timeoutSession = bridge.createSession({ origin: "https://timeout.example", allowedOrigins: ["https://timeout.example"], tabMode: "owned_group" });
    await request(socket, inbox, "subscribeSession", { sessionId: timeoutSession.sessionId });
    const timeoutWire = inbox.next((message) => message.type === "bridge_command" && message.command?.sessionId === timeoutSession.sessionId);
    const sent = bridge.dispatch(timeoutSession.sessionId, { kind: "observe", query: "sent" }, 400);
    const queued = bridge.dispatch(timeoutSession.sessionId, { kind: "observe", query: "queued" }, 100);
    await timeoutWire;

    const queuedResult = await queued;
    if (queuedResult.ok) assert.fail("queued timeout unexpectedly succeeded");
    assert.equal(queuedResult.errorCode, "command_timeout");
    assert.equal(queuedResult.outcome, "not_started");
    assert.equal(queuedResult.retrySafe, true);

    const sentResult = await sent;
    if (sentResult.ok) assert.fail("sent timeout unexpectedly succeeded");
    assert.equal(sentResult.errorCode, "command_timeout");
    assert.equal(sentResult.outcome, "outcome_unknown");
    assert.equal(sentResult.retrySafe, false);
    const timeoutCommands = inbox.messages.filter((message) => message.type === "bridge_command" && message.command?.sessionId === timeoutSession.sessionId);
    assert.equal(timeoutCommands.length, 1, "timed-out queued work must never reach the extension");
  } finally {
    socket.close();
    await bridge.close();
  }
});
