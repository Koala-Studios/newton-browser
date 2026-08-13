/** Dependency-free per-session FIFO command pump with close barrier semantics. */

const SESSION_STOPPING_ERROR = "session_stopping";
const SESSION_QUEUE_FULL_ERROR = "session_queue_full";
const INVALID_COMMAND_SIZE_ERROR = "invalid_command_size";
const INVALID_EXECUTOR_ERROR = "invalid_executor";
const COMMAND_TIMEOUT_NOT_STARTED = "command_timeout_not_started";
const COMMAND_TIMEOUT_OUTCOME_UNKNOWN = "command_timeout_outcome_unknown";
const COMMAND_CANCELLED_NOT_STARTED = "command_cancelled_not_started";
const COMMAND_CANCELLED_OUTCOME_UNKNOWN = "command_cancelled_outcome_unknown";

type PumpError = Error & { code: string };

type QueueEntry = {
  item: unknown;
  bytes: number;
  execute: (item: unknown) => unknown;
  resolve: (output: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout | null;
  running: boolean;
  settled: boolean;
  signal: AbortSignal | null;
  abortListener: (() => void) | null;
};

export type SessionCommandPumpOptions = {
  maxItems?: number;
  maxBytes?: number;
};

export type SessionCommandPumpSnapshot = {
  running: boolean;
  runningCount: number;
  runningBytes: number;
  queueLength: number;
  queuedBytes: number;
  maxItems: number;
  maxBytes: number;
  closed: boolean;
};

function createError(code: string, message = code): PumpError {
  const error: PumpError = Object.assign(new Error(message), { code });
  return error;
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export class SessionCommandPump {
  readonly maxItems: number;
  readonly maxBytes: number;
  closed = false;
  private readonly queue: QueueEntry[] = [];
  private queuedBytes = 0;
  private runningCount = 0;
  private runningBytes = 0;
  private _draining = false;
  private _closePromise: Promise<void> | null = null;
  private _closeResolve: (() => void) | null = null;

  /**
   * Create an in-session FIFO work queue with in-flight caps.
   *
   * maxItems and maxBytes are enforced across in-flight work (running + queued)
   * so a running entry consumes capacity from later enqueues.
   */
  constructor({ maxItems = 32, maxBytes = 1024 * 1024 }: SessionCommandPumpOptions = {}) {
    if (!isSafePositiveInteger(maxItems) || !isSafePositiveInteger(maxBytes)) {
      throw createError(INVALID_COMMAND_SIZE_ERROR);
    }

    this.maxItems = maxItems;
    this.maxBytes = maxBytes;
  }

  /** Return bounded diagnostics only (no payload content). */
  snapshot(): SessionCommandPumpSnapshot {
    return {
      running: this.runningCount > 0,
      runningCount: this.runningCount,
      runningBytes: this.runningBytes,
      queueLength: this.queue.length,
      queuedBytes: this.queuedBytes,
      maxItems: this.maxItems,
      maxBytes: this.maxBytes,
      closed: this.closed,
    };
  }

  closeAfterCurrent(): Promise<void> {
    if (this._closePromise) {
      return this._closePromise;
    }

    this.closed = true;
    this._rejectQueued(createError(SESSION_STOPPING_ERROR));

    if (this.runningCount === 0) {
      this._closePromise = Promise.resolve();
      return this._closePromise;
    }

    this._closePromise = new Promise((resolve) => {
      this._closeResolve = resolve;
    });
    return this._closePromise;
  }

  enqueue<Item, Output>(
    item: Item,
    bytes: number,
    execute: (item: Item) => Output | PromiseLike<Output>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<Awaited<Output>> {
    if (this.closed) {
      return Promise.reject(createError(SESSION_STOPPING_ERROR));
    }
    if (typeof execute !== "function") {
      return Promise.reject(createError(INVALID_EXECUTOR_ERROR));
    }
    if (!isSafeNonNegativeInteger(bytes)) {
      return Promise.reject(createError(INVALID_COMMAND_SIZE_ERROR));
    }
    if (timeoutMs !== undefined && (!isSafePositiveInteger(timeoutMs) || timeoutMs > 300_000)) {
      return Promise.reject(createError(INVALID_COMMAND_SIZE_ERROR));
    }
    if (signal?.aborted) return Promise.reject(createError(COMMAND_CANCELLED_NOT_STARTED));

    const totalItems = this.runningCount + this.queue.length;
    const totalBytes = this.runningBytes + this.queuedBytes;

    if (totalItems + 1 > this.maxItems || totalBytes + bytes > this.maxBytes) {
      return Promise.reject(createError(SESSION_QUEUE_FULL_ERROR));
    }

    return new Promise<Awaited<Output>>((resolve, reject) => {
      const entry: QueueEntry = {
        item,
        bytes,
        execute: (queuedItem) => execute(queuedItem as Item),
        resolve: (output) => resolve(output as Awaited<Output>),
        reject,
        timer: null,
        running: false,
        settled: false,
        signal: signal ?? null,
        abortListener: null,
      };
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => this._timeout(entry), timeoutMs);
        entry.timer.unref();
      }
      if (signal) {
        entry.abortListener = () => this._cancel(entry);
        signal.addEventListener("abort", entry.abortListener, { once: true });
      }
      this.queue.push(entry);
      this.queuedBytes += bytes;
      void this._drain();
    });
  }

  private _rejectQueued(error: PumpError): void {
    if (this.queue.length === 0) {
      return;
    }

    const queued = this.queue.splice(0, this.queue.length);
    this.queuedBytes = 0;
    for (const entry of queued) {
      if (entry.timer) clearTimeout(entry.timer);
      this._removeAbortListener(entry);
      entry.settled = true;
      entry.reject(error);
    }
  }

  private _resolveCloseIfNeeded(): void {
    if (!this.closed || !this._closeResolve) {
      return;
    }
    if (this.runningCount !== 0) {
      return;
    }

    const resolve = this._closeResolve;
    this._closeResolve = null;
    resolve();
  }

  private async _drain(): Promise<void> {
    if (this._draining) {
      return;
    }
    this._draining = true;

    try {
      while (this.queue.length > 0) {
        if (this.closed) {
          this._rejectQueued(createError(SESSION_STOPPING_ERROR));
          break;
        }

        const entry = this.queue.shift();
        if (!entry) break;
        this.queuedBytes -= entry.bytes;
        this.runningCount += 1;
        this.runningBytes += entry.bytes;
        entry.running = true;

        try {
          const output = await Promise.resolve().then(() => entry.execute(entry.item));
          if (!entry.settled) {
            entry.settled = true;
            entry.resolve(output);
          }
        } catch (error) {
          if (!entry.settled) {
            entry.settled = true;
            entry.reject(error);
          }
        } finally {
          if (entry.timer) clearTimeout(entry.timer);
          this._removeAbortListener(entry);
          this.runningCount -= 1;
          this.runningBytes -= entry.bytes;
          this._resolveCloseIfNeeded();
        }
      }
    } finally {
      this._draining = false;
      this._resolveCloseIfNeeded();
    }
  }

  private _timeout(entry: QueueEntry): void {
    if (entry.settled) return;
    entry.settled = true;
    this._removeAbortListener(entry);
    if (!entry.running) {
      const index = this.queue.indexOf(entry);
      if (index >= 0) {
        this.queue.splice(index, 1);
        this.queuedBytes -= entry.bytes;
      }
      entry.reject(createError(COMMAND_TIMEOUT_NOT_STARTED));
      return;
    }
    entry.reject(createError(COMMAND_TIMEOUT_OUTCOME_UNKNOWN));
  }

  private _cancel(entry: QueueEntry): void {
    if (entry.settled) return;
    entry.settled = true;
    this._removeAbortListener(entry);
    if (!entry.running) {
      const index = this.queue.indexOf(entry);
      if (index >= 0) {
        this.queue.splice(index, 1);
        this.queuedBytes -= entry.bytes;
      }
      entry.reject(createError(COMMAND_CANCELLED_NOT_STARTED));
      return;
    }
    entry.reject(createError(COMMAND_CANCELLED_OUTCOME_UNKNOWN));
  }

  private _removeAbortListener(entry: QueueEntry): void {
    if (entry.signal && entry.abortListener) entry.signal.removeEventListener("abort", entry.abortListener);
    entry.abortListener = null;
  }
}
