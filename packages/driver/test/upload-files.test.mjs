import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareUploadFiles } from "../src/upload-files.ts";

const HEADERS = {
  ".png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ".jpg": Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  ".jpeg": Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  ".webp": Buffer.from("RIFF0000WEBP", "ascii"),
  ".gif": Buffer.from("GIF89a", "ascii"),
  ".mp4": Buffer.from([0x00, 0x00, 0x00, 0x00, 0x66, 0x74, 0x79, 0x70]),
  ".webm": Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
};

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-upload-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeAsset(root, filename, size = 32) {
  const file = path.join(root, filename);
  const extension = path.extname(filename).toLowerCase();
  const content = Buffer.alloc(Math.max(size, HEADERS[extension].length));
  HEADERS[extension].copy(content);
  fs.writeFileSync(file, content);
  return file;
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => error instanceof Error && error.message === code);
}

test("prepares every supported media signature and preserves names", (t) => {
  const root = tempRoot(t);
  const files = Object.keys(HEADERS).map((extension, index) => writeAsset(root, `asset-${index}${extension}`));
  const prepared = prepareUploadFiles(files);

  assert.deepEqual(prepared.paths, files.map((file) => fs.realpathSync.native(file)));
  assert.deepEqual(prepared.names, files.map((file) => path.basename(file)));
  assert.ok(Object.isFrozen(prepared.paths));
  assert.ok(Object.isFrozen(prepared.names));
  prepared.assertUnchanged();
  prepared.close();
  prepared.close();
  expectCode(() => prepared.assertUnchanged(), "upload_closed");
});

test("enforces required, absolute, canonical, missing, directory, and wildcard paths", (t) => {
  const root = tempRoot(t);
  const file = writeAsset(root, "valid.png");
  const directory = path.join(root, "directory");
  fs.mkdirSync(directory);

  expectCode(() => prepareUploadFiles([]), "files_required");
  expectCode(() => prepareUploadFiles(["relative.png"]), "invalid_file_path");
  expectCode(() => prepareUploadFiles([`${file}*`]), "invalid_file_path");
  expectCode(() => prepareUploadFiles([`${root}${path.sep}missing\0.png`]), "invalid_file_path");
  expectCode(() => prepareUploadFiles([`${root}${path.sep}nested${path.sep}..${path.sep}valid.png`]), "invalid_file_path");
  expectCode(() => prepareUploadFiles([path.join(root, "missing.png")]), "file_not_found");
  expectCode(() => prepareUploadFiles([directory]), "file_not_found");
});

test("accepts normalized separators and case variants for ordinary Windows drive paths", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-specific path behavior");
    return;
  }
  const root = tempRoot(t);
  const file = writeAsset(root, "MixedCase.PNG");
  const variant = file.replaceAll("\\", "/").replace(/mixedcase\.png$/i, "MIXEDCASE.PNG");
  const prepared = prepareUploadFiles([variant]);

  assert.equal(prepared.paths[0], path.win32.normalize(variant));
  prepared.assertUnchanged();
  prepared.close();
});

test("rejects Windows traversal, UNC, and device paths before filesystem access", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-specific path behavior");
    return;
  }
  const root = tempRoot(t);
  const file = writeAsset(root, "valid.png");
  let lstatCalls = 0;
  const originalLstat = fs.lstatSync;
  fs.lstatSync = (...args) => {
    lstatCalls += 1;
    return originalLstat(...args);
  };
  try {
    expectCode(() => prepareUploadFiles([`${root.replaceAll("\\", "/")}/nested/../valid.png`]), "invalid_file_path");
    expectCode(() => prepareUploadFiles(["\\\\server\\share\\valid.png"]), "invalid_file_path");
    expectCode(() => prepareUploadFiles(["\\\\?\\C:\\valid.png"]), "invalid_file_path");
    expectCode(() => prepareUploadFiles(["\\\\.\\C:\\valid.png"]), "invalid_file_path");
  } finally {
    fs.lstatSync = originalLstat;
  }
  assert.equal(lstatCalls, 0);
  assert.ok(file);
});

test("enforces count, extension, signature, per-file, and total byte limits", (t) => {
  const root = tempRoot(t);
  const tooMany = Array.from({ length: 9 }, (_, index) => writeAsset(root, `count-${index}.png`));
  expectCode(() => prepareUploadFiles(tooMany), "file_count_exceeded");

  const unsupported = path.join(root, "unsupported.txt");
  fs.writeFileSync(unsupported, Buffer.from("not an upload"));
  expectCode(() => prepareUploadFiles([unsupported]), "file_type_not_allowed");

  const malformed = path.join(root, "malformed.png");
  fs.writeFileSync(malformed, Buffer.from("not a png"));
  expectCode(() => prepareUploadFiles([malformed]), "file_type_not_allowed");

  const tooLarge = writeAsset(root, "too-large.mp4");
  fs.truncateSync(tooLarge, 50 * 1024 * 1024 + 1);
  expectCode(() => prepareUploadFiles([tooLarge]), "file_too_large");

  const total = Array.from({ length: 6 }, (_, index) => writeAsset(root, `total-${index}.webm`));
  for (const file of total) fs.truncateSync(file, 40 * 1024 * 1024);
  expectCode(() => prepareUploadFiles(total), "file_total_too_large");
});

test("rejects symlinks in the file and every parent component", (t) => {
  const root = tempRoot(t);
  const target = writeAsset(root, "target.png");
  const fileLink = path.join(root, "file-link.png");
  const realDirectory = path.join(root, "real-directory");
  const directoryLink = path.join(root, "directory-link");
  fs.mkdirSync(realDirectory);
  const nested = writeAsset(realDirectory, "nested.png");

  try {
    fs.symlinkSync(target, fileLink, "file");
    fs.symlinkSync(realDirectory, directoryLink, "junction");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "ENOTSUP") {
      t.skip("symlink creation is unavailable in this environment");
      return;
    }
    throw error;
  }

  expectCode(() => prepareUploadFiles([fileLink]), "symlink_not_allowed");
  expectCode(() => prepareUploadFiles([path.join(directoryLink, path.basename(nested))]), "symlink_not_allowed");
});

test("detects in-place mutation and replacement after preparation", (t) => {
  const root = tempRoot(t);
  const mutated = writeAsset(root, "mutated.png");
  const preparedMutation = prepareUploadFiles([mutated]);
  fs.appendFileSync(mutated, Buffer.from([0x01]));
  expectCode(() => preparedMutation.assertUnchanged(), "file_changed");
  preparedMutation.close();

  const replaced = writeAsset(root, "replaced.jpg");
  const preparedReplacement = prepareUploadFiles([replaced]);
  fs.renameSync(replaced, `${replaced}.old`);
  writeAsset(root, "replaced.jpg");
  expectCode(() => preparedReplacement.assertUnchanged(), "file_changed");
  preparedReplacement.close();
});

test("closes all prepared handles and rejects use after close", (t) => {
  const root = tempRoot(t);
  const files = [writeAsset(root, "one.gif"), writeAsset(root, "two.webp")];
  const prepared = prepareUploadFiles(files);
  prepared.close();
  prepared.close();
  expectCode(() => prepared.assertUnchanged(), "upload_closed");
});

test("root-owned system links such as macOS /var resolve while user links stay refused", (t) => {
  const root = tempRoot(t);
  if (process.platform === "win32" || fs.realpathSync.native(root) === root) { t.skip("temporary directory has no system directory link"); return; }
  const asset = writeAsset(root, "asset.png");
  const prepared = prepareUploadFiles([asset]);
  try {
    assert.deepEqual(prepared.paths, [fs.realpathSync.native(asset)]);
    assert.deepEqual(prepared.names, ["asset.png"]);
    prepared.assertUnchanged();
  } finally { prepared.close(); }
  const userLink = path.join(root, "user-link");
  fs.symlinkSync(root, userLink, "dir");
  expectCode(() => prepareUploadFiles([path.join(userLink, "asset.png")]), "symlink_not_allowed");
});
