import type { Readable, Writable } from "node:stream";

export const DEFAULT_CDP_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_CDP_MAX_PENDING_REQUESTS = 256;
// Modern production pages can emit several hundred Network/Target events while
// one request-stage Fetch acknowledgement is in flight. Keep the queue bounded
// at the existing audited hard ceiling without making ordinary commerce/media
// navigation terminally tear down the private transport.
export const DEFAULT_CDP_MAX_EVENT_QUEUE = 1024;
export const DEFAULT_CDP_MAX_LISTENERS = 16;

export type CdpParams = Record<string, unknown>;
export type CdpEvent = Readonly<{
  method: string;
  params: CdpParams;
  sessionId: string | null;
}>;

export type CdpEventListener = (event: CdpEvent) => void | Promise<void>;

export type CdpTransportErrorCode =
  | "cdp_transport_closed"
  | "cdp_incomplete_frame"
  | "cdp_invalid_frame"
  | "cdp_message_too_large"
  | "cdp_pending_limit"
  | "cdp_event_queue_overflow"
  | "cdp_event_listener_limit"
  | "cdp_backpressure_limit"
  | "cdp_write_failed"
  | "cdp_protocol_error";

const ERROR_MESSAGES: Record<CdpTransportErrorCode, string> = {
  cdp_transport_closed: "CDP transport closed.",
  cdp_incomplete_frame: "CDP transport ended with an incomplete frame.",
  cdp_invalid_frame: "CDP transport received an invalid frame.",
  cdp_message_too_large: "CDP message exceeded the configured byte limit.",
  cdp_pending_limit: "CDP pending request limit reached.",
  cdp_event_queue_overflow: "CDP event queue limit reached.",
  cdp_event_listener_limit: "CDP event listener limit reached.",
  cdp_backpressure_limit: "CDP transport backpressure limit reached.",
  cdp_write_failed: "CDP transport write failed.",
  cdp_protocol_error: "CDP command failed.",
};

export class CdpTransportError extends Error {
  readonly code: CdpTransportErrorCode;

  constructor(code: CdpTransportErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CdpTransportError";
    this.code = code;
  }
}

type PendingRequest = Readonly<{
  resolve: (value: CdpParams) => void;
  reject: (error: CdpTransportError) => void;
}>;

export type CdpTransportOptions = Readonly<{
  maxMessageBytes?: number;
  maxPendingRequests?: number;
  maxEventQueue?: number;
  maxListeners?: number;
}>;

export interface PrivateCdpTransport {
  readonly closed: boolean;
  readonly pendingRequestCount: number;
  send(method: string, params?: CdpParams, sessionId?: string | null): Promise<CdpParams>;
  onEvent(listener: CdpEventListener): () => void;
  close(): void;
}

export class CdpPipeTransport implements PrivateCdpTransport {
  private readonly readable: Readable;
  private readonly writable: Writable;
  private readonly maxMessageBytes: number;
  private readonly maxPendingRequests: number;
  private readonly maxEventQueue: number;
  private readonly maxListeners: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<CdpEventListener>();
  private readonly eventQueue: CdpEvent[] = [];
  private eventProcessing = false;
  private nextId = 1;
  private buffer: Buffer = Buffer.alloc(0);
  private writeTail: Promise<void> = Promise.resolve();
  private terminalError: CdpTransportError | null = null;

  private readonly handleData = (chunk: Buffer | string): void => {
    this.consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  };
  private readonly handleEnd = (): void => {
    this.fail(this.buffer.length > 0 ? "cdp_incomplete_frame" : "cdp_transport_closed");
  };
  private readonly handleError = (): void => {
    this.fail("cdp_transport_closed");
  };
  private readonly handleClose = (): void => {
    this.fail(this.buffer.length > 0 ? "cdp_incomplete_frame" : "cdp_transport_closed");
  };

  constructor(readable: Readable, writable: Writable, options: CdpTransportOptions = {}) {
    this.readable = readable;
    this.writable = writable;
    this.maxMessageBytes = boundedInteger(options.maxMessageBytes, DEFAULT_CDP_MAX_MESSAGE_BYTES, 16 * 1024 * 1024);
    this.maxPendingRequests = boundedInteger(options.maxPendingRequests, DEFAULT_CDP_MAX_PENDING_REQUESTS, 1024);
    this.maxEventQueue = boundedInteger(options.maxEventQueue, DEFAULT_CDP_MAX_EVENT_QUEUE, 1024);
    this.maxListeners = boundedInteger(options.maxListeners, DEFAULT_CDP_MAX_LISTENERS, 64);
    readable.on("data", this.handleData);
    readable.once("end", this.handleEnd);
    readable.once("error", this.handleError);
    readable.once("close", this.handleClose);
    writable.once("error", this.handleError);
    writable.once("close", this.handleClose);
  }

  get closed(): boolean {
    return this.terminalError !== null;
  }

  get pendingRequestCount(): number {
    return this.pending.size;
  }

  send(method: string, params: CdpParams = {}, sessionId: string | null = null): Promise<CdpParams> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (!validMethod(method) || !plainRecord(params) || (sessionId !== null && !validSessionId(sessionId))) {
      return Promise.reject(new CdpTransportError("cdp_invalid_frame"));
    }
    if (this.pending.size >= this.maxPendingRequests) {
      return Promise.reject(new CdpTransportError("cdp_pending_limit"));
    }

    const id = this.allocateId();
    const message: CdpParams = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    let payload: Buffer;
    try {
      payload = Buffer.from(`${JSON.stringify(message)}\0`, "utf8");
    } catch {
      return Promise.reject(new CdpTransportError("cdp_invalid_frame"));
    }
    if (payload.length - 1 > this.maxMessageBytes) {
      return Promise.reject(new CdpTransportError("cdp_message_too_large"));
    }

    const result = new Promise<CdpParams>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    const write = this.writeTail.then(() => this.writePayload(payload));
    this.writeTail = write.catch(() => {});
    void write.catch(() => this.fail("cdp_write_failed"));
    return result;
  }

  onEvent(listener: CdpEventListener): () => void {
    if (this.terminalError) return () => {};
    if (this.listeners.has(listener)) return () => this.listeners.delete(listener);
    if (this.listeners.size >= this.maxListeners) {
      this.fail("cdp_event_listener_limit");
      return () => {};
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.fail("cdp_transport_closed");
    if (typeof this.writable.destroy === "function") this.writable.destroy();
    if (typeof this.readable.destroy === "function") this.readable.destroy();
  }

  private consume(chunk: Buffer): void {
    if (this.terminalError || chunk.length === 0) return;
    let offset = 0;
    while (!this.terminalError && offset < chunk.length) {
      const delimiter = chunk.indexOf(0, offset);
      const end = delimiter < 0 ? chunk.length : delimiter;
      const segment = chunk.subarray(offset, end);
      if (this.buffer.length + segment.length > this.maxMessageBytes) {
        this.fail("cdp_message_too_large");
        return;
      }
      if (segment.length > 0) {
        this.buffer = this.buffer.length === 0 ? segment : Buffer.concat([this.buffer, segment]);
      }
      if (delimiter < 0) return;
      const frame = this.buffer;
      this.buffer = Buffer.alloc(0);
      if (frame.length > 0) this.handleFrame(frame);
      offset = delimiter + 1;
    }
  }

  private handleFrame(frame: Buffer): void {
    let value: unknown;
    try {
      value = JSON.parse(frame.toString("utf8"));
    } catch {
      this.fail("cdp_invalid_frame");
      return;
    }
    if (!plainRecord(value)) {
      this.fail("cdp_invalid_frame");
      return;
    }

    if (Number.isSafeInteger(value.id) && Number(value.id) > 0) {
      const pending = this.pending.get(Number(value.id));
      if (!pending) {
        this.fail("cdp_invalid_frame");
        return;
      }
      this.pending.delete(Number(value.id));
      if (plainRecord(value.error)) pending.reject(new CdpTransportError("cdp_protocol_error"));
      else pending.resolve(plainRecord(value.result) ? value.result : {});
      return;
    }

    if (typeof value.method !== "string" || !validMethod(value.method)) {
      this.fail("cdp_invalid_frame");
      return;
    }
    if (value.sessionId !== undefined && (typeof value.sessionId !== "string" || !validSessionId(value.sessionId))) {
      this.fail("cdp_invalid_frame");
      return;
    }
    const event: CdpEvent = {
      method: value.method,
      params: plainRecord(value.params) ? value.params : {},
      sessionId: typeof value.sessionId === "string" && validSessionId(value.sessionId) ? value.sessionId : null,
    };
    if (this.eventQueue.length >= this.maxEventQueue) {
      this.fail("cdp_event_queue_overflow");
      return;
    }
    this.eventQueue.push(event);
    this.drainEvents();
  }

  private drainEvents(): void {
    if (this.eventProcessing || this.terminalError) return;
    this.eventProcessing = true;
    void (async () => {
      while (!this.terminalError) {
        const event = this.eventQueue.shift();
        if (!event) break;
        for (const listener of [...this.listeners]) {
          if (!this.listeners.has(listener)) continue;
          try { await listener(event); } catch { /* Event consumers are isolated. */ }
        }
      }
    })().finally(() => {
      this.eventProcessing = false;
      if (!this.terminalError && this.eventQueue.length > 0) this.drainEvents();
    });
  }

  private async writePayload(payload: Buffer): Promise<void> {
    if (this.terminalError) throw this.terminalError;
    let accepted: boolean;
    try {
      accepted = this.writable.write(payload);
    } catch {
      throw new CdpTransportError("cdp_write_failed");
    }
    if (!accepted) {
      try {
        await waitForDrain(this.writable);
      } catch {
        throw new CdpTransportError("cdp_write_failed");
      }
    }
  }

  private allocateId(): number {
    const id = this.nextId;
    this.nextId = this.nextId === Number.MAX_SAFE_INTEGER ? 1 : this.nextId + 1;
    return id;
  }

  private fail(code: CdpTransportErrorCode): void {
    if (this.terminalError) return;
    const error = new CdpTransportError(code);
    this.terminalError = error;
    this.buffer = Buffer.alloc(0);
    this.eventQueue.length = 0;
    this.detachListeners();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.listeners.clear();
  }

  private detachListeners(): void {
    this.readable.off("data", this.handleData);
    this.readable.off("end", this.handleEnd);
    this.readable.off("error", this.handleError);
    this.readable.off("close", this.handleClose);
    this.writable.off("error", this.handleError);
    this.writable.off("close", this.handleClose);
  }
}

function waitForDrain(writable: Writable): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const drained = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new CdpTransportError("cdp_write_failed")); };
    const cleanup = () => {
      writable.off("drain", drained);
      writable.off("error", failed);
      writable.off("close", failed);
    };
    writable.once("drain", drained);
    writable.once("error", failed);
    writable.once("close", failed);
  });
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum ? Number(value) : fallback;
}

function plainRecord(value: unknown): value is CdpParams {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validMethod(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.]{0,127}$/u.test(value);
}

function validSessionId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && /^[A-Za-z0-9._:-]+$/u.test(value);
}
