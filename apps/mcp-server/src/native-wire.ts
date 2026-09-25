import os from "node:os";
import type { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { NativeAssembly, nativePackets } from "@newton-browser/core";

export const NATIVE_PROTOCOL_MAJOR = 1;
export const NATIVE_FRAME_LIMIT = 256 * 1024;
export const NATIVE_MESSAGE_LIMIT = 4 * 1024 * 1024;
const littleEndian = os.endianness() === "LE";

/** Native-endian uint32 framing, bounded before allocating payloads. */
export class NativeFrames {
  private header = Buffer.alloc(4);
  private headerBytes = 0;
  private payload: Buffer | undefined;
  private payloadBytes = 0;
  private readonly receive: (value: unknown) => void;
  constructor(receive: (value: unknown) => void) { this.receive = receive; }
  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.payload) {
        const count = Math.min(4 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + count); offset += count; this.headerBytes += count;
        if (this.headerBytes < 4) continue;
        const length = littleEndian ? this.header.readUInt32LE() : this.header.readUInt32BE();
        if (!length || length > NATIVE_FRAME_LIMIT) throw new Error("native_frame_limit");
        this.payload = Buffer.allocUnsafe(length); this.payloadBytes = 0;
      }
      const count = Math.min(this.payload.length - this.payloadBytes, chunk.length - offset);
      chunk.copy(this.payload, this.payloadBytes, offset, offset + count); offset += count; this.payloadBytes += count;
      if (this.payloadBytes === this.payload.length) {
        const payload = this.payload; this.payload = undefined; this.headerBytes = 0;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
        this.receive(JSON.parse(text));
      }
    }
  }
  end(): void { if (this.headerBytes || this.payload) throw new Error("native_incomplete_frame"); }
}
export function nativeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  if (!payload.length || payload.length > NATIVE_FRAME_LIMIT) throw new Error("native_frame_limit");
  const header = Buffer.alloc(4);
  if (littleEndian) header.writeUInt32LE(payload.length); else header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}
/** Await writes for backpressure; callers cannot enqueue unbounded data while a peer stalls. */
export class NativeChannel {
  private readonly readable: Readable;
  private readonly writable: Writable;
  private pendingBytes = 0;
  private closed = false;
  private readonly parser: NativeFrames;
  private readonly assembly = new NativeAssembly();
  constructor(readable: Readable, writable: Writable, receive: (value: unknown) => void, lost: () => void) {
    this.readable = readable; this.writable = writable;
    this.parser = new NativeFrames(packet => { const assembled = this.assembly.accept(packet); if (assembled) receive(assembled.value); });
    readable.on("data", chunk => { try { this.parser.push(Buffer.from(chunk)); } catch { this.close(); lost(); } });
    readable.on("end", () => { try { this.parser.end(); } catch { /* truncated input invalidates this channel */ } this.close(); lost(); });
    readable.on("error", () => { this.close(); lost(); });
    writable.on("error", () => { this.close(); lost(); });
  }
  async send(value: unknown): Promise<void> {
    for (const packet of nativePackets(randomUUID(), value)) await this.sendFrame(packet);
  }
  private sendFrame(value: unknown): Promise<void> {
    if (this.closed) return Promise.reject(new Error("native_closed"));
    const frame = nativeFrame(value);
    if (this.pendingBytes + frame.length > NATIVE_MESSAGE_LIMIT) return Promise.reject(new Error("native_backpressure"));
    this.pendingBytes += frame.length;
    return new Promise((resolve, reject) => this.writable.write(frame, error => {
      this.pendingBytes -= frame.length;
      if (error) reject(new Error("native_write_failed")); else resolve();
    }));
  }
  close(): void { if (this.closed) return; this.closed = true; this.assembly.clear(); this.readable.destroy(); this.writable.destroy(); }
}
