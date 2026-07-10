import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { prepareActionForRelay } from "../src/mcp-server.ts";

test("set_files validates image/video signatures, exact paths, and cancellation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-files-"));
  try {
    const fixtures = [
      write(root, "asset.png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      write(root, "asset.jpg", [0xff, 0xd8, 0xff, 0xe0]),
      write(root, "asset.jpeg", [0xff, 0xd8, 0xff, 0xe1]),
      write(root, "asset.gif", Buffer.from("GIF89a", "ascii")),
      write(root, "asset.webp", Buffer.concat([Buffer.from("RIFF0000WEBP", "ascii")])),
      write(root, "asset.mp4", Buffer.from([0, 0, 0, 16, ...Buffer.from("ftyp", "ascii")])),
      write(root, "asset.webm", [0x1a, 0x45, 0xdf, 0xa3]),
    ];
    const prepared = prepareActionForRelay({ kind: "set_files", target: { ref: "e7" }, files: fixtures }) as any;
    assert.deepEqual(prepared.files, fixtures);
    assert.deepEqual((prepareActionForRelay({ kind: "set_files", target: { ref: "e7" }, files: [] }) as any).files, []);

    assert.throws(() => prepareActionForRelay({ kind: "set_files", files: [path.join(root, "missing.png")] }), /file_not_found/);
    assert.throws(() => prepareActionForRelay({ kind: "set_files", files: [write(root, "asset.txt", Buffer.from("text"))] }), /file_type_not_allowed/);
    assert.throws(() => prepareActionForRelay({ kind: "set_files", files: [write(root, "fake.png", Buffer.from("not png"))] }), /file_type_not_allowed/);
    assert.throws(() => prepareActionForRelay({ kind: "set_files", files: Array.from({ length: 9 }, () => fixtures[0]) }), /file_count_exceeded/);
    assert.throws(() => prepareActionForRelay({ kind: "set_files", files: ["relative.png"] }), /invalid_file_path/);

    const oversized = path.join(root, "oversized.png");
    fs.writeFileSync(oversized, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    fs.truncateSync(oversized, 50 * 1024 * 1024 + 1);
    assert.throws(() => prepareActionForRelay({ kind: "set_files", files: [oversized] }), /file_too_large/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function write(root: string, name: string, bytes: Buffer | number[]): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  return file;
}
