export type McpMessageMode = "framed" | "json-line";

export const MAX_MCP_HEADER_BYTES = 16 * 1024;
export const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_MCP_BUFFER_BYTES = MAX_MCP_BODY_BYTES + MAX_MCP_HEADER_BYTES;

export interface McpFrameParserCallbacks {
  onMessage: (message: unknown, mode: McpMessageMode) => void | Promise<void>;
  onError: (error: McpFrameParseError, mode: McpMessageMode) => void | Promise<void>;
}

export type McpFrameParseErrorCode =
  | "buffer_too_large"
  | "header_too_large"
  | "body_too_large"
  | "missing_content_length"
  | "duplicate_content_length"
  | "non_decimal_content_length"
  | "negative_content_length"
  | "content_length_exceeded"
  | "invalid_header"
  | "callback_error"
  | "invalid_json"
  | "incomplete_frame";

export class McpFrameParseError extends Error {
  public readonly code: McpFrameParseErrorCode;

  constructor(code: McpFrameParseErrorCode, message: string) {
    super(message);
    this.name = "McpFrameParseError";
    this.code = code;
  }
}

const HEADER_TERM_CRLF = Buffer.from("\r\n\r\n");
const HEADER_TERM_LF = Buffer.from("\n\n");
const MODE_SCAN_LIMIT = 64;
const ERROR_MESSAGES: Record<McpFrameParseErrorCode, string> = {
  buffer_too_large: "Parser input exceeded maximum buffered byte limit.",
  header_too_large: "Header section exceeded parser limit.",
  body_too_large: "Body section exceeded parser limit.",
  missing_content_length: "Missing content-length header.",
  duplicate_content_length: "Duplicate content-length header.",
  non_decimal_content_length: "Non-decimal content-length header.",
  negative_content_length: "Negative content-length header.",
  content_length_exceeded: "Content-Length exceeds parser body limit.",
  invalid_header: "Invalid frame header.",
  callback_error: "Message callback failed.",
  invalid_json: "Invalid JSON payload.",
  incomplete_frame: "Stream ended with an incomplete frame.",
};

export class McpFrameParser {
  private buffer = Buffer.alloc(0);
  private pendingChunks: Buffer[] = [];
  private pendingByteCount = 0;
  private expectedBodyLength: number | null = null;
  private terminal = false;
  private eof = false;
  private queue: Promise<void> = Promise.resolve();
  private processing = false;

  private onMessage: (message: unknown, mode: McpMessageMode) => void | Promise<void>;
  private onError: (error: McpFrameParseError, mode: McpMessageMode) => void | Promise<void>;

  constructor(
    onMessage: (message: unknown, mode: McpMessageMode) => void | Promise<void>,
    onError: (error: McpFrameParseError, mode: McpMessageMode) => void | Promise<void>,
  ) {
    this.onMessage = onMessage;
    this.onError = onError;
  }

  get bufferedByteCount(): number {
    return this.buffer.length + this.pendingByteCount;
  }

  get isTerminalFailure(): boolean {
    return this.terminal;
  }

  push(chunk: Buffer): void {
    if (this.terminal || chunk.length === 0) return;

    const retained = this.bufferedByteCount;
    if (chunk.length > MAX_MCP_BUFFER_BYTES - retained) {
      this.failLater(
        new McpFrameParseError("buffer_too_large", this.messageForCode("buffer_too_large")),
        this.peekModeAcrossBuffers(this.buffer, this.pendingChunks, chunk),
      );
      return;
    }

    if (this.processing) {
      this.pendingChunks.push(chunk);
      this.pendingByteCount += chunk.length;
    } else {
      if (this.pendingByteCount > 0) {
        this.absorbPendingChunks();
      }
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    }

    this.scheduleDrain();
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  end(): void {
    if (this.terminal) return;
    this.eof = true;
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.terminal || this.processing) return;

    const task = async () => {
      while (!this.terminal && this.bufferedByteCount > 0) {
        this.absorbPendingChunks();
        let progressed;

        if (this.expectedBodyLength !== null) {
          progressed = await this.processFramedBody();
        } else {
          const mode = this.peekMode(this.buffer);
          progressed = mode === "json-line"
            ? await this.processJsonLineFrame()
            : await this.processFramedHeader();
        }

        if (!progressed) break;
      }

      if (!this.terminal && this.eof) {
        const incomplete = this.expectedBodyLength !== null || this.buffer.length > 0;
        if (incomplete) {
          const mode = this.expectedBodyLength === null ? this.peekMode(this.buffer) : "framed";
          await this.fail(new McpFrameParseError("incomplete_frame", this.messageForCode("incomplete_frame")), mode);
        }
        this.eof = false;
      }
    };

    this.processing = true;
    this.queue = this.queue.then(task, task).finally(() => {
      this.processing = false;
    });
  }

  private async processFramedHeader(): Promise<boolean> {
    const terminator = this.findHeaderTerminator();
    if (terminator === null) {
      if (this.buffer.length > MAX_MCP_HEADER_BYTES) {
        await this.fail(new McpFrameParseError("header_too_large", this.messageForCode("header_too_large")), "framed");
      }
      return false;
    }

    if (terminator.index > MAX_MCP_HEADER_BYTES) {
      await this.fail(new McpFrameParseError("header_too_large", this.messageForCode("header_too_large")), "framed");
      return false;
    }

    const headerText = this.buffer.subarray(0, terminator.index).toString("utf8");
    let bodyLength: number;
    try {
      bodyLength = this.parseContentLengthHeader(headerText);
    } catch (error) {
      await this.fail(
        error instanceof McpFrameParseError
          ? error
          : new McpFrameParseError("invalid_header", this.messageForCode("invalid_header")),
        "framed",
      );
      return false;
    }

    if (bodyLength > MAX_MCP_BODY_BYTES) {
      await this.fail(
        new McpFrameParseError("content_length_exceeded", this.messageForCode("content_length_exceeded")),
        "framed",
      );
      return false;
    }

    this.buffer = this.buffer.subarray(terminator.index + terminator.length);
    this.expectedBodyLength = bodyLength;
    return true;
  }

  private async processFramedBody(): Promise<boolean> {
    if (this.expectedBodyLength === null || this.expectedBodyLength > this.buffer.length) return false;

    const bodyText = this.buffer.subarray(0, this.expectedBodyLength).toString("utf8");
    this.buffer = this.buffer.subarray(this.expectedBodyLength);
    this.expectedBodyLength = null;

    try {
      await this.emitMessage("framed", JSON.parse(bodyText));
      return true;
    } catch (error) {
      await this.fail(new McpFrameParseError("invalid_json", this.messageForCode("invalid_json")), "framed");
      return false;
    }
  }

  private async processJsonLineFrame(): Promise<boolean> {
    const newlineOffset = this.buffer.indexOf(0x0a);
    if (newlineOffset === -1) {
      if (this.buffer.length > MAX_MCP_BODY_BYTES) {
        await this.fail(new McpFrameParseError("body_too_large", this.messageForCode("body_too_large")), "json-line");
      }
      return false;
    }

    const line = this.buffer.subarray(0, newlineOffset);
    this.buffer = this.buffer.subarray(newlineOffset + 1);

    if (line.length === 0) return true;
    if (line.length > MAX_MCP_BODY_BYTES) {
      await this.fail(new McpFrameParseError("body_too_large", this.messageForCode("body_too_large")), "json-line");
      return false;
    }

    const text = line.toString("utf8");
    const candidate = text.endsWith("\r") ? text.slice(0, -1) : text;

    try {
      await this.emitMessage("json-line", JSON.parse(candidate));
      return true;
    } catch (error) {
      await this.fail(new McpFrameParseError("invalid_json", this.messageForCode("invalid_json")), "json-line");
      return false;
    }
  }

  private parseContentLengthHeader(headerText: string): number {
    const lines = headerText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    let contentLengthValue: string | undefined;

    for (const line of lines) {
      const separator = line.indexOf(":");
      if (separator <= 0) throw new McpFrameParseError("invalid_header", this.messageForCode("invalid_header"));

      const field = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();
      if (field !== "content-length") continue;
      if (contentLengthValue === undefined) {
        contentLengthValue = value;
        continue;
      }
      throw new McpFrameParseError("duplicate_content_length", this.messageForCode("duplicate_content_length"));
    }

    if (contentLengthValue === undefined) {
      throw new McpFrameParseError("missing_content_length", this.messageForCode("missing_content_length"));
    }
    if (contentLengthValue.startsWith("-")) {
      throw new McpFrameParseError("negative_content_length", this.messageForCode("negative_content_length"));
    }
    if (!/^\d+$/.test(contentLengthValue)) {
      throw new McpFrameParseError("non_decimal_content_length", this.messageForCode("non_decimal_content_length"));
    }

    const length = BigInt(contentLengthValue);
    if (length > BigInt(MAX_MCP_BODY_BYTES)) {
      throw new McpFrameParseError("content_length_exceeded", this.messageForCode("content_length_exceeded"));
    }
    return Number(length);
  }

  private async emitMessage(mode: McpMessageMode, message: unknown): Promise<void> {
    if (this.terminal) return;
    try {
      await this.onMessage(message, mode);
    } catch (error) {
      await this.fail(new McpFrameParseError("callback_error", this.messageForCode("callback_error")), mode);
    }
  }

  private async emitFailure(error: McpFrameParseError, mode: McpMessageMode): Promise<void> {
    if (!this.terminal) return;
    try {
      await this.onError(error, mode);
    } catch {
      // swallow diagnostics callback failures
    }
  }

  private async fail(error: McpFrameParseError, mode: McpMessageMode): Promise<void> {
    if (!this.markTerminal()) return;
    await this.emitFailure(error, mode);
  }

  private failLater(error: McpFrameParseError, mode: McpMessageMode): void {
    if (!this.markTerminal()) return;
    this.queue = this.queue.then(
      () => this.emitFailure(error, mode),
      () => this.emitFailure(error, mode),
    );
  }

  private markTerminal(): boolean {
    if (this.terminal) return false;
    this.terminal = true;
    this.expectedBodyLength = null;
    this.buffer = Buffer.alloc(0);
    this.pendingChunks = [];
    this.pendingByteCount = 0;
    this.eof = false;
    return true;
  }

  private findHeaderTerminator(): { index: number; length: number } | null {
    for (let index = 0; index < this.buffer.length - 1; index += 1) {
      if (
        index + 3 < this.buffer.length &&
        this.buffer[index] === HEADER_TERM_CRLF[0] &&
        this.buffer[index + 1] === HEADER_TERM_CRLF[1] &&
        this.buffer[index + 2] === HEADER_TERM_CRLF[2] &&
        this.buffer[index + 3] === HEADER_TERM_CRLF[3]
      ) {
        return { index, length: HEADER_TERM_CRLF.length };
      }

      if (this.buffer[index] === HEADER_TERM_LF[0] && this.buffer[index + 1] === HEADER_TERM_LF[1]) {
        return { index, length: HEADER_TERM_LF.length };
      }
    }

    return null;
  }

  private isWhitespace(byte: number): boolean {
    return (
      byte === 0x20 ||
      byte === 0x09 ||
      byte === 0x0a ||
      byte === 0x0d ||
      byte === 0x0b ||
      byte === 0x0c
    );
  }

  private peekMode(sample: Buffer): McpMessageMode {
    for (let index = 0; index < sample.length; index += 1) {
      const value = sample[index];
      if (this.isWhitespace(value)) continue;
      return value === 0x7b ? "json-line" : "framed";
    }
    return "json-line";
  }

  private peekModeAcrossBuffers(first: Buffer, pending: Buffer[], second: Buffer): McpMessageMode {
    let remaining = MODE_SCAN_LIMIT;
    for (let index = 0; index < first.length && remaining > 0; index += 1) {
      const value = first[index];
      if (this.isWhitespace(value)) {
        remaining -= 1;
        continue;
      }
      return value === 0x7b ? "json-line" : "framed";
    }

    for (let pendingIndex = 0; pendingIndex < pending.length && remaining > 0; pendingIndex += 1) {
      const chunk = pending[pendingIndex];
      for (let index = 0; index < chunk.length && remaining > 0; index += 1) {
        const value = chunk[index];
        if (this.isWhitespace(value)) {
          remaining -= 1;
          continue;
        }
        return value === 0x7b ? "json-line" : "framed";
      }
    }

    for (let index = 0; index < second.length && remaining > 0; index += 1) {
      const value = second[index];
      if (this.isWhitespace(value)) {
        remaining -= 1;
        continue;
      }
      return value === 0x7b ? "json-line" : "framed";
    }

    return "json-line";
  }

  private absorbPendingChunks(): void {
    if (this.pendingByteCount === 0) return;

    const totalLength = this.buffer.length + this.pendingByteCount;
    if (this.pendingChunks.length === 1) {
      const next = this.pendingChunks[0];
      this.buffer = this.buffer.length === 0 ? next : Buffer.concat([this.buffer, next], totalLength);
    } else {
      const chunks = [this.buffer, ...this.pendingChunks];
      this.buffer = Buffer.concat(chunks, totalLength);
    }

    this.pendingChunks = [];
    this.pendingByteCount = 0;
  }

  private messageForCode(code: McpFrameParseErrorCode): string {
    return ERROR_MESSAGES[code];
  }
}
