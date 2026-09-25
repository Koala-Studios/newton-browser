import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function hashNativeFile(filename: string, cap = 256 * 1024 * 1024): Promise<string> {
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > cap) {
    throw new Error("native_file_invalid");
  }
  const file = await fs.open(filename, "r");
  try {
    const opened = await file.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev) throw new Error("native_file_changed");
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0;
    while (true) {
      const read = await file.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > cap) throw new Error("native_file_invalid");
      digest.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await file.stat();
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error("native_file_changed");
    }
    return digest.digest("hex");
  } finally {
    await file.close();
  }
}
