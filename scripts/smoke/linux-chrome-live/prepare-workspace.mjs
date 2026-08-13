import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [sourceArgument, destinationArgument, option] = process.argv.slice(2);
if (!sourceArgument || !destinationArgument || (option && option !== "--skip-mount-check")) {
  throw new Error("usage: prepare-workspace.mjs SOURCE DESTINATION [--skip-mount-check]");
}

const source = fs.realpathSync(sourceArgument);
const destination = path.resolve(destinationArgument);
if (source === path.parse(source).root || destination === path.parse(destination).root) fail("unsafe_workspace_root");
if (!option) assertReadOnlyMount(source);

const requiredRootFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "README.md",
  "LICENSE",
];
const allowedRoots = ["apps", "packages", "scripts", "test"];
const excludedDirectories = new Set([".git", "node_modules", "dist", "artifacts", ".pnpm-store"]);
const allowedExtensions = new Set([
  ".css", ".fixture", ".gif", ".html", ".jpeg", ".jpg", ".js", ".json",
  ".md", ".mjs", ".mp4", ".png", ".sh", ".svg", ".toml", ".ts", ".txt",
  ".webm", ".webp", ".yaml", ".yml",
]);
const allowedExtensionlessNames = new Set(["Dockerfile", "LICENSE"]);
const maxFileBytes = 20 * 1024 * 1024;
const maxWorkspaceBytes = 256 * 1024 * 1024;
const records = [];
let totalBytes = 0;

for (const relative of requiredRootFiles) collect(relative, true);
for (const relative of allowedRoots) {
  const entry = statEntry(relative, true);
  if (entry.kind !== "directory") fail("required_source_directory_invalid", relative);
  walk(relative);
}

records.sort((left, right) => left.relative.localeCompare(right.relative, "en"));
fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
const digest = crypto.createHash("sha256");
for (const record of records) {
  const target = path.join(destination, ...record.relative.split("/"));
  assertInside(destination, target);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(record.absolute, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, record.mode & 0o111 ? 0o700 : 0o600);
  digest.update(`${record.relative}\0${record.size}\0`, "utf8");
  digest.update(fs.readFileSync(target));
}

process.stdout.write(`${JSON.stringify({
  sourceTreeSha256: digest.digest("hex"),
  files: records.length,
  bytes: totalBytes,
})}\n`);

function walk(relativeDirectory) {
  const absolute = path.join(source, ...relativeDirectory.split("/"));
  for (const directoryEntry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (excludedDirectories.has(directoryEntry.name)) continue;
    const relative = `${relativeDirectory}/${directoryEntry.name}`;
    if (directoryEntry.isSymbolicLink()) fail("source_symlink_rejected", relative);
    if (directoryEntry.isDirectory()) {
      walk(relative);
      continue;
    }
    if (!directoryEntry.isFile()) fail("source_special_file_rejected", relative);
    collect(relative, false);
  }
}

function collect(relative, required) {
  const entry = statEntry(relative, required);
  if (!entry) return;
  if (entry.kind !== "file") fail("source_regular_file_required", relative);
  const name = path.posix.basename(relative);
  if (isSensitivePath(relative)) fail("source_sensitive_path_rejected", relative);
  const extension = path.posix.extname(name).toLowerCase();
  if (!required && !allowedExtensions.has(extension) && !allowedExtensionlessNames.has(name)) {
    fail("source_file_not_allowlisted", relative);
  }
  if (entry.size > maxFileBytes) fail("source_file_too_large", relative);
  totalBytes += entry.size;
  if (totalBytes > maxWorkspaceBytes) fail("source_workspace_too_large");
  records.push({ relative, absolute: entry.absolute, size: entry.size, mode: entry.mode });
}

function isSensitivePath(relative) {
  const segments = relative.toLowerCase().split("/");
  return segments.some((segment) => {
    const stem = segment.replace(/\.[^.]+$/, "");
    return segment === ".env" || segment.startsWith(".env.") ||
      /^(credential|credentials|secret|secrets|token|tokens|password|passwords|private[-_]?keys?)$/i.test(stem) ||
      /^(access|auth|refresh|client|api)[-_](credential|credentials|secret|token|password|key)$/i.test(stem) ||
      /\.(key|pem|p12|pfx|keystore)$/i.test(segment);
  });
}

function statEntry(relative, required) {
  const absolute = path.join(source, ...relative.split("/"));
  assertInside(source, absolute);
  let stats;
  try {
    stats = fs.lstatSync(absolute);
  } catch (error) {
    if (!required && error?.code === "ENOENT") return null;
    fail("required_source_missing", relative);
  }
  if (stats.isSymbolicLink()) return { kind: "symlink", absolute, size: stats.size, mode: stats.mode };
  if (stats.isDirectory()) return { kind: "directory", absolute, size: stats.size, mode: stats.mode };
  if (stats.isFile()) return { kind: "file", absolute, size: stats.size, mode: stats.mode };
  return { kind: "special", absolute, size: stats.size, mode: stats.mode };
}

function assertReadOnlyMount(target) {
  const lines = fs.readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n");
  const mounts = lines.flatMap((line) => {
    const halves = line.split(" - ");
    const fields = halves[0]?.split(" ") ?? [];
    if (fields.length < 6) return [];
    return [{ mountPoint: decodeMount(fields[4]), options: new Set(fields[5].split(",")) }];
  }).filter((mount) => target === mount.mountPoint || target.startsWith(`${mount.mountPoint}${path.sep}`))
    .sort((left, right) => right.mountPoint.length - left.mountPoint.length);
  if (!mounts[0]?.options.has("ro")) fail("source_mount_must_be_read_only");
}

function decodeMount(value) {
  return value.replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function assertInside(parent, child) {
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("source_path_escape", child);
}

function fail(code, detail) {
  throw new Error(detail ? `${code}:${detail}` : code);
}
