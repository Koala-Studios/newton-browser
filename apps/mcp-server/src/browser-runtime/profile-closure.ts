import { spawnSync } from "node:child_process";
import path from "node:path";

import type { SourceClosureVerifier } from "./profile-store.ts";

const PROCESS_OUTPUT_LIMIT = 4 * 1024 * 1024;
const PROCESS_COUNT_LIMIT = 32_768;
const PROCESS_FIELD_LIMIT = 128 * 1024;

export type BrowserProcessFamily = "chrome" | "edge";
export type ProcessTableEntry = Readonly<{
  pid: number;
  executable: string | null;
  commandLine: string | null;
}>;
export type ProcessListProvider = (platform: NodeJS.Platform) => readonly ProcessTableEntry[];

export type ProfileClosureVerifierOptions = Readonly<{
  browserFamily: BrowserProcessFamily;
  platform?: NodeJS.Platform;
  processListProvider?: ProcessListProvider;
}>;

export function createProfileSourceClosureVerifier(
  options: ProfileClosureVerifierOptions,
): SourceClosureVerifier {
  const family = options?.browserFamily;
  const platform = options?.platform ?? process.platform;
  const provider = options?.processListProvider ?? systemProcessList;
  return (source) => {
    try {
      if ((family !== "chrome" && family !== "edge") || !supportedPlatform(platform)
        || typeof provider !== "function" || !validSource(source)) return false;
      const processes = provider(platform);
      if (!Array.isArray(processes) || processes.length > PROCESS_COUNT_LIMIT) return false;
      for (const processEntry of processes) {
        if (!validEntry(processEntry)) return false;
        const detected = detectBrowserFamilies(processEntry);
        // Deliberately exempt no PID, including Newton's own. Without an
        // independently proven executable + profile binding, exclusion could
        // turn an active source into a false closure proof.
        if (detected.size > 1 || detected.has(family)) return false;
      }
      return true;
    } catch {
      return false;
    }
  };
}

const systemProcessList: ProcessListProvider = (platform) => {
  if (platform === "win32") return windowsProcessList();
  if (platform === "darwin" || platform === "linux") return unixProcessList();
  throw new Error("process_table_unsupported");
};

function windowsProcessList(): readonly ProcessTableEntry[] {
  const script = [
    "$ErrorActionPreference='Stop'",
    "@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 } | Select-Object ProcessId,Name,ExecutablePath) | ConvertTo-Json -Compress -Depth 3",
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
  try {
    parsed = JSON.parse(output.replace(/^\uFEFF/u, ""));
  } catch {
    throw new Error("process_table_malformed");
  }
  if (!Array.isArray(parsed)) throw new Error("process_table_malformed");
  return parsed.map((value) => {
    if (!record(value)) throw new Error("process_table_malformed");
    const pid = value.ProcessId;
    const name = nullableString(value.Name);
    const executablePath = nullableString(value.ExecutablePath);
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0 || name === undefined
      || executablePath === undefined) throw new Error("process_table_malformed");
    return {
      pid: Number(pid),
      executable: executablePath ?? name,
      // Windows family detection is executable-based. Avoid collecting and
      // validating unrelated process arguments, which may legitimately contain
      // line breaks and are unnecessary for a conservative all-family check.
      commandLine: null,
    };
  });
}

function unixProcessList(): readonly ProcessTableEntry[] {
  const result = spawnSync("ps", ["-axww", "-o", "pid=", "-o", "command="], {
    encoding: "utf8",
    maxBuffer: PROCESS_OUTPUT_LIMIT,
  });
  const output = checkedCommandOutput(result);
  if (output.length === 0) throw new Error("process_table_malformed");
  const entries: ProcessTableEntry[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const matched = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (!matched) throw new Error("process_table_malformed");
    const pid = Number(matched[1]);
    const commandLine = matched[2] ?? "";
    if (!Number.isSafeInteger(pid) || pid <= 0 || !validField(commandLine)) throw new Error("process_table_malformed");
    entries.push({ pid, executable: null, commandLine });
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

function detectBrowserFamilies(entry: ProcessTableEntry): Set<BrowserProcessFamily> {
  const families = new Set<BrowserProcessFamily>();
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
  // Linux Chromium executables do not contain spaces. macOS app bundles do;
  // match their fixed leading bundle path without inspecting later arguments.
  const mac = /^(\/Applications\/(?:Google Chrome|Microsoft Edge)\.app\/Contents\/MacOS\/(?:Google Chrome|Microsoft Edge))(?:\s|$)/iu.exec(trimmed);
  if (mac?.[1]) return mac[1];
  return trimmed.split(/\s+/u, 1)[0] ?? "";
}

function validEntry(value: unknown): value is ProcessTableEntry {
  if (!record(value) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) return false;
  if (value.executable !== null && !validField(value.executable)) return false;
  if (value.commandLine !== null && !validField(value.commandLine)) return false;
  return value.executable !== null || value.commandLine !== null;
}

function validField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= PROCESS_FIELD_LIMIT && !value.includes("\0")
    && !value.includes("\n") && !value.includes("\r");
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return validField(value) ? value : undefined;
}

function validSource(source: Readonly<{ userDataRoot: string; profileDirectory: string }>): boolean {
  return Boolean(source && typeof source.userDataRoot === "string" && path.isAbsolute(source.userDataRoot)
    && source.userDataRoot.length <= PROCESS_FIELD_LIMIT && !source.userDataRoot.includes("\0")
    && typeof source.profileDirectory === "string" && source.profileDirectory.length > 0
    && source.profileDirectory.length <= 128 && path.basename(source.profileDirectory) === source.profileDirectory
    && !source.profileDirectory.includes("\0"));
}

function supportedPlatform(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin" || platform === "linux";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
