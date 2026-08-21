import { spawnSync } from "node:child_process";
import path from "node:path";

import type { IdentityLeaseClosureVerifier } from "./profile-store.ts";

const PROCESS_OUTPUT_LIMIT = 4 * 1024 * 1024;
const PROCESS_COUNT_LIMIT = 32_768;
const PROCESS_FIELD_LIMIT = 128 * 1024;

export type IdentityLeaseProcessTableEntry = Readonly<{
  pid: number;
  parentPid: number;
  executable: string | null;
  commandLine: string | null;
}>;

export type IdentityLeaseProcessListProvider = (
  platform: NodeJS.Platform,
) => readonly IdentityLeaseProcessTableEntry[];

export type IdentityLeaseClosureVerifierOptions = Readonly<{
  browserFamily: "chrome" | "edge";
  platform?: NodeJS.Platform;
  processListProvider?: IdentityLeaseProcessListProvider;
}>;

export function createIdentityLeaseClosureVerifier(
  options: IdentityLeaseClosureVerifierOptions,
): IdentityLeaseClosureVerifier {
  const family = options?.browserFamily;
  const platform = options?.platform ?? process.platform;
  const provider = options?.processListProvider ?? systemProcessList;
  return (source) => {
    try {
      if ((family !== "chrome" && family !== "edge") || !supportedPlatform(platform)
        || typeof provider !== "function" || !validSource(source, platform)) return false;
      const processes = provider(platform);
      if (!Array.isArray(processes) || processes.length > PROCESS_COUNT_LIMIT) return false;
      const byPid = new Map<number, IdentityLeaseProcessTableEntry>();
      for (const entry of processes) {
        if (!validEntry(entry) || byPid.has(entry.pid)) return false;
        byPid.set(entry.pid, entry);
      }
      if (byPid.has(source.recordedHostPid)) return false;
      for (const entry of processes) {
        if (descendsFrom(entry, source.recordedHostPid, byPid)) return false;
        const detected = detectBrowserFamilies(entry);
        if (detected.size > 1) return false;
        if (!detected.has(family)) continue;
        if (entry.commandLine === null) return false;
        if (usesExactUserDataRoot(entry.commandLine, source.userDataRoot, platform)) return false;
      }
      return true;
    } catch {
      return false;
    }
  };
}

const systemProcessList: IdentityLeaseProcessListProvider = (platform) => {
  if (platform === "win32") return windowsProcessList();
  if (platform === "darwin" || platform === "linux") return unixProcessList();
  throw new Error("process_table_unsupported");
};

function windowsProcessList(): readonly IdentityLeaseProcessTableEntry[] {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$items=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine)",
    "ConvertTo-Json -InputObject $items -Compress -Depth 3",
  ].join(";");
  const result = spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-Command", script,
  ], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: PROCESS_OUTPUT_LIMIT,
  });
  const output = checkedCommandOutput(result);
  let parsed: unknown;
  try { parsed = JSON.parse(output.replace(/^\uFEFF/u, "")); }
  catch { throw new Error("process_table_malformed"); }
  if (!Array.isArray(parsed)) throw new Error("process_table_malformed");
  return parsed.map((value) => {
    if (!record(value)) throw new Error("process_table_malformed");
    const pid = value.ProcessId;
    const parentPid = value.ParentProcessId;
    const name = nullableString(value.Name);
    const executablePath = nullableString(value.ExecutablePath);
    const commandLine = nullableString(value.CommandLine, true);
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0
      || !Number.isSafeInteger(parentPid) || Number(parentPid) < 0
      || name === undefined || executablePath === undefined || commandLine === undefined) {
      throw new Error("process_table_malformed");
    }
    return {
      pid: Number(pid),
      parentPid: Number(parentPid),
      executable: executablePath ?? name,
      commandLine,
    };
  });
}

function unixProcessList(): readonly IdentityLeaseProcessTableEntry[] {
  const result = spawnSync("ps", ["-axww", "-o", "pid=", "-o", "ppid=", "-o", "command="], {
    encoding: "utf8",
    maxBuffer: PROCESS_OUTPUT_LIMIT,
  });
  const output = checkedCommandOutput(result);
  if (output.length === 0) throw new Error("process_table_malformed");
  const entries: IdentityLeaseProcessTableEntry[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const matched = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!matched) throw new Error("process_table_malformed");
    const pid = Number(matched[1]);
    const parentPid = Number(matched[2]);
    const commandLine = matched[3] ?? "";
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || parentPid < 0
      || !validField(commandLine)) throw new Error("process_table_malformed");
    entries.push({ pid, parentPid, executable: null, commandLine });
    if (entries.length > PROCESS_COUNT_LIMIT) throw new Error("process_table_truncated");
  }
  if (entries.length === 0) throw new Error("process_table_malformed");
  return entries;
}

function checkedCommandOutput(result: ReturnType<typeof spawnSync>): string {
  if (result.error || result.status !== 0 || result.signal !== null || typeof result.stdout !== "string"
    || Buffer.byteLength(result.stdout, "utf8") >= PROCESS_OUTPUT_LIMIT) {
    throw new Error(result.error && "code" in result.error && result.error.code === "ENOBUFS"
      ? "process_table_truncated"
      : "process_table_failed");
  }
  return result.stdout;
}

function descendsFrom(
  entry: IdentityLeaseProcessTableEntry,
  recordedHostPid: number,
  byPid: ReadonlyMap<number, IdentityLeaseProcessTableEntry>,
): boolean {
  let parentPid = entry.parentPid;
  const seen = new Set<number>([entry.pid]);
  for (let depth = 0; depth <= byPid.size; depth += 1) {
    if (parentPid === recordedHostPid) return true;
    if (parentPid === 0) return false;
    if (seen.has(parentPid)) throw new Error("process_table_cycle");
    seen.add(parentPid);
    const parent = byPid.get(parentPid);
    if (!parent) return false;
    parentPid = parent.parentPid;
  }
  throw new Error("process_table_cycle");
}

function usesExactUserDataRoot(commandLine: string, userDataRoot: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string): string => {
    const slashed = platform === "win32" ? value.replaceAll("\\", "/") : value;
    return platform === "win32" ? slashed.toLocaleLowerCase("en-US") : slashed;
  };
  const command = normalize(commandLine);
  const root = normalize(platform === "win32" ? path.win32.resolve(userDataRoot) : path.posix.resolve(userDataRoot));
  const marker = "--user-data-dir=";
  let offset = command.indexOf(marker);
  while (offset >= 0) {
    const before = offset === 0 ? "" : command[offset - 1] ?? "";
    if (!before || /[\s"']/u.test(before)) {
      const valueStart = offset + marker.length;
      const innerQuote = command[valueStart];
      const outerQuote = before === '"' || before === "'" ? before : "";
      const quote = innerQuote === '"' || innerQuote === "'" ? innerQuote : outerQuote;
      const contentStart = innerQuote === '"' || innerQuote === "'" ? valueStart + 1 : valueStart;
      const whitespaceOffset = command.slice(contentStart).search(/\s/u);
      const contentEnd = quote
        ? command.indexOf(quote, contentStart)
        : whitespaceOffset < 0 ? -1 : contentStart + whitespaceOffset;
      const valueEnd = contentEnd < 0 ? command.length : contentEnd;
      if (command.slice(contentStart, valueEnd) === root) return true;
    }
    offset = command.indexOf(marker, offset + marker.length);
  }
  return false;
}

function detectBrowserFamilies(entry: IdentityLeaseProcessTableEntry): Set<"chrome" | "edge"> {
  const families = new Set<"chrome" | "edge">();
  const executable = entry.executable?.toLocaleLowerCase("en-US") ?? "";
  const leadingCommand = entry.executable === null
    ? leadingProcessCommand(entry.commandLine ?? "").toLocaleLowerCase("en-US")
    : "";
  const evidence = executable || leadingCommand;
  if (/(?:^|[\\/])(?:google chrome(?:\.app)?|google-chrome(?:-[a-z]+)?|chromium(?:-browser)?|chrome)(?:\.exe)?(?:$|[\\/])/u.test(evidence)) {
    families.add("chrome");
  }
  if (/(?:^|[\\/])(?:microsoft edge(?:\.app)?|msedge)(?:\.exe)?(?:$|[\\/])/u.test(evidence)) {
    families.add("edge");
  }
  return families;
}

function leadingProcessCommand(commandLine: string): string {
  const trimmed = commandLine.trimStart();
  if (!trimmed) return "";
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    return end > 1 ? trimmed.slice(1, end) : "";
  }
  const mac = /^(\/Applications\/(?:Google Chrome|Microsoft Edge)\.app\/Contents\/MacOS\/(?:Google Chrome|Microsoft Edge))(?:\s|$)/iu.exec(trimmed);
  if (mac?.[1]) return mac[1];
  return trimmed.split(/\s+/u, 1)[0] ?? "";
}

function validEntry(value: unknown): value is IdentityLeaseProcessTableEntry {
  if (!record(value) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
    || !Number.isSafeInteger(value.parentPid) || Number(value.parentPid) < 0) return false;
  if (value.executable !== null && !validField(value.executable)) return false;
  if (value.commandLine !== null && !validField(value.commandLine, true)) return false;
  return value.executable !== null || value.commandLine !== null;
}

function validField(value: unknown, allowLineBreaks = false): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= PROCESS_FIELD_LIMIT
    && !value.includes("\0") && (allowLineBreaks || (!value.includes("\n") && !value.includes("\r")));
}

function nullableString(value: unknown, allowLineBreaks = false): string | null | undefined {
  if (value === null) return null;
  return validField(value, allowLineBreaks) ? value : undefined;
}

function validSource(source: Readonly<{
  userDataRoot: string;
  profileDirectory: string;
  recordedHostPid: number;
}>, platform: NodeJS.Platform): boolean {
  const paths = platform === "win32" ? path.win32 : path.posix;
  return Boolean(source && typeof source.userDataRoot === "string" && paths.isAbsolute(source.userDataRoot)
    && source.userDataRoot.length <= PROCESS_FIELD_LIMIT && !source.userDataRoot.includes("\0")
    && typeof source.profileDirectory === "string" && source.profileDirectory.length > 0
    && source.profileDirectory.length <= 128 && paths.basename(source.profileDirectory) === source.profileDirectory
    && !source.profileDirectory.includes("\0") && Number.isSafeInteger(source.recordedHostPid)
    && source.recordedHostPid > 0);
}

function supportedPlatform(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin" || platform === "linux";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
