import fs from "node:fs";
import path from "node:path";

const MAX_FILES = 8;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const HEADER_BYTES = 16;
const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm"]);

type FileIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

type OpenFile = {
  path: string;
  name: string;
  descriptor: number;
  identity: FileIdentity;
};

export type PreparedUploadFiles = Readonly<{
  paths: readonly string[];
  names: readonly string[];
  assertUnchanged(): void;
  close(): void;
}>;

function fail(code: string): never {
  throw new Error(code);
}

function identity(stat: fs.Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function normalizeAbsolutePath(file: string): string {
  if (typeof file !== "string" || !file || file.includes("\0") || !path.isAbsolute(file) || /[*?]/.test(file)) fail("invalid_file_path");
  if (process.platform === "win32") {
    const windowsPath = file.replaceAll("/", "\\");
    if (!/^[A-Za-z]:\\/.test(windowsPath)) fail("invalid_file_path");
    if (windowsPath.split("\\").some((component) => component === "..")) fail("invalid_file_path");
    return path.win32.normalize(windowsPath);
  }
  if (file.split("/").some((component) => component === "..")) fail("invalid_file_path");
  return path.posix.normalize(file);
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function assertPathSafety(file: string): { path: string; stat: fs.Stats } {
  const normalized = normalizeAbsolutePath(file);
  const pathApi = process.platform === "win32" ? path.win32 : path.posix;
  const parsed = pathApi.parse(normalized);
  let current = parsed.root;
  const components = normalized.slice(parsed.root.length).split(pathApi.sep).filter(Boolean);
  for (const [index, component] of components.entries()) {
    current = pathApi.join(current, component);
    const componentStat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!componentStat) fail("file_not_found");
    if (componentStat.isSymbolicLink()) {
      if (index === components.length - 1 || !trustedSystemLink(current, componentStat)) fail("symlink_not_allowed");
      current = pathApi.normalize(fs.realpathSync.native(current));
    }
  }
  const canonical = pathApi.normalize(fs.realpathSync.native(normalized));
  if (!sameCanonicalPath(canonical, current)) fail("invalid_file_path");
  const stat = fs.lstatSync(current, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) fail("file_not_found");
  return { path: current, stat };
}

/** macOS roots /var, /tmp and /etc are root-owned links inside a root-owned,
 * non-group/world-writable directory; no other local user can retarget them.
 * Any other directory link, and every file-leaf link, remains refused. */
function trustedSystemLink(link: string, stat: fs.Stats): boolean {
  if (process.platform === "win32" || stat.uid !== 0) return false;
  const parent = fs.lstatSync(path.posix.dirname(link), { throwIfNoEntry: false });
  return Boolean(parent?.isDirectory() && parent.uid === 0 && (parent.mode & 0o022) === 0);
}

function hasAllowedSignature(descriptor: number, extension: string): boolean {
  const header = Buffer.alloc(HEADER_BYTES);
  const bytes = fs.readSync(descriptor, header, 0, header.length, 0);
  const view = header.subarray(0, bytes);
  if (extension === ".png") return view.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (extension === ".jpg" || extension === ".jpeg") return view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff;
  if (extension === ".gif") return ["GIF87a", "GIF89a"].includes(view.subarray(0, 6).toString("ascii"));
  if (extension === ".webp") return view.subarray(0, 4).toString("ascii") === "RIFF" && view.subarray(8, 12).toString("ascii") === "WEBP";
  if (extension === ".mp4") return view.subarray(4, 8).toString("ascii") === "ftyp";
  if (extension === ".webm") return view.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return false;
}

function closeDescriptors(files: readonly OpenFile[]): void {
  for (const file of files) {
    try { fs.closeSync(file.descriptor); } catch { /* Preserve the preparation error. */ }
  }
}

export function prepareUploadFiles(paths: readonly string[]): PreparedUploadFiles {
  if (!Array.isArray(paths) || paths.length === 0) fail("files_required");
  if (paths.length > MAX_FILES) fail("file_count_exceeded");
  const files: OpenFile[] = [];
  let total = 0;
  try {
    for (const file of paths) {
      const checked = assertPathSafety(file);
      const beforeOpen = checked.stat;
      if (beforeOpen.size > MAX_FILE_BYTES) fail("file_too_large");
      total += beforeOpen.size;
      if (total > MAX_TOTAL_BYTES) fail("file_total_too_large");
      const extension = path.extname(checked.path).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(extension)) fail("file_type_not_allowed");
      const descriptor = fs.openSync(checked.path, "r");
      try {
        const afterOpen = fs.fstatSync(descriptor);
        if (!sameIdentity(identity(beforeOpen), identity(afterOpen))) fail("file_changed");
        files.push({ path: checked.path, name: path.basename(checked.path), descriptor, identity: identity(afterOpen) });
        if (!hasAllowedSignature(descriptor, extension)) fail("file_type_not_allowed");
      } catch (error) {
        if (!files.some((openFile) => openFile.descriptor === descriptor)) {
          try { fs.closeSync(descriptor); } catch { /* Preserve the validation error. */ }
        }
        throw error;
      }
    }
  } catch (error) {
    closeDescriptors(files);
    throw error;
  }

  let closed = false;
  const preparedPaths = Object.freeze(files.map((file) => file.path));
  const names = Object.freeze(files.map((file) => file.name));
  return {
    paths: preparedPaths,
    names,
    assertUnchanged(): void {
      if (closed) fail("upload_closed");
      for (const file of files) {
        const currentPath = assertPathSafety(file.path);
        if (!sameIdentity(file.identity, identity(currentPath.stat))) fail("file_changed");
        const currentHandle = fs.fstatSync(file.descriptor);
        if (!sameIdentity(file.identity, identity(currentHandle))) fail("file_changed");
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      closeDescriptors(files);
    },
  };
}
