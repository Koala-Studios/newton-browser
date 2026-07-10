import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NEWTON_BROWSER_VERSION } from "./cli.ts";

export type InstallClient = "codex" | "claude-desktop" | "claude-code" | "generic";

export const INSTALL_CLIENTS: InstallClient[] = ["codex", "claude-desktop", "claude-code", "generic"];

export const SERVER_KEY = "newton-browser";

export type ServerInvocation = { command: string; args: string[] };

// The single source of truth for how a client should launch the host. `--print-config`
// and `--install` both build on this so the two never drift.
export function serverInvocation(env: NodeJS.ProcessEnv = process.env): ServerInvocation {
  const packageSpec = env.NEWTON_BROWSER_PACKAGE_SPEC || `${SERVER_KEY}@${NEWTON_BROWSER_VERSION}`;
  return { command: "npx", args: ["--yes", "--package", packageSpec, SERVER_KEY] };
}

export type ClientConfigTarget =
  | { kind: "file"; format: "toml" | "json"; path: string }
  | { kind: "manual"; command: string };

// Resolve where a client keeps its MCP server configuration. Returns a `manual` target
// for clients we do not edit in place (Claude Code owns its own store; generic clients
// have no canonical path), so the caller can print an exact command instead.
export function clientConfigTarget(
  client: InstallClient,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ClientConfigTarget {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  switch (client) {
    case "codex":
      return { kind: "file", format: "toml", path: path.join(home, ".codex", "config.toml") };
    case "claude-desktop": {
      if (platform === "win32") {
        const base = env.APPDATA || path.join(home, "AppData", "Roaming");
        return { kind: "file", format: "json", path: path.join(base, "Claude", "claude_desktop_config.json") };
      }
      if (platform === "darwin") {
        return { kind: "file", format: "json", path: path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json") };
      }
      const base = env.XDG_CONFIG_HOME || path.join(home, ".config");
      return { kind: "file", format: "json", path: path.join(base, "Claude", "claude_desktop_config.json") };
    }
    case "claude-code": {
      const invocation = serverInvocation(env);
      const json = JSON.stringify({ command: invocation.command, args: invocation.args });
      return { kind: "manual", command: `claude mcp add-json ${SERVER_KEY} '${json}'` };
    }
    case "generic":
    default:
      return { kind: "manual", command: `Add this server entry to your client:\n${renderGenericConfig(env)}` };
  }
}

export type InstallAction = "create" | "update" | "noop" | "conflict" | "manual";

export type InstallPlan = {
  client: InstallClient;
  action: InstallAction;
  path?: string;
  format?: "toml" | "json";
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
}): InstallPlan {
  const env = input.env ?? process.env;
  const target = clientConfigTarget(input.client, env, input.platform ?? process.platform);
  if (target.kind === "manual") {
    return {
      client: input.client,
      action: "manual",
      entryExists: false,
      manualCommand: target.command,
      message: `Newton Browser cannot edit ${input.client} configuration directly. Run the printed command instead.`,
    };
  }
  const invocation = serverInvocation(env);
  const existing = input.existing;
  const merge = target.format === "toml"
    ? mergeCodexToml(existing, invocation, Boolean(input.force))
    : mergeJsonConfig(existing, invocation, Boolean(input.force));
  return {
    client: input.client,
    action: merge.action,
    path: target.path,
    format: target.format,
    previousContent: existing,
    nextContent: merge.nextContent,
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
}): InstallResult {
  const env = input.env ?? process.env;
  const target = clientConfigTarget(input.client, env, input.platform ?? process.platform);
  if (target.kind === "manual") {
    const plan = planClientInstall({ ...input, env });
    return { ...plan, wrote: false };
  }
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(target.path, "utf8");
  } catch {
    existing = undefined;
  }
  const plan = planClientInstall({ ...input, env, existing });
  if (input.dryRun || plan.action === "conflict" || plan.action === "noop" || plan.nextContent === undefined) {
    return { ...plan, wrote: false };
  }
  fs.mkdirSync(path.dirname(target.path), { recursive: true });
  let backupPath: string | undefined;
  if (existing !== undefined) {
    backupPath = `${target.path}.${installTimestamp()}.bak`;
    fs.writeFileSync(backupPath, existing, "utf8");
  }
  fs.writeFileSync(target.path, plan.nextContent, "utf8");
  return { ...plan, backupPath, wrote: true };
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

function mergeJsonConfig(existing: string | undefined, invocation: ServerInvocation, force: boolean): MergeOutcome {
  let root: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    try {
      const parsed = JSON.parse(existing);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return unparseable("json");
      }
      root = parsed as Record<string, unknown>;
    } catch {
      return unparseable("json");
    }
  }
  const servers = (root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)
    ? root.mcpServers
    : {}) as Record<string, unknown>;
  const entryExists = Object.prototype.hasOwnProperty.call(servers, SERVER_KEY);
  if (entryExists && !force) {
    return {
      action: "conflict",
      entryExists,
      message: (file) => `A "${SERVER_KEY}" entry already exists in ${file}. Re-run with --force to replace it.`,
    };
  }
  const nextServers = { ...servers, [SERVER_KEY]: { command: invocation.command, args: invocation.args } };
  const nextRoot = { ...root, mcpServers: nextServers };
  const nextContent = `${JSON.stringify(nextRoot, null, 2)}\n`;
  return {
    action: entryExists ? "update" : "create",
    entryExists,
    nextContent,
    message: (file) => `${entryExists ? "Updated" : "Added"} the "${SERVER_KEY}" MCP server in ${file}.`,
  };
}

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
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
  const before = lines.slice(0, start).join("\n");
  const after = lines.slice(end).join("\n");
  const parts = [before.replace(/\n+$/, ""), block, after.replace(/^\n+/, "")].filter((part) => part !== "");
  return `${parts.join("\n\n")}\n`;
}

function unparseable(format: "json" | "toml"): MergeOutcome {
  return {
    action: "conflict",
    entryExists: false,
    message: (file) => `client_config_unparseable: ${file} is not valid ${format.toUpperCase()}. Fix or move it, then retry.`,
  };
}

function renderGenericConfig(env: NodeJS.ProcessEnv): string {
  const invocation = serverInvocation(env);
  return JSON.stringify({ command: invocation.command, args: invocation.args }, null, 2);
}
