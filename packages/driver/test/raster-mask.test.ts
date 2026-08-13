import assert from "node:assert/strict";
import { deflateSync, inflateSync } from "node:zlib";
import test from "node:test";

import { maskCapturedPng } from "../src/raster-mask.ts";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("trusted raster masking blackens only the requested scaled rectangle", () => {
  const input = rgbaPng(4, 4, [255, 20, 10, 255]);
  const result = maskCapturedPng(input.toString("base64"), { x: 10, y: 20, width: 40, height: 40 }, [
    { x: 20, y: 30, width: 20, height: 20 },
  ]);
  assert.equal(result.appliedRegions, 1);
  const pixels = decodeRgba(Buffer.from(result.base64, "base64"), 4, 4);
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) {
    const offset = (y * 4 + x) * 4;
    const expected = x >= 1 && x < 3 && y >= 1 && y < 3 ? [0, 0, 0, 255] : [255, 20, 10, 255];
    assert.deepEqual([...pixels.subarray(offset, offset + 4)], expected);
  }
});

test("trusted raster masking rejects malformed, unsupported, and unbounded inputs", () => {
  assert.throws(() => maskCapturedPng("not-base64", { x: 0, y: 0, width: 1, height: 1 }, [{ x: 0, y: 0, width: 1, height: 1 }]), /invalid_raster_mask_png/u);
  assert.throws(() => maskCapturedPng(rgbaPng(1, 1, [1, 2, 3, 4]).toString("base64"), { x: 0, y: 0, width: 1, height: 1 }, []), /invalid_raster_mask_input/u);
  assert.throws(() => maskCapturedPng(rgbaPng(1, 1, [1, 2, 3, 4]).toString("base64"), { x: 0, y: 0, width: 1, height: 1 }, Array.from({ length: 33 }, () => ({ x: 0, y: 0, width: 1, height: 1 }))), /invalid_raster_mask_input/u);
});

function rgbaPng(width: number, height: number, color: readonly number[]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const start = y * (width * 4 + 1); rows[start] = 0;
    for (let x = 0; x < width; x += 1) for (let c = 0; c < 4; c += 1) rows[start + 1 + x * 4 + c] = color[c] ?? 0;
  }
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

function decodeRgba(input: Buffer, width: number, height: number): Buffer {
  let offset = 8; const idat: Buffer[] = [];
  while (offset < input.length) {
    const length = input.readUInt32BE(offset); const type = input.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(input.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const rows = inflateSync(Buffer.concat(idat)); const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) rows.copy(pixels, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
  return pixels;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type); const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0); name.copy(output, 4); data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8); return output;
}

function crc32(input: Buffer): number {
  let value = 0xffffffff;
  for (const byte of input) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
