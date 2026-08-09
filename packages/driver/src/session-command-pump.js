/** Dependency-free per-session FIFO command pump with close barrier semantics. */

const SESSION_FINALIZING_ERROR = "session_finalizing";
const SESSION_QUEUE_FULL_ERROR = "session_queue_full";
const INVALID_COMMAND_SIZE_ERROR = "invalid_command_size";
const INVALID_EXECUTOR_ERROR = "invalid_executor";

function createError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isSafePositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export class SessionCommandPump {
  /**
   * Create an in-session FIFO work queue with in-flight caps.
   *
   * maxItems and maxBytes are enforced across in-flight work (running + queued)
   * so a running entry consumes capacity from later enqueues.
   */
  constructor({ maxItems = 32, maxBytes = 1024 * 1024 } = {}) {
    if (!isSafePositiveInteger(maxItems) || !isSafePositiveInteger(maxBytes)) {
      throw createError(INVALID_COMMAND_SIZE_ERROR);
    }

    this.maxItems = maxItems;
    this.maxBytes = maxBytes;

    this.closed = false;
    this.queue = [];
    this.queuedBytes = 0;
    this.runningCount = 0;
    this.runningBytes = 0;

    this._draining = false;
    this._closePromise = null;
    this._closeResolve = null;
  }

  /**
   * Return bounded diagnostics only (no payload content).
   */
  snapshot() {
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

  closeAfterCurrent() {
    if (this._closePromise) {
      return this._closePromise;
    }

    this.closed = true;
    this._rejectQueued(createError(SESSION_FINALIZING_ERROR));

    if (this.runningCount === 0) {
      this._closePromise = Promise.resolve();
      return this._closePromise;
    }

    this._closePromise = new Promise((resolve) => {
      this._closeResolve = resolve;
    });
    return this._closePromise;
  }

  enqueue(item, bytes, execute) {
    if (this.closed) {
      return Promise.reject(createError(SESSION_FINALIZING_ERROR));
    }
    if (typeof execute !== "function") {
      return Promise.reject(createError(INVALID_EXECUTOR_ERROR));
    }
    if (!isSafeNonNegativeInteger(bytes)) {
      return Promise.reject(createError(INVALID_COMMAND_SIZE_ERROR));
    }

    const totalItems = this.runningCount + this.queue.length;
    const totalBytes = this.runningBytes + this.queuedBytes;

    if (totalItems + 1 > this.maxItems || totalBytes + bytes > this.maxBytes) {
      return Promise.reject(createError(SESSION_QUEUE_FULL_ERROR));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({
        item,
        bytes,
        execute,
        resolve,
        reject,
      });
      this.queuedBytes += bytes;
      void this._drain();
    });
  }

  _rejectQueued(error) {
    if (this.queue.length === 0) {
      return;
    }

    const queued = this.queue.splice(0, this.queue.length);
    this.queuedBytes = 0;
    for (const entry of queued) {
      entry.reject(error);
    }
  }

  _resolveCloseIfNeeded() {
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

  async _drain() {
    if (this._draining) {
      return;
    }
    this._draining = true;

    try {
      while (this.queue.length > 0) {
        if (this.closed) {
          this._rejectQueued(createError(SESSION_FINALIZING_ERROR));
          break;
        }

        const entry = this.queue.shift();
        this.queuedBytes -= entry.bytes;
        this.runningCount += 1;
        this.runningBytes += entry.bytes;

        try {
          const output = await Promise.resolve().then(() => entry.execute(entry.item));
          entry.resolve(output);
        } catch (error) {
          entry.reject(error);
        } finally {
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
}
