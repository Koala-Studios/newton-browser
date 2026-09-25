import fs from "node:fs/promises";
import type {Stats} from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {hashNativeFile} from "./native-file.ts";

const execute = promisify(execFile);

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_METADATA_BYTES = 4096;
const MAX_BUILD_JSON_BYTES = 4096;
const SEA_BUILD_TIMEOUT_MS = 120_000;
const SEA_BUILD_MAX_BUFFER = 1024 * 1024;
const VALID_NODE_MAJOR = 25;
const VALID_NODE_MINOR = 5;

export async function buildNativeRuntime(
  root: string,
  entry: Buffer,
  runtime: string,
  runtimeName: "node.exe" | "node",
): Promise<{ digest: string; directory: string; }> {
  if (runtimeName !== "node" && runtimeName !== "node.exe") throw new Error("native_install_arguments");
  const canonicalRoot = await validateDirectory(root, "native_directory_invalid");
  if (entry.length > MAX_BYTES) throw new Error("native_file_invalid");
  const digest = createHash("sha256").update(entry).digest("hex");
  const builds = path.join(canonicalRoot, "builds");
  await fs.mkdir(builds, { recursive: true });
  const verifiedBuilds = await validateDirectory(builds, "native_directory_invalid");
  const directory = path.join(verifiedBuilds, digest);
  const verifyExisting = async () => {
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("native_installation_changed");
    const manifestPath = path.join(directory, "build.json");
    await hashNativeFile(manifestPath, MAX_BUILD_JSON_BYTES);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (manifest?.version !== 1 || manifest.entryDigest !== digest || typeof manifest.runtimeDigest !== "string"
      || !/^[a-f0-9]{64}$/.test(manifest.runtimeDigest)) throw new Error("native_installation_changed");
    const hostEntry = path.join(directory, "native-host.js");
    if (await hashNativeFile(hostEntry, MAX_BYTES) !== digest) throw new Error("native_installation_changed");
    if (await hashNativeFile(path.join(directory, runtimeName)) !== manifest.runtimeDigest) throw new Error("native_installation_changed");
  };
  let exists = true;
  try { await fs.lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw error; }
  if (exists) {
    await verifyExisting();
    return { digest, directory };
  }
  const runtimeDigest = await hashNativeFile(runtime);
  const stage = await fs.mkdtemp(path.join(verifiedBuilds, ".stage-"));
  const identity = await fs.lstat(stage);
  try {
    await fs.writeFile(path.join(stage, "native-host.js"), entry, { flag: "wx", mode: 0o600 });
    await fs.copyFile(runtime, path.join(stage, runtimeName));
    if (process.platform === "linux") {
      await fs.chmod(path.join(stage, runtimeName), 0o700);
    }
    if (await hashNativeFile(path.join(stage, runtimeName)) !== runtimeDigest) throw new Error("native_file_changed");
    await fs.writeFile(path.join(stage, "build.json"), JSON.stringify({ version: 1, entryDigest: digest, runtimeDigest }) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    try {
      await fs.rename(stage, directory);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await verifyExisting();
    }
    return { digest, directory };
  } finally {
    await removeStageFiles(stage, identity, verifiedBuilds, ["native-host.js", runtimeName, "build.json"]);
  }
}

export async function buildNativeLauncher(
  root: string,
  sourceBytes: Buffer,
  launcherName: "native-launcher.exe" | "native-launcher",
): Promise<string> {
  if (launcherName !== "native-launcher" && launcherName !== "native-launcher.exe") {
    throw new Error("native_install_arguments");
  }
  if (sourceBytes.length > MAX_BYTES) throw new Error("native_file_invalid");
  const canonicalRoot = await validateDirectory(root, "native_directory_invalid");
  const sourceDigest = createHash("sha256").update(sourceBytes).digest("hex");
  const parent = path.join(canonicalRoot, "launchers");
  await fs.mkdir(parent, { recursive: true });
  const verifiedParent = await validateDirectory(parent, "native_directory_invalid");
  const directory = path.join(verifiedParent, sourceDigest);
  const verifyExisting = async () => {
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("native_launcher_changed");
    const metadataPath = path.join(directory, "launcher.json");
    await hashNativeFile(metadataPath, MAX_METADATA_BYTES);
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    if (metadata.sourceDigest !== sourceDigest
      || typeof metadata.binaryDigest !== "string" || !/^[a-f0-9]{64}$/.test(metadata.binaryDigest)) {
      throw new Error("native_launcher_changed");
    }
    if (await hashNativeFile(path.join(directory, launcherName)) !== metadata.binaryDigest) throw new Error("native_launcher_changed");
  };
  let exists = true;
  try { await fs.lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw error; }
  if (exists) {
    await verifyExisting();
    return path.join(directory, launcherName);
  }
  validateNodeForSeaBuild();
  const stage = await fs.mkdtemp(path.join(verifiedParent, ".stage-"));
  const identity = await fs.lstat(stage);
  try {
    const sourcePath = path.join(stage, "launcher.cjs");
    const configPath = path.join(stage, "sea.json");
    const binaryPath = path.join(stage, launcherName);
    const metadataPath = path.join(stage, "launcher.json");
    await fs.writeFile(sourcePath, sourceBytes, { flag: "wx", mode: 0o600 });
    await fs.writeFile(configPath, JSON.stringify({
      main: sourcePath,
      output: binaryPath,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false,
    }) + "\n", { flag: "wx", mode: 0o600 });
    await runSeaBuild(configPath);
    const binaryDigest = await hashNativeFile(binaryPath);
    if (process.platform === "linux") {
      await fs.chmod(binaryPath, 0o700);
    }
    await fs.writeFile(metadataPath, JSON.stringify({ sourceDigest, binaryDigest }) + "\n", { flag: "wx", mode: 0o600 });
    try {
      await fs.rename(stage, directory);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await verifyExisting();
    }
    return path.join(directory, launcherName);
  } finally {
    await removeStageFiles(stage, identity, verifiedParent, ["launcher.cjs", "sea.json", launcherName, "launcher.json"]);
  }
}

function validateNodeForSeaBuild(): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < VALID_NODE_MAJOR || (major === VALID_NODE_MAJOR && minor < VALID_NODE_MINOR)) {
    throw new Error("native_launcher_build_requires_node_25_5");
  }
}

async function runSeaBuild(config: string): Promise<void> {
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  await execute(process.execPath, ["--build-sea", config], {
    windowsHide: true,
    timeout: SEA_BUILD_TIMEOUT_MS,
    maxBuffer: SEA_BUILD_MAX_BUFFER,
    env: environment,
  });
}

async function validateDirectory(target: string, errorCode: string): Promise<string> {
  if (!path.isAbsolute(target)) throw new Error(errorCode);
  const resolved = path.resolve(target);
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(errorCode);
  const canonical = await fs.realpath(resolved);
  if (canonical !== resolved) throw new Error(errorCode);
  return canonical;
}

async function removeStageFiles(
  stage: string,
  identity: Stats,
  expectedParent: string,
  files: readonly string[],
): Promise<void> {
  const current = await fs.lstat(stage).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!current) return;
  const resolvedStage = await fs.realpath(stage);
  const resolvedParent = await fs.realpath(expectedParent);
  const expectedParentPath = path.resolve(expectedParent);
  if (resolvedParent !== expectedParentPath) throw new Error("native_stage_changed");
  if (resolvedStage !== path.resolve(stage) || path.dirname(resolvedStage) !== expectedParentPath) throw new Error("native_stage_changed");
  if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== identity.ino || current.dev !== identity.dev) {
    throw new Error("native_stage_changed");
  }
  for (const file of files) {
    await fs.unlink(path.join(stage, file)).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
  await fs.rmdir(stage);
}
