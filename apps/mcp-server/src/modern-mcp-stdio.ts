import { TextDecoder } from "node:util";
import type { Readable, Writable } from "node:stream";

export const MODERN_MCP_PROTOCOL_VERSION = "2026-07-28" as const;
export const MAX_MCP_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_MCP_IN_FLIGHT_REQUESTS = 256;
const MAX_MCP_QUEUED_OUTPUT_BYTES = 64 * 1024 * 1024;

export type JsonRpcId = string | number;

export type ModernMcpRequest = Readonly<{
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}>;

export type ModernMcpResponse =
  | Readonly<{ jsonrpc: "2.0"; id: JsonRpcId; result: unknown }>
  | Readonly<{ jsonrpc: "2.0"; id?: JsonRpcId; error: Readonly<{ code: number; message: string; data?: unknown }> }>;

export type ModernMcpRequestContext = Readonly<{
  signal: AbortSignal;
}>;

type InFlightRequest = {
  controller: AbortController;
  suppressed: boolean;
};

const decoder = new TextDecoder("utf-8", { fatal: true });

export async function serveModernMcpStdio(input: {
  readable: Readable;
  writable: Writable;
  handleRequest: (request: ModernMcpRequest, context: ModernMcpRequestContext) => Promise<ModernMcpResponse | null>;
}): Promise<void> {
  let bufferedChunks: Buffer[] = [];
  let bufferedBytes = 0;
  let ended = false;
  let terminal = false;
  let writeQueue = Promise.resolve();
  let queuedOutputBytes = 0;
  const inFlight = new Map<string, InFlightRequest>();
  const tasks = new Set<Promise<void>>();

  const requestKey = (id: JsonRpcId): string => `${typeof id}:${String(id)}`;

  const write = (message: ModernMcpResponse): Promise<void> => {
    const line = `${JSON.stringify(message)}\n`;
    const bytes = Buffer.byteLength(line);
    if (terminal || bytes > MAX_MCP_QUEUED_OUTPUT_BYTES
      || queuedOutputBytes + bytes > MAX_MCP_QUEUED_OUTPUT_BYTES) {
      terminal = true;
      input.readable.destroy();
      return Promise.reject(new Error("mcp_output_queue_overflow"));
    }
    queuedOutputBytes += bytes;
    const operation = async (): Promise<void> => {
      try {
        if (input.writable.write(line)) return;
        await new Promise<void>((resolve, reject) => {
          const cleanup = (): void => {
            input.writable.off("drain", onDrain);
            input.writable.off("error", onError);
            input.writable.off("close", onClose);
          };
          const onDrain = (): void => { cleanup(); resolve(); };
          const onError = (error: Error): void => { cleanup(); reject(error); };
          const onClose = (): void => { cleanup(); reject(new Error("mcp_output_closed")); };
          input.writable.once("drain", onDrain);
          input.writable.once("error", onError);
          input.writable.once("close", onClose);
        });
      } catch (error) {
        terminal = true;
        input.readable.destroy();
        throw error;
      } finally {
        queuedOutputBytes -= bytes;
      }
    };
    writeQueue = writeQueue.then(operation, operation);
    return writeQueue;
  };

  const protocolError = (id: JsonRpcId | undefined, code: number, message: string, data?: unknown): ModernMcpResponse => ({
    jsonrpc: "2.0",
    ...(id === undefined ? {} : { id }),
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });

  const cancel = (message: Record<string, unknown>): void => {
    const params = isObject(message.params) ? message.params : null;
    const requestId = params?.requestId;
    if (!isJsonRpcId(requestId)) return;
    const active = inFlight.get(requestKey(requestId));
    if (!active) return;
    active.suppressed = true;
    active.controller.abort(typeof params?.reason === "string" ? params.reason.slice(0, 240) : "cancelled_by_client");
  };

  const admit = (message: unknown): void => {
    if (!isObject(message) || message.jsonrpc !== "2.0") {
      void write(protocolError(undefined, -32600, "Invalid JSON-RPC request.")).catch(() => {});
      return;
    }
    if (message.method === "notifications/cancelled" && message.id === undefined) {
      cancel(message);
      return;
    }
    if (typeof message.method !== "string" || message.method.length === 0 || message.method.length > 240) {
      void write(protocolError(isJsonRpcId(message.id) ? message.id : undefined, -32600, "Invalid JSON-RPC request.")).catch(() => {});
      return;
    }
    if (message.id === undefined) return;
    if (!isJsonRpcId(message.id)) {
      void write(protocolError(undefined, -32600, "Request id must be a string or safe integer.")).catch(() => {});
      return;
    }
    if (message.params !== undefined && !isObject(message.params)) {
      void write(protocolError(message.id, -32602, "Request params must be an object.")).catch(() => {});
      return;
    }
    if (inFlight.size >= MAX_MCP_IN_FLIGHT_REQUESTS) {
      void write(protocolError(message.id, -32000, "Too many in-flight requests.", { errorCode: "mcp_in_flight_limit" })).catch(() => {});
      return;
    }
    const key = requestKey(message.id);
    if (inFlight.has(key)) {
      void write(protocolError(message.id, -32600, "Duplicate in-flight request id.", { errorCode: "duplicate_request_id" })).catch(() => {});
      return;
    }
    const request: ModernMcpRequest = {
      jsonrpc: "2.0",
      id: message.id,
      method: message.method,
      ...(message.params === undefined ? {} : { params: message.params }),
    };
    const active: InFlightRequest = { controller: new AbortController(), suppressed: false };
    inFlight.set(key, active);
    const task = (async (): Promise<void> => {
      try {
        const response = await input.handleRequest(request, { signal: active.controller.signal });
        if (!ended && !active.suppressed && response) await write(response);
      } catch {
        if (!ended && !terminal && !active.suppressed) {
          await write(protocolError(request.id, -32603, "Internal MCP request failure."));
        }
      } finally {
        inFlight.delete(key);
      }
    })();
    tasks.add(task);
    void task.then(() => tasks.delete(task), () => tasks.delete(task));
  };

  const processLine = (line: Buffer): void => {
    if (line.length === 0) {
      void write(protocolError(undefined, -32700, "Malformed MCP JSON line.", { errorCode: "invalid_json" })).catch(() => {});
      return;
    }
    if (line.length > MAX_MCP_LINE_BYTES) {
      void write(protocolError(undefined, -32700, "MCP JSON line exceeds the 4 MiB limit.", { errorCode: "mcp_line_too_large" })).catch(() => {});
      return;
    }
    try {
      admit(JSON.parse(decoder.decode(line)) as unknown);
    } catch {
      void write(protocolError(undefined, -32700, "Malformed MCP JSON line.", { errorCode: "invalid_json" })).catch(() => {});
    }
  };

  const onData = (chunk: Buffer | string): void => {
    if (ended || terminal) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (!terminal && offset <= incoming.length) {
      const newline = incoming.indexOf(0x0a, offset);
      const end = newline < 0 ? incoming.length : newline;
      const segment = incoming.subarray(offset, end);
      if (bufferedBytes + segment.length > MAX_MCP_LINE_BYTES) {
        void write(protocolError(undefined, -32700, "MCP JSON line exceeds the 4 MiB limit.", { errorCode: "mcp_line_too_large" })).catch(() => {});
        terminal = true;
        input.readable.destroy();
        return;
      }
      if (segment.length > 0) {
        bufferedChunks.push(Buffer.from(segment));
        bufferedBytes += segment.length;
      }
      if (newline < 0) break;
      let line = bufferedChunks.length === 1
        ? bufferedChunks[0]!
        : Buffer.concat(bufferedChunks, bufferedBytes);
      bufferedChunks = [];
      bufferedBytes = 0;
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      processLine(line);
      offset = newline + 1;
      if (offset === incoming.length) break;
    }
  };

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (!terminal && bufferedBytes > 0) {
        bufferedChunks = [];
        bufferedBytes = 0;
        void write(protocolError(undefined, -32700, "MCP JSON message was not newline-terminated.", { errorCode: "incomplete_json_line" })).catch(() => {});
      }
      ended = true;
      input.readable.off("data", onData);
      input.readable.off("end", finish);
      input.readable.off("close", finish);
      input.readable.off("error", finish);
      for (const active of inFlight.values()) {
        active.suppressed = true;
        active.controller.abort("mcp_input_closed");
      }
      resolve();
    };
    input.readable.on("data", onData);
    input.readable.once("end", finish);
    input.readable.once("close", finish);
    input.readable.once("error", finish);
    input.readable.resume();
  });

  await Promise.allSettled([...tasks]);
  terminal = true;
  await writeQueue.catch(() => undefined);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string"
    ? value.length <= 240
    : typeof value === "number" && Number.isSafeInteger(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
