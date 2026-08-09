import test from "node:test";
import assert from "node:assert/strict";

import {
  McpFrameParser,
  McpFrameParseError,
  MAX_MCP_BODY_BYTES,
  MAX_MCP_BUFFER_BYTES,
  MAX_MCP_HEADER_BYTES,
} from "../src/mcp-frame-parser.ts";

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

function createDeferred(): Deferred {
  let resolve: () => void;
  let reject: (error: unknown) => void;
  const promise = new Promise<void>((resolveOut, rejectOut) => {
    resolve = resolveOut;
    reject = rejectOut;
  });

  return { promise, resolve: resolve!, reject: reject! };
}

function makeParser(
  onMessage: (message: unknown, mode: "framed" | "json-line") => void | Promise<void> = () => {},
  onError: (error: McpFrameParseError, mode: "framed" | "json-line") => void | Promise<void> = () => {},
) {
  const messages: Array<{ mode: "framed" | "json-line"; message: unknown }> = [];
  const errors: McpFrameParseError[] = [];
  const parser = new McpFrameParser(
    async (message, mode) => {
      await onMessage(message, mode);
      messages.push({ mode, message });
    },
    async (error, mode) => {
      await onError(error, mode);
      errors.push(error);
    },
  );

  return { parser, messages, errors };
}

function makeFramedMessage(message: unknown, newline = "\r\n"): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}${newline}`, "utf8");
  return Buffer.concat([header, Buffer.from(newline, "utf8"), body]);
}

function feedBytewise(parser: McpFrameParser, payload: Buffer): void {
  for (let index = 0; index < payload.length; index += 1) {
    parser.push(Buffer.from([payload[index]]));
  }
}

function makeHeaderAtLimit(targetHeaderBytes: number, contentLength: number): string {
  const prefix = `Content-Length: ${contentLength}`;
  if (prefix.length > targetHeaderBytes) {
    throw new Error("content-length header exceeds target bytes");
  }

  return `${prefix}${" ".repeat(targetHeaderBytes - prefix.length)}`;
}

function splitIntoChunks(payload: Buffer, chunkSize: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let index = 0; index < payload.length; index += chunkSize) {
    chunks.push(payload.subarray(index, index + chunkSize));
  }

  return chunks;
}

function jsonLinePayload(length: number): Buffer {
  const prefix = Buffer.from('{"k":"', "utf8");
  const suffix = Buffer.from('"}\n', "utf8");
  const valueLength = length - prefix.length - suffix.length;
  if (valueLength < 0) {
    throw new Error("invalid length");
  }
  return Buffer.concat([prefix, Buffer.alloc(valueLength, 0x61), suffix]);
}

function terminatorFor(newline: "\r\n" | "\n"): string {
  return newline === "\r\n" ? "\r\n\r\n" : "\n\n";
}

test("parses mixed json-line and framed MCP messages from exact bytewise boundaries", async () => {
  const { parser, messages, errors } = makeParser();
  const stream = Buffer.concat([
    Buffer.from(JSON.stringify({ method: "ping" }) + "\n", "utf8"),
    makeFramedMessage({ jsonrpc: "2.0", method: "initialize" }),
  ]);
  feedBytewise(parser, stream);
  await parser.flush();

  assert.equal(errors.length, 0);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].mode, "json-line");
  assert.equal(messages[1].mode, "framed");
  assert.deepEqual(messages[0].message, { method: "ping" });
  assert.deepEqual(messages[1].message, { jsonrpc: "2.0", method: "initialize" });
});

test("supports fragmented framed header and body boundaries", async () => {
  const { parser, messages, errors } = makeParser();
  const frame = makeFramedMessage({ method: "tools/list" });
  const chunks = [
    frame.subarray(0, 14),
    frame.subarray(14, 20),
    frame.subarray(20),
  ];

  for (const chunk of chunks) {
    parser.push(chunk);
  }
  await parser.flush();

  assert.equal(errors.length, 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].mode, "framed");
  assert.deepEqual(messages[0].message, { method: "tools/list" });
  assert.equal(errors.length, 0);
});

test("parses multiple frames contained in one chunk", async () => {
  const { parser, messages, errors } = makeParser();
  const chunk = Buffer.concat([
    Buffer.from(JSON.stringify({ a: 1 }) + "\n", "utf8"),
    makeFramedMessage({ b: 2 }),
    makeFramedMessage({ c: 3 }, "\r\n"),
  ]);
  parser.push(chunk);
  await parser.flush();

  assert.equal(errors.length, 0);
  assert.equal(messages.length, 3);
  assert.deepEqual(messages.map((entry) => entry.mode), ["json-line", "framed", "framed"]);
  assert.deepEqual(messages[0].message, { a: 1 });
  assert.deepEqual(messages[1].message, { b: 2 });
  assert.deepEqual(messages[2].message, { c: 3 });
});

test("preserves async callback ordering across frames", async () => {
  const order: string[] = [];
  const firstStart = createDeferred();
  const proceedFirst = createDeferred();

  const { parser, messages, errors } = makeParser(
    async (message, mode) => {
      if ((message as { step?: string })?.step === "first") {
        firstStart.resolve();
        await proceedFirst.promise;
      }
      order.push(mode + ":" + JSON.stringify(message));
    },
  );
  const stream = Buffer.concat([
    Buffer.from(JSON.stringify({ step: "first" }) + "\n", "utf8"),
    makeFramedMessage({ step: "second" }),
  ]);

  parser.push(stream);
  await firstStart.promise;
  const complete = parser.flush();
  proceedFirst.resolve();
  await complete;

  assert.equal(errors.length, 0);
  assert.equal(messages.length, 2);
  assert.deepEqual(order, [
    'json-line:{"step":"first"}',
    'framed:{"step":"second"}',
  ]);
});

test("rejects one-byte-over JSON-line by size with JSON-shaped payload", async () => {
  const { parser, errors, messages } = makeParser();
  const oversized = jsonLinePayload(MAX_MCP_BODY_BYTES + 2);
  parser.push(oversized);
  await parser.flush();

  assert.equal(parser.isTerminalFailure, true);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "body_too_large");
  assert.equal(messages.length, 0);
  assert.equal(parser.bufferedByteCount, 0);

  parser.push(Buffer.from(JSON.stringify({ ok: true }) + "\n", "utf8"));
  await parser.flush();
  assert.equal(messages.length, 0);
  assert.equal(errors.length, 1);
});

test("accepts 16 KiB header boundary with CRLF and rejects +1", async () => {
  const { parser, errors, messages } = makeParser();
  const header = makeHeaderAtLimit(MAX_MCP_HEADER_BYTES, 2);

  parser.push(Buffer.from(header, "utf8"));
  parser.push(Buffer.from(terminatorFor("\r\n") + "{}", "utf8"));
  await parser.flush();

  assert.equal(errors.length, 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].mode, "framed");
  assert.deepEqual(messages[0].message, {});

  const { parser: parserPlus, errors: errorsPlus } = makeParser();
  const hugeHeader = `${header}A`;
  parserPlus.push(Buffer.from(hugeHeader, "utf8"));
  await parserPlus.flush();

  assert.equal(errorsPlus.length, 1);
  assert.equal(errorsPlus[0].code, "header_too_large");
  assert.equal(parserPlus.bufferedByteCount, 0);
});

test("accepts 16 KiB header boundary with LF-only and rejects +1", async () => {
  const { parser, errors, messages } = makeParser();
  const header = makeHeaderAtLimit(MAX_MCP_HEADER_BYTES, 2);

  parser.push(Buffer.from(header, "utf8"));
  parser.push(Buffer.from(terminatorFor("\n") + "{}", "utf8"));
  await parser.flush();

  assert.equal(errors.length, 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].mode, "framed");
  assert.deepEqual(messages[0].message, {});

  const { parser: parserPlus, errors: errorsPlus } = makeParser();
  const hugeHeader = `${header}A`;
  parserPlus.push(Buffer.from(hugeHeader, "utf8"));
  await parserPlus.flush();

  assert.equal(errorsPlus.length, 1);
  assert.equal(errorsPlus[0].code, "header_too_large");
});

test("rejects one-byte-over declared Content-Length", async () => {
  const { parser, errors } = makeParser();
  const header = `Content-Length: ${MAX_MCP_BODY_BYTES + 1}\r\n\r\n`;
  parser.push(Buffer.from(header, "utf8"));
  await parser.flush();

  assert.equal(parser.isTerminalFailure, true);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "content_length_exceeded");
  assert.equal(parser.bufferedByteCount, 0);
});

test("accepts unknown headers while requiring one Content-Length", async () => {
  const { parser, messages, errors } = makeParser();
  const body = Buffer.from(JSON.stringify({ ok: true }), "utf8");
  const header = Buffer.from(
    `Content-Type: application/vscode-jsonrpc\r\nContent-Length: ${body.length}\r\n\r\n`,
    "utf8",
  );

  parser.push(Buffer.concat([header, body]));
  await parser.flush();

  assert.equal(errors.length, 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].mode, "framed");
  assert.deepEqual(messages[0].message, { ok: true });
});

test("rejects missing Content-Length header", async () => {
  const { parser, errors } = makeParser();
  parser.push(Buffer.from("X-Test: 1\r\n\r\n", "utf8"));
  await parser.flush();

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "missing_content_length");
});

test("rejects duplicate Content-Length with equal and conflicting values", async () => {
  const equal = makeParser();
  equal.parser.push(Buffer.from("Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}", "utf8"));
  await equal.parser.flush();
  assert.equal(equal.errors.length, 1);
  assert.equal(equal.errors[0].code, "duplicate_content_length");

  const conflicting = makeParser();
  conflicting.parser.push(Buffer.from("Content-Length: 2\r\nContent-Length: 3\r\n\r\n{}", "utf8"));
  await conflicting.parser.flush();
  assert.equal(conflicting.errors.length, 1);
  assert.equal(conflicting.errors[0].code, "duplicate_content_length");
});

test("rejects malformed Content-Length values", async () => {
  const { parser: parserNegative, errors: errorsNegative } = makeParser();
  parserNegative.push(Buffer.from("Content-Length: -1\r\n\r\n", "utf8"));
  await parserNegative.flush();

  assert.equal(errorsNegative.length, 1);
  assert.equal(errorsNegative[0].code, "negative_content_length");

  const { parser: parserNonDecimal, errors: errorsNonDecimal } = makeParser();
  parserNonDecimal.push(Buffer.from("Content-Length: abc\r\n\r\n", "utf8"));
  await parserNonDecimal.flush();

  assert.equal(errorsNonDecimal.length, 1);
  assert.equal(errorsNonDecimal[0].code, "non_decimal_content_length");

  const { parser: parserOverflow, errors: errorsOverflow } = makeParser();
  parserOverflow.push(Buffer.from("Content-Length: 18446744073709551616\r\n\r\n", "utf8"));
  await parserOverflow.flush();

  assert.equal(errorsOverflow.length, 1);
  assert.equal(errorsOverflow[0].code, "content_length_exceeded");
});

test("rejects malformed JSON in json-line framing", async () => {
  const { parser, errors } = makeParser();
  parser.push(Buffer.from('{"bad":}\n', "utf8"));
  await parser.flush();

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "invalid_json");
});

test("rejects malformed JSON in framed mode", async () => {
  const { parser, errors } = makeParser();
  const body = Buffer.from('{"bad":}', "utf8");
  parser.push(Buffer.from(`Content-Length: ${body.length}\r\n\r\n${body.toString("utf8")}`, "utf8"));
  await parser.flush();

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "invalid_json");
});

test("reports incomplete EOF for partial frame", async () => {
  const { parser, errors } = makeParser();
  parser.push(Buffer.from("Content-Length: 5", "utf8"));
  parser.end();
  await parser.flush();

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "incomplete_frame");
});

test("handles callback rejection without unhandled rejections", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => {
    unhandled.push(error);
  };
  process.once("unhandledRejection", onUnhandled);

  const { parser, errors } = makeParser(
    () => Promise.reject(new Error("callback_reject")),
  );
  parser.push(Buffer.from(JSON.stringify({ id: 1 }) + "\n", "utf8"));
  await parser.flush();

  process.off("unhandledRejection", onUnhandled);

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "callback_error");
  assert.equal(errors[0].message, "Message callback failed.");
  assert.equal(parser.isTerminalFailure, true);
  assert.equal(unhandled.length, 0);
});

test("does not expose attacker header bytes in error diagnostics", async () => {
  const { parser, errors } = makeParser();
  const hostileLine = `X-Secret: SECRET_TOKEN_ABC123`.padEnd(2000, "a");
  parser.push(Buffer.from(`${hostileLine}\r\n\r\n`, "utf8"));
  await parser.flush();

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "missing_content_length");
  assert.equal(errors[0].message.includes("SECRET_TOKEN_ABC123"), false);
});

test("does not expose callback error text", async () => {
  const { parser, errors } = makeParser(
    () => {
      throw new Error("SENSITIVE_CALLBACK_TEXT");
    },
  );
  parser.push(Buffer.from(JSON.stringify({ id: 1 }) + "\n", "utf8"));
  await parser.flush();

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "callback_error");
  assert.equal(errors[0].message.includes("SENSITIVE_CALLBACK_TEXT"), false);
});

test("does not emit messages after terminal failure; requires new parser instance", async () => {
  const { parser, errors, messages } = makeParser();
  parser.push(makeFramedMessage({ first: true }));
  parser.push(Buffer.from("Content-Length: bad\r\n\r\n{}", "utf8"));
  await parser.flush();

  assert.equal(messages.length, 1);
  assert.equal(errors[0].code, "non_decimal_content_length");
  assert.equal(parser.isTerminalFailure, true);
  assert.equal(parser.bufferedByteCount, 0);

  const secondBatch = Buffer.from(JSON.stringify({ recovered: true }) + "\n", "utf8");
  parser.push(secondBatch);
  await parser.flush();
  assert.equal(messages.length, 1);

  const recovery = makeParser();
  recovery.parser.push(secondBatch);
  await recovery.parser.flush();
  assert.equal(recovery.messages.length, 1);
  assert.deepEqual(recovery.messages[0].message, { recovered: true });
});

test("requires fresh parser instance to recover retained state", async () => {
  const recovered = makeParser();
  const firstInstance = makeParser();
  firstInstance.parser.push(Buffer.from('{"a":', "utf8"));
  firstInstance.parser.end();
  await firstInstance.parser.flush();
  assert.equal(firstInstance.errors.length, 1);
  assert.equal(firstInstance.errors[0].code, "incomplete_frame");

  recovered.parser.push(Buffer.from(JSON.stringify({ ok: true }) + "\n", "utf8"));
  await recovered.parser.flush();

  assert.equal(recovered.errors.length, 0);
  assert.equal(recovered.messages.length, 1);
  assert.deepEqual(recovered.messages[0].message, { ok: true });
  assert.equal(recovered.messages[0].mode, "json-line");
});

test("enforces exact total buffered upper bound", async () => {
  const { parser, errors } = makeParser();

  const header = Buffer.from(`Content-Length: ${MAX_MCP_BODY_BYTES}\r\n\r\n`, "utf8");
  const overLongBody = Buffer.alloc(MAX_MCP_BUFFER_BYTES + 1, 0x7b);

  parser.push(header);
  parser.push(overLongBody);
  await parser.flush();

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "buffer_too_large");
  assert.equal(parser.isTerminalFailure, true);
  assert.equal(parser.bufferedByteCount, 0);
});

test("resists overflow while callback is in-flight with many modest chunks", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => {
    unhandled.push(error);
  };
  process.once("unhandledRejection", onUnhandled);

  const started = createDeferred();
  const firstRelease = createDeferred();
  const messages: Array<{ mode: "framed" | "json-line"; message: unknown }> = [];
  const errors: McpFrameParseError[] = [];

  const parser = new McpFrameParser(
    async (message, mode) => {
      if ((message as { first?: boolean })?.first) {
        started.resolve();
        await firstRelease.promise;
      }
      messages.push({ mode, message });
    },
    async (error) => {
      errors.push(error);
    },
  );

  parser.push(makeFramedMessage({ first: true }));
  await started.promise;

  const bodyLength = MAX_MCP_BODY_BYTES;
  const header = Buffer.from(`Content-Length: ${bodyLength}\r\n\r\n`, "utf8");
  const nearLimitBody = Buffer.alloc(MAX_MCP_BUFFER_BYTES - header.length, 0x61);
  const chunks = splitIntoChunks(Buffer.concat([header, nearLimitBody]), 1024);
  for (const chunk of chunks) {
    parser.push(chunk);
  }
  assert.equal(parser.bufferedByteCount, MAX_MCP_BUFFER_BYTES);
  parser.push(Buffer.from("a"));
  firstRelease.resolve();
  await parser.flush();

  process.off("unhandledRejection", onUnhandled);

  assert.equal(parser.isTerminalFailure, true);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "buffer_too_large");
  assert.equal(unhandled.length, 0);
  assert.equal(messages.length, 1);
});

test("classifies overflow mode from pending framed header prefix during blocked callback", async () => {
  const started = createDeferred();
  const release = createDeferred();

  let errorMode: "framed" | "json-line" | null = null;
  const parser = new McpFrameParser(
    async (message) => {
      if ((message as { first?: boolean })?.first) {
        started.resolve();
        await release.promise;
      }
    },
    async (_error, mode) => {
      errorMode = mode;
    },
  );

  parser.push(makeFramedMessage({ first: true }));
  await started.promise;

  const pendingFramedHeader = Buffer.from("Content-Length: 0\r\n", "utf8");
  parser.push(pendingFramedHeader);
  parser.push(Buffer.alloc(MAX_MCP_BUFFER_BYTES - pendingFramedHeader.length + 1, 0x7b));
  release.resolve();
  await parser.flush();

  assert.equal(errorMode, "framed");
});

test("does not dispatch later complete frames after callback failure", async () => {
  const { parser, errors, messages } = makeParser(
    async () => {
      throw new Error("callback failed");
    },
  );

  const stream = Buffer.concat([
    Buffer.from(JSON.stringify({ first: true }) + "\n", "utf8"),
    makeFramedMessage({ second: true }),
  ]);

  parser.push(stream);
  await parser.flush();

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "callback_error");
  assert.equal(messages.length, 0);
  assert.equal(parser.isTerminalFailure, true);
});

test("orders end handling after in-flight callbacks and incomplete frame", async () => {
  const events: string[] = [];
  const started = createDeferred();
  const proceed = createDeferred();
  const errors: McpFrameParseError[] = [];

  const parser = new McpFrameParser(
    async () => {
      events.push("message");
      started.resolve();
      await proceed.promise;
    },
    async (error) => {
      events.push(`error:${error.code}`);
      errors.push(error);
    },
  );

  parser.push(Buffer.from(JSON.stringify({ done: true }) + "\n", "utf8"));
  await started.promise;
  parser.push(Buffer.from("Content-Length: 5", "utf8"));
  parser.end();

  proceed.resolve();
  await parser.flush();

  assert.deepEqual(events, ["message", "error:incomplete_frame"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "incomplete_frame");
});
