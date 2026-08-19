import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type InstallClient = "codex" | "generic";

export const INSTALL_CLIENTS: InstallClient[] = ["codex", "generic"];

export const SERVER_KEY = "newton-browser";

const CODEX_PROTOCOL_VERSION = "2026-07-28";
const REQUIRED_BROWSER_TOOLS = Object.freeze([
  "browser.status",
  "browser.session.start",
  "browser.observe",
  "browser.act",
  "browser.screenshot",
  "browser.console",
  "browser.network",
  "browser.sessions.list",
  "browser.session.stop",
  "browser.stop_all",
] as const);

export type ServerInvocation = { command: string; args: string[]; version: string };
export type CodexCandidateReceipt = Readonly<{
  compatible: true;
  protocolVersion: typeof CODEX_PROTOCOL_VERSION;
  version: string;
  requiredToolCount: number;
}>;

// The single source of truth for how a client launches the host.
export function serverInvocation(input: { entryPath?: string; execPath?: string } = {}): ServerInvocation {
  const rawEntry = input.entryPath ?? process.argv[1];
  const rawExec = input.execPath ?? process.execPath;
  if (!rawEntry || !path.isAbsolute(rawEntry) || !path.isAbsolute(rawExec)
    || rawEntry.includes("\0") || rawExec.includes("\0")) throw new Error("server_invocation_unavailable");
  const entry = exactInvocationFile(rawEntry, false);
  const command = exactInvocationFile(rawExec, true);
  return { command, args: [entry], version: invocationPackageVersion(entry) };
}

function invocationPackageVersion(entry: string): string {
  const manifestPath = path.resolve(path.dirname(entry), "..", "package.json");
  const manifest = exactInvocationFile(manifestPath, false);
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(manifest, "utf8")); } catch { throw new Error("server_invocation_unavailable"); }
  const version = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).version
    : undefined;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error("server_invocation_unavailable");
  }
  return version;
}

export function verifyCodexCandidate(invocation: ServerInvocation): CodexCandidateReceipt {
  const metadata = {
    "io.modelcontextprotocol/protocolVersion": CODEX_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: "newton-browser-installer", version: invocation.version },
  };
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: metadata } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: metadata } },
  ].map((value) => JSON.stringify(value)).join("\n") + "\n";
  const probeDirectory = createCodexProbeDirectory();
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(process.execPath, [
      "-e",
      CODEX_CANDIDATE_PROBE,
      invocation.command,
      ...invocation.args,
    ], {
      input: requests,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        NEWTON_BROWSER_CONFIG_DIR: probeDirectory.path,
        NEWTON_BROWSER_EXPECTED_VERSION: invocation.version,
        CODEX_MCP_PROTOCOL_VERSION: CODEX_PROTOCOL_VERSION,
      },
    });
  } finally {
    removeCodexProbeDirectory(probeDirectory);
  }
  if (result.error || result.status !== 0 || result.signal || typeof result.stdout !== "string") {
    throw new Error("codex_mcp_candidate_incompatible");
  }
  let frames: unknown[];
  try {
    frames = result.stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  } catch { throw new Error("codex_mcp_candidate_incompatible"); }
  const initialized = responseResult(frames, 1);
  const listed = responseResult(frames, 2);
  const supportedVersions = Array.isArray(initialized?.supportedVersions) ? initialized.supportedVersions : [];
  const discoveryMeta = record(initialized?._meta);
  const serverInfo = record(discoveryMeta?.["io.modelcontextprotocol/serverInfo"]);
  const tools = Array.isArray(listed?.tools) ? listed.tools : [];
  const names = new Set(tools.map((tool) => record(tool)?.name).filter((name): name is string => typeof name === "string"));
  if (!supportedVersions.includes(CODEX_PROTOCOL_VERSION) || serverInfo?.name !== "newton-browser"
    || serverInfo.version !== invocation.version || REQUIRED_BROWSER_TOOLS.some((name) => !names.has(name))) {
    throw new Error("codex_mcp_candidate_incompatible");
  }
  return Object.freeze({
    compatible: true,
    protocolVersion: CODEX_PROTOCOL_VERSION,
    version: invocation.version,
    requiredToolCount: REQUIRED_BROWSER_TOOLS.length,
  });
}

const CODEX_CANDIDATE_PROBE = String.raw`
const { spawn } = require("node:child_process");
const command = process.argv[1];
const args = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const child = spawn(command, args, { env: process.env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  let output = "";
  let settled = false;
  let receivedAll = false;
  const finish = (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (code === 0 && receivedAll) process.stdout.write(output);
    process.exitCode = code;
  };
  const timer = setTimeout(() => { child.kill(); finish(1); }, 8000);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (Buffer.byteLength(output) > 1024 * 1024) { child.kill(); finish(1); return; }
    const ids = new Set();
    try {
      for (const line of output.split(/\r?\n/).filter(Boolean)) {
        const frame = JSON.parse(line);
        if (frame && (frame.id === 1 || frame.id === 2)) ids.add(frame.id);
      }
    } catch { return; }
    if (ids.has(1) && ids.has(2) && !receivedAll) {
      receivedAll = true;
      child.stdin.end();
    }
  });
  child.once("error", () => finish(1));
  child.once("exit", (code, signal) => finish(code === 0 && !signal && receivedAll ? 0 : 1));
  child.stdin.write(input);
});
`;

type CodexProbeDirectory = Readonly<{
  path: string;
  tempRoot: string;
  dev: number;
  ino: number;
}>;

function createCodexProbeDirectory(): CodexProbeDirectory {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const created = fs.mkdtempSync(path.join(tempRoot, "newton-codex-mcp-probe-"));
  const resolved = fs.realpathSync.native(created);
  const stat = fs.lstatSync(resolved);
  if (resolved !== created || path.dirname(resolved) !== tempRoot
    || !path.basename(resolved).startsWith("newton-codex-mcp-probe-")
    || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("codex_mcp_candidate_incompatible");
  }
  return Object.freeze({ path: resolved, tempRoot, dev: stat.dev, ino: stat.ino });
}

function removeCodexProbeDirectory(directory: CodexProbeDirectory): void {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(directory.path); } catch { throw new Error("codex_mcp_candidate_incompatible"); }
  let resolved: string;
  try { resolved = fs.realpathSync.native(directory.path); } catch { throw new Error("codex_mcp_candidate_incompatible"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== directory.dev || stat.ino !== directory.ino
    || resolved !== directory.path || path.dirname(resolved) !== directory.tempRoot
    || !path.basename(resolved).startsWith("newton-codex-mcp-probe-")) {
    throw new Error("codex_mcp_candidate_incompatible");
  }
  fs.rmSync(directory.path, { recursive: true });
}

function responseResult(frames: readonly unknown[], id: number): Record<string, unknown> | null {
  const response = frames.map(record).find((frame) => frame?.id === id);
  return record(response?.result);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactInvocationFile(value: string, executable: boolean): string {
  const absolute = path.resolve(value);
  const sourceStat = fs.lstatSync(absolute);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error("server_invocation_unavailable");
  const resolved = fs.realpathSync.native(absolute);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("server_invocation_unavailable");
  if (executable && (process.platform === "win32"
    ? path.extname(resolved).toLowerCase() !== ".exe"
    : (stat.mode & 0o111) === 0)) throw new Error("server_invocation_unavailable");
  return resolved;
}

export type ClientConfigTarget =
  | { kind: "file"; format: "toml"; path: string }
  | { kind: "manual"; command: string };

// Codex has one known local config path. Generic clients receive an exact entry without
// any guess about where or how their configuration is stored.
export function clientConfigTarget(
  client: InstallClient,
  env: NodeJS.ProcessEnv = process.env,
  _platform: NodeJS.Platform = process.platform,
  invocation: ServerInvocation = serverInvocation(),
): ClientConfigTarget {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  switch (client) {
    case "codex":
      return { kind: "file", format: "toml", path: path.join(home, ".codex", "config.toml") };
    case "generic":
      return { kind: "manual", command: `Add this server entry to your client:\n${renderGenericConfig(invocation)}` };
    default:
      throw new Error("unsupported_install_client");
  }
}

export type InstallAction = "create" | "update" | "noop" | "conflict" | "manual";

export type InstallPlan = {
  client: InstallClient;
  action: InstallAction;
  path?: string;
  format?: "toml";
  previousContent?: string;
  nextContent?: string;
  entryExists: boolean;
  manualCommand?: string;
  message: string;
};

// Pure planner: given the current file content (or undefined when the file is absent),
// compute what the install would do. IO-free so it is exhaustively unit-testable.
export function planClientInstall(input: {
  client: InstallClient;
  existing?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  force?: boolean;
  invocation?: ServerInvocation;
}): InstallPlan {
  const env = input.env ?? process.env;
  const invocation = input.invocation ?? serverInvocation();
  const target = clientConfigTarget(input.client, env, input.platform ?? process.platform, invocation);
  if (target.kind === "manual") {
    return {
      client: input.client,
      action: "manual",
      entryExists: false,
      manualCommand: target.command,
      message: `Newton Browser cannot edit ${input.client} configuration directly. Add the printed server entry to that client.`,
    };
  }
  const existing = input.existing;
  const merge = mergeCodexToml(existing, invocation, Boolean(input.force));
  return {
    client: input.client,
    action: merge.action,
    path: target.path,
    format: target.format,
    ...(existing === undefined ? {} : { previousContent: existing }),
    ...(merge.nextContent === undefined ? {} : { nextContent: merge.nextContent }),
    entryExists: merge.entryExists,
    message: merge.message(target.path),
  };
}

export type InstallResult = InstallPlan & {
  backupPath?: string;
  wrote: boolean;
  candidateVersion?: string;
  compatibilityVerified?: true;
};

// Apply a plan to disk. Always writes a timestamped `.bak` before overwriting an
// existing file. `dryRun` computes and returns the plan without touching disk.
export function runInstall(input: {
  client: InstallClient;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  force?: boolean;
  dryRun?: boolean;
  invocation?: ServerInvocation;
  verifyCandidate?: (invocation: ServerInvocation) => CodexCandidateReceipt;
}): InstallResult {
  const env = input.env ?? process.env;
  const invocation = input.invocation ?? serverInvocation();
  const target = clientConfigTarget(input.client, env, input.platform ?? process.platform, invocation);
  if (target.kind === "manual") {
    const plan = planClientInstall({ ...input, env });
    return { ...plan, wrote: false };
  }
  ensureSafeConfigTarget(target.path);
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(target.path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("unsafe_client_config_path");
    existing = undefined;
  }
  const plan = planClientInstall({ ...input, env, ...(existing === undefined ? {} : { existing }) });
  if (input.dryRun || plan.action === "conflict" || plan.nextContent === undefined) {
    return { ...plan, wrote: false };
  }
  const compatibility = input.client === "codex"
    ? (input.verifyCandidate ?? verifyCodexCandidate)(invocation)
    : null;
  if (plan.action === "noop") {
    return {
      ...plan,
      wrote: false,
      ...(compatibility ? { candidateVersion: compatibility.version, compatibilityVerified: true as const } : {}),
    };
  }
  const targetDirectory = path.dirname(target.path);
  fs.mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  ensureSafeConfigTarget(target.path);
  let backupPath: string | undefined;
  if (existing !== undefined) {
    backupPath = `${target.path}.${installTimestamp()}.bak`;
    fs.writeFileSync(backupPath, existing, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  atomicWriteConfig(target.path, plan.nextContent);
  return {
    ...plan,
    ...(backupPath === undefined ? {} : { backupPath }),
    wrote: true,
    ...(compatibility ? { candidateVersion: compatibility.version, compatibilityVerified: true as const } : {}),
  };
}

function ensureSafeConfigTarget(file: string): void {
  const directory = path.dirname(file);
  if (fs.existsSync(directory)) {
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("unsafe_client_config_path");
  }
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("unsafe_client_config_path");
}

function atomicWriteConfig(file: string, content: string): void {
  const nonce = randomBytes(16).toString("hex");
  const temporary = path.join(path.dirname(file), `.newton-browser-config.${process.pid}.${nonce}.tmp`);
  const displaced = path.join(path.dirname(file), `.newton-browser-config.${process.pid}.${nonce}.old`);
  let handle: number | undefined;
  let displacedExisting = false;
  try {
    handle = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(handle, content, "utf8");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    if (fs.existsSync(file)) {
      fs.renameSync(file, displaced);
      displacedExisting = true;
    }
    fs.renameSync(temporary, file);
    if (displacedExisting) {
      try {
        fs.rmSync(displaced);
        displacedExisting = false;
      } catch {
        // The new file is already installed, but the replacement is not
        // complete until the displaced original has been removed. Restore the
        // exact original instead of leaving two authoritative config copies.
        fs.renameSync(file, temporary);
        fs.renameSync(displaced, file);
        try { fs.rmSync(temporary); } catch { /* the authoritative original is restored */ }
        displacedExisting = false;
        throw new Error("client_config_write_failed");
      }
    }
  } catch {
    if (handle !== undefined) try { fs.closeSync(handle); } catch { /* cleanup below */ }
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve bounded failure */ }
    if (displacedExisting && fs.existsSync(displaced) && !fs.existsSync(file)) {
      try { fs.renameSync(displaced, file); } catch { /* caller receives bounded failure */ }
    }
    throw new Error("client_config_write_failed");
  }
}

function installTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

type MergeOutcome = {
  action: InstallAction;
  entryExists: boolean;
  nextContent?: string;
  message: (file: string) => string;
};

function mergeCodexToml(existing: string | undefined, invocation: ServerInvocation, force: boolean): MergeOutcome {
  const header = `[mcp_servers.${SERVER_KEY}]`;
  const block = [
    header,
    `command = ${JSON.stringify(invocation.command)}`,
    `args = [${invocation.args.map((value) => JSON.stringify(value)).join(", ")}]`,
    `env = { NEWTON_BROWSER_EXPECTED_VERSION = ${JSON.stringify(invocation.version)}, CODEX_MCP_PROTOCOL_VERSION = ${JSON.stringify(CODEX_PROTOCOL_VERSION)} }`,
  ].join("\n");
  const body = existing ?? "";
  const entryExists = body.split(/\r?\n/).some((line) => line.trim() === header);
  if (entryExists && !force) {
    return {
      action: "conflict",
      entryExists,
      message: (file) => `A "${header}" table already exists in ${file}. Re-run with --force to replace it.`,
    };
  }
  let nextContent: string;
  if (!entryExists) {
    const separator = body.trim() === "" ? "" : body.endsWith("\n") ? "\n" : "\n\n";
    nextContent = `${body}${separator}${block}\n`;
  } else {
    nextContent = replaceTomlTable(body, header, block);
  }
  nextContent = enableModernCodexFeature(nextContent);
  return {
    action: entryExists ? "update" : "create",
    entryExists,
    nextContent,
    message: (file) => `${entryExists ? "Updated" : "Added"} ${header} in ${file}.`,
  };
}

// Replace an existing TOML table (from its header line up to the next top-level `[`
// header or end of file) with a fresh block, preserving the rest of the file.
function replaceTomlTable(body: string, header: string, block: string): string {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return `${body}${body.endsWith("\n") ? "" : "\n"}${block}\n`;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end += 1;
  const before = lines.slice(0, start).join("\n");
  const after = lines.slice(end).join("\n");
  const parts = [before.replace(/\n+$/, ""), block, after.replace(/^\n+/, "")].filter((part) => part !== "");
  return `${parts.join("\n\n")}\n`;
}

function renderGenericConfig(invocation: ServerInvocation): string {
  return JSON.stringify({
    command: invocation.command,
    args: invocation.args,
    env: { NEWTON_BROWSER_EXPECTED_VERSION: invocation.version },
  }, null, 2);
}

function enableModernCodexFeature(body: string): string {
  const lines = body.split(/\r?\n/u);
  const headers = lines.reduce<number[]>((indexes, line, index) => {
    if (line.trim() === "[features]") indexes.push(index);
    return indexes;
  }, []);
  if (headers.length > 1) throw new Error("unsafe_client_config_path");
  if (headers.length === 0) {
    const prefix = body.trimEnd();
    return `${prefix}${prefix ? "\n\n" : ""}[features]\nmcp_2026_07_28 = true\n`;
  }
  const start = headers[0]!;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/u.test(lines[end]!)) end += 1;
  const keys: number[] = [];
  for (let index = start + 1; index < end; index += 1) {
    if (/^\s*mcp_2026_07_28\s*=/u.test(lines[index]!)) keys.push(index);
  }
  if (keys.length > 1) throw new Error("unsafe_client_config_path");
  if (keys.length === 1) lines[keys[0]!] = "mcp_2026_07_28 = true";
  else lines.splice(end, 0, "mcp_2026_07_28 = true");
  return `${lines.join("\n").replace(/\n+$/u, "")}\n`;
}
