import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type InstallClient = "codex" | "generic";

export const INSTALL_CLIENTS: InstallClient[] = ["codex", "generic"];

export const SERVER_KEY = "newton-browser";

export type ServerInvocation = { command: string; args: string[] };

// The single source of truth for how a client launches the host.
export function serverInvocation(input: { entryPath?: string; execPath?: string } = {}): ServerInvocation {
  const rawEntry = input.entryPath ?? process.argv[1];
  const rawExec = input.execPath ?? process.execPath;
  if (!rawEntry || !path.isAbsolute(rawEntry) || !path.isAbsolute(rawExec)
    || rawEntry.includes("\0") || rawExec.includes("\0")) throw new Error("server_invocation_unavailable");
  const entry = exactInvocationFile(rawEntry, false);
  const command = exactInvocationFile(rawExec, true);
  return { command, args: [entry] };
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

export type InstallResult = InstallPlan & { backupPath?: string; wrote: boolean };

// Apply a plan to disk. Always writes a timestamped `.bak` before overwriting an
// existing file. `dryRun` computes and returns the plan without touching disk.
export function runInstall(input: {
  client: InstallClient;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  force?: boolean;
  dryRun?: boolean;
  invocation?: ServerInvocation;
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
  if (input.dryRun || plan.action === "conflict" || plan.action === "noop" || plan.nextContent === undefined) {
    return { ...plan, wrote: false };
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
  return { ...plan, ...(backupPath === undefined ? {} : { backupPath }), wrote: true };
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
  return JSON.stringify({ command: invocation.command, args: invocation.args }, null, 2);
}
