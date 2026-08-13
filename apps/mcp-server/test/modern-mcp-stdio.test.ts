import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  MAX_MCP_IN_FLIGHT_REQUESTS,
  MAX_MCP_LINE_BYTES,
  serveModernMcpStdio,
  type ModernMcpRequest,
  type ModernMcpResponse,
} from "../src/modern-mcp-stdio.ts";

type Deferred<T = void> = { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void };

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function response(request: ModernMcpRequest, value: unknown): ModernMcpResponse {
  return { jsonrpc: "2.0", id: request.id, result: { resultType: "complete", value } };
}

function harness(handleRequest: Parameters<typeof serveModernMcpStdio>[0]["handleRequest"]) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => { text += chunk; });
  const serving = serveModernMcpStdio({ readable: input, writable: output, handleRequest });
  return {
    input,
    serving,
    responses(): ModernMcpResponse[] {
      return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ModernMcpResponse);
    },
  };
}

test("modern stdio accepts concurrent newline JSON and serializes completed responses", async () => {
  const releaseFirst = deferred();
  const started = deferred();
  const firstFinished = deferred();
  const current = harness(async (request) => {
    if (request.id === 1) {
      started.resolve();
      await releaseFirst.promise;
      firstFinished.resolve();
    }
    return response(request, request.method);
  });
  current.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "slow" })}\n`);
  await started.promise;
  current.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "fast" })}\n`);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(current.responses().map((item) => item.id), [2]);
  releaseFirst.resolve();
  await firstFinished.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  current.input.end();
  await current.serving;
  assert.deepEqual(current.responses().map((item) => item.id), [2, 1]);
});

test("fragmented UTF-8 request lines are assembled once without corrupting code points", async () => {
  const seen: string[] = [];
  const current = harness(async (request) => {
    seen.push(request.method);
    return response(request, request.params?.label);
  });
  const line = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { label: "café 😀" } })}\n`);
  for (let index = 0; index < line.length; index += 1) current.input.write(line.subarray(index, index + 1));
  current.input.end();
  await current.serving;
  assert.deepEqual(seen, ["tools/call"]);
  assert.deepEqual(current.responses().map((item) => "result" in item ? item.result : null), [
    { resultType: "complete", value: "café 😀" },
  ]);
});

test("cancellation aborts and suppresses the exact active request", async () => {
  const aborted = deferred();
  const current = harness(async (request, context) => {
    await new Promise<void>((resolve) => {
      context.signal.addEventListener("abort", () => { aborted.resolve(); resolve(); }, { once: true });
    });
    return response(request, "should_not_be_written");
  });
  current.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "cancel-me", method: "tools/call" })}\n`);
  current.input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "cancel-me", reason: "operator" } })}\n`);
  await aborted.promise;
  current.input.end();
  await current.serving;
  assert.deepEqual(current.responses(), []);
});

test("invalid requests, duplicate ids, and capacity overflow use closed JSON-RPC errors", async () => {
  const hold = deferred();
  const current = harness(async (request) => {
    await hold.promise;
    return response(request, true);
  });
  current.input.write("not json\n");
  current.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "held" })}\n`);
  current.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "duplicate" })}\n`);
  for (let id = 2; id <= MAX_MCP_IN_FLIGHT_REQUESTS + 1; id += 1) {
    current.input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "held" })}\n`);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  const errors = current.responses().filter((item) => "error" in item);
  assert.equal(errors.some((item) => !("id" in item)), true);
  assert.equal(errors.some((item) => "error" in item && item.error.code === -32700), true);
  assert.equal(errors.some((item) => "error" in item && item.error.data
    && (item.error.data as { errorCode?: string }).errorCode === "duplicate_request_id"), true);
  assert.equal(errors.some((item) => "error" in item && item.error.data
    && (item.error.data as { errorCode?: string }).errorCode === "mcp_in_flight_limit"), true);
  hold.resolve();
  current.input.end();
  await current.serving;
});

test("a line over the 4 MiB boundary fails closed without invoking the handler", async () => {
  let calls = 0;
  const current = harness(async (request) => { calls += 1; return response(request, true); });
  current.input.end(Buffer.alloc(MAX_MCP_LINE_BYTES + 1, 0x20));
  await current.serving;
  assert.equal(calls, 0);
  assert.equal(current.responses().some((item) => "error" in item
    && item.error.data && (item.error.data as { errorCode?: string }).errorCode === "mcp_line_too_large"), true);
});

test("EOF with an incomplete nonempty JSON line is rejected instead of silently discarded", async () => {
  let calls = 0;
  const current = harness(async (request) => { calls += 1; return response(request, true); });
  current.input.end('{"jsonrpc":"2.0","id":7');
  await current.serving;
  assert.equal(calls, 0);
  assert.equal(current.responses().some((item) => "error" in item
    && item.error.data && (item.error.data as { errorCode?: string }).errorCode === "incomplete_json_line"), true);
});

test("empty lines are malformed messages rather than a compatibility no-op", async () => {
  let calls = 0;
  const current = harness(async (request) => { calls += 1; return response(request, true); });
  current.input.end("\n");
  await current.serving;
  assert.equal(calls, 0);
  assert.equal(current.responses().some((item) => "error" in item
    && item.error.data && (item.error.data as { errorCode?: string }).errorCode === "invalid_json"), true);
});
