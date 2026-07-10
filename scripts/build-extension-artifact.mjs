import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const version = JSON.parse(fs.readFileSync("apps/extension/package.json", "utf8")).version;
const artifactDirectory = path.resolve("artifacts");
const output = path.join(artifactDirectory, `newton-browser-extension-${version}.zip`);
const checksum = `${output}.sha256`;
const sourceRoot = path.resolve("apps/extension");
const iconFiles = [
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
  "icons/action-connected-16.png",
  "icons/action-connected-32.png",
  "icons/action-disconnected-16.png",
  "icons/action-disconnected-32.png",
];
const files = ["manifest.json", ...iconFiles, ...walk(path.join(sourceRoot, "dist")).map((file) => path.relative(sourceRoot, file).replaceAll("\\", "/"))].sort();
if (!files.includes("dist/src/service-worker.js")) throw new Error("extension build output is incomplete");
for (const file of ["icons/icon-16.png", "icons/icon-32.png", "icons/icon-48.png", "icons/icon-128.png", "icons/action-connected-16.png", "icons/action-disconnected-16.png"]) {
  if (!files.includes(file)) throw new Error(`extension icon is missing: ${file}`);
}

fs.mkdirSync(artifactDirectory, { recursive: true });
const zip = createStoredZip(files.map((name) => ({ name, data: fs.readFileSync(path.join(sourceRoot, name)) })));
fs.writeFileSync(output, zip);
const sha256 = createHash("sha256").update(zip).digest("hex");
fs.writeFileSync(checksum, `${sha256}  ${path.basename(output)}\n`);
process.stdout.write(`${JSON.stringify({ output, checksum, sha256, bytes: zip.length, files: files.length })}\n`);

function createStoredZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0x5821, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(entry.data.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, entry.data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x0314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(0, 12);
    record.writeUInt16LE(0x5821, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(entry.data.length, 20);
    record.writeUInt32LE(entry.data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + entry.data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function* walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(file);
    else yield file;
  }
}
