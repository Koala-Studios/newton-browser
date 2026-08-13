import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_RASTER_PIXELS = 20_000_000;
const MAX_COMPRESSED_BYTES = 24 * 1024 * 1024;

export type CssMaskRegion = Readonly<{ x: number; y: number; width: number; height: number }>;
export type CssCaptureClip = Readonly<{ x: number; y: number; width: number; height: number }>;

export type MaskedPng = Readonly<{
  base64: string;
  width: number;
  height: number;
  appliedRegions: number;
}>;

/**
 * Applies opaque masks after screenshot capture, inside Newton's trusted Node process.
 * Only the bounded, non-interlaced 8-bit RGB/RGBA PNG forms emitted by Chromium are
 * accepted. Ancillary chunks are deliberately discarded from the returned image.
 */
export function maskCapturedPng(
  base64: string,
  clip: CssCaptureClip,
  regions: readonly CssMaskRegion[],
): MaskedPng {
  if (!validClip(clip) || regions.length === 0 || regions.length > 32) throw new Error("invalid_raster_mask_input");
  if (typeof base64 !== "string" || base64.length === 0 || base64.length > MAX_COMPRESSED_BYTES * 2) {
    throw new Error("invalid_raster_mask_input");
  }
  const input = Buffer.from(base64, "base64");
  if (input.length === 0 || input.length > MAX_COMPRESSED_BYTES || !input.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("invalid_raster_mask_png");
  }

  const parsed = parsePng(input);
  const scaleX = parsed.width / clip.width;
  const scaleY = parsed.height / clip.height;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
    throw new Error("invalid_raster_mask_geometry");
  }

  let appliedRegions = 0;
  for (const region of regions) {
    if (!validRegion(region)) throw new Error("invalid_raster_mask_geometry");
    const left = clamp(Math.floor((region.x - clip.x) * scaleX), 0, parsed.width);
    const top = clamp(Math.floor((region.y - clip.y) * scaleY), 0, parsed.height);
    const right = clamp(Math.ceil((region.x + region.width - clip.x) * scaleX), 0, parsed.width);
    const bottom = clamp(Math.ceil((region.y + region.height - clip.y) * scaleY), 0, parsed.height);
    if (right <= left || bottom <= top) continue;
    appliedRegions += 1;
    for (let y = top; y < bottom; y += 1) {
      const row = y * parsed.width * parsed.channels;
      for (let x = left; x < right; x += 1) {
        const offset = row + x * parsed.channels;
        parsed.pixels[offset] = 0;
        parsed.pixels[offset + 1] = 0;
        parsed.pixels[offset + 2] = 0;
        if (parsed.channels === 4) parsed.pixels[offset + 3] = 255;
      }
    }
  }
  if (appliedRegions === 0) {
    return { base64, width: parsed.width, height: parsed.height, appliedRegions: 0 };
  }

  const encoded = encodePng(parsed.width, parsed.height, parsed.channels, parsed.pixels);
  return { base64: encoded.toString("base64"), width: parsed.width, height: parsed.height, appliedRegions };
}

function parsePng(input: Buffer): { width: number; height: number; channels: 3 | 4; pixels: Buffer } {
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let channels: 3 | 4 | null = null;
  let sawHeader = false;
  let sawEnd = false;
  const idat: Buffer[] = [];
  let compressedBytes = 0;

  while (offset < input.length) {
    if (offset + 12 > input.length) throw new Error("invalid_raster_mask_png");
    const length = input.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (length > MAX_COMPRESSED_BYTES || chunkEnd > input.length) throw new Error("invalid_raster_mask_png");
    const type = input.toString("ascii", offset + 4, offset + 8);
    const data = input.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = input.readUInt32BE(offset + 8 + length);
    if (crc32(input.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) throw new Error("invalid_raster_mask_png");

    if (type === "IHDR") {
      if (sawHeader || length !== 13 || offset !== PNG_SIGNATURE.length) throw new Error("invalid_raster_mask_png");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const compression = data[10];
      const filter = data[11];
      const interlace = data[12];
      if (width <= 0 || height <= 0 || width * height > MAX_RASTER_PIXELS
        || bitDepth !== 8 || (colorType !== 2 && colorType !== 6)
        || compression !== 0 || filter !== 0 || interlace !== 0) {
        throw new Error("unsupported_raster_mask_png");
      }
      channels = colorType === 6 ? 4 : 3;
      sawHeader = true;
    } else if (type === "IDAT") {
      if (!sawHeader || sawEnd) throw new Error("invalid_raster_mask_png");
      compressedBytes += data.length;
      if (compressedBytes > MAX_COMPRESSED_BYTES) throw new Error("invalid_raster_mask_png");
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      if (!sawHeader || length !== 0 || sawEnd) throw new Error("invalid_raster_mask_png");
      sawEnd = true;
      offset = chunkEnd;
      break;
    }
    offset = chunkEnd;
  }
  if (!sawHeader || !sawEnd || offset !== input.length || channels === null || idat.length === 0) {
    throw new Error("invalid_raster_mask_png");
  }

  const rowBytes = width * channels;
  const expectedBytes = (rowBytes + 1) * height;
  const inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: expectedBytes + 1 });
  if (inflated.length !== expectedBytes) throw new Error("invalid_raster_mask_png");
  const pixels = Buffer.allocUnsafe(rowBytes * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filterType = inflated[sourceOffset];
    sourceOffset += 1;
    if (filterType === undefined || filterType > 4) throw new Error("unsupported_raster_mask_png");
    const rowOffset = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[sourceOffset + x];
      if (raw === undefined) throw new Error("invalid_raster_mask_png");
      const left = x >= channels ? pixels[rowOffset + x - channels] ?? 0 : 0;
      const up = y > 0 ? pixels[rowOffset - rowBytes + x] ?? 0 : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[rowOffset - rowBytes + x - channels] ?? 0 : 0;
      pixels[rowOffset + x] = (raw + unfilter(filterType, left, up, upperLeft)) & 0xff;
    }
    sourceOffset += rowBytes;
  }
  return { width, height, channels, pixels };
}

function unfilter(filter: number, left: number, up: number, upperLeft: number): number {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return Math.floor((left + up) / 2);
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= upDistance && leftDistance <= upperLeftDistance ? left : upDistance <= upperLeftDistance ? up : upperLeft;
}

function encodePng(width: number, height: number, channels: 3 | 4, pixels: Buffer): Buffer {
  const rowBytes = width * channels;
  const scanlines = Buffer.allocUnsafe((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const outputOffset = y * (rowBytes + 1);
    scanlines[outputOffset] = 0;
    pixels.copy(scanlines, outputOffset + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.allocUnsafe(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.length + 8);
  return output;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function validClip(value: CssCaptureClip): boolean {
  return finite(value.x) && finite(value.y) && finite(value.width) && finite(value.height) && value.width > 0 && value.height > 0;
}

function validRegion(value: CssMaskRegion): boolean {
  return finite(value.x) && finite(value.y) && finite(value.width) && finite(value.height) && value.width > 0 && value.height > 0;
}

function finite(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
