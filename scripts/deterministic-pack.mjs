import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const TAR_BLOCK_BYTES = 512;
const FIXED_MTIME_SECONDS = 499_162_500;

export function buildDeterministicPackageTarball({ packageRoot, licensePath, tarball }) {
  const resolvedPackageRoot = fs.realpathSync.native(packageRoot);
  const resolvedLicense = fs.realpathSync.native(licensePath);
  const target = path.resolve(tarball);
  const entries = [
    binaryEntry(resolvedPackageRoot, "dist/browser-guardian.js", 0o644),
    binaryEntry(resolvedPackageRoot, "dist/index.js", 0o755),
    packageJsonEntry(resolvedPackageRoot),
    textEntry(resolvedPackageRoot, "README.md", 0o644),
    Object.freeze({ name: "package/LICENSE", mode: 0o644, data: normalizedText(resolvedLicense) }),
  ];
  const tar = encodeTar(entries);
  const gzip = gzipSync(tar, { level: 9, mtime: 0 });
  // Keep archive metadata host-neutral. These bytes are outside the compressed
  // stream and do not affect the trailer CRC.
  gzip.fill(0, 4, 8);
  gzip[9] = 255;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { force: true });
  fs.writeFileSync(target, gzip, { flag: "wx", mode: 0o600 });
  return Object.freeze({
    tarball: target,
    files: entries.length,
    bytes: gzip.length,
    sha256: createHash("sha256").update(gzip).digest("hex"),
  });
}

function binaryEntry(root, relative, mode) {
  const absolute = regularDirectFile(root, relative);
  return Object.freeze({ name: `package/${relative}`, mode, data: fs.readFileSync(absolute) });
}

function textEntry(root, relative, mode) {
  const absolute = regularDirectFile(root, relative);
  return Object.freeze({ name: `package/${relative}`, mode, data: normalizedText(absolute) });
}

function packageJsonEntry(root) {
  const absolute = regularDirectFile(root, "package.json");
  const parsed = JSON.parse(fs.readFileSync(absolute, "utf8"));
  return Object.freeze({
    name: "package/package.json",
    mode: 0o644,
    data: Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8"),
  });
}

function normalizedText(absolute) {
  return Buffer.from(fs.readFileSync(absolute, "utf8").replace(/\r\n?/gu, "\n"), "utf8");
}

function regularDirectFile(root, relative) {
  const absolute = path.resolve(root, ...relative.split("/"));
  const within = path.relative(root, absolute);
  if (!within || path.isAbsolute(within) || within.startsWith(`..${path.sep}`) || within === "..") {
    throw new Error("deterministic_pack_path_escape");
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("deterministic_pack_source_invalid");
  if (fs.realpathSync.native(absolute) !== absolute) throw new Error("deterministic_pack_source_invalid");
  return absolute;
}

function encodeTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    if (!/^package\/[A-Za-z0-9._/-]{1,90}$/u.test(entry.name) || entry.name.includes("..")) {
      throw new Error("deterministic_pack_entry_invalid");
    }
    const header = Buffer.alloc(TAR_BLOCK_BYTES);
    writeString(header, 0, 100, entry.name);
    writeOctal(header, 100, 8, entry.mode);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.data.length);
    writeOctal(header, 136, 12, FIXED_MTIME_SECONDS);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    writeString(header, 257, 6, "ustar\0");
    writeString(header, 263, 2, "00");
    writeString(header, 265, 32, "root");
    writeString(header, 297, 32, "root");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    const checksumText = checksum.toString(8).padStart(6, "0");
    header.write(checksumText, 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header, entry.data);
    const remainder = entry.data.length % TAR_BLOCK_BYTES;
    if (remainder !== 0) blocks.push(Buffer.alloc(TAR_BLOCK_BYTES - remainder));
  }
  blocks.push(Buffer.alloc(TAR_BLOCK_BYTES * 2));
  return Buffer.concat(blocks);
}

function writeString(buffer, offset, length, value) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length) throw new Error("deterministic_pack_field_overflow");
  encoded.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("deterministic_pack_field_invalid");
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  if (encoded.length !== length) throw new Error("deterministic_pack_field_overflow");
  buffer.write(encoded, offset, length, "ascii");
}
