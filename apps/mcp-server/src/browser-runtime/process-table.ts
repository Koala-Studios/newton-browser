import { spawn } from "node:child_process";
import type { ProcessTableEntry } from "./profile-closure.ts";
import type { IdentityLeaseProcessTableEntry } from "./identity-lease-closure.ts";

/** A scan is a fresh proof input. No negative-result cache survives a launch. */
export async function readProcessTable(options: { ownership: boolean; signal?: AbortSignal; timeoutMs?: number; platform?: NodeJS.Platform } ): Promise<readonly IdentityLeaseProcessTableEntry[]> {
  const platform = options.platform ?? process.platform;
  if (!["win32", "linux", "darwin"].includes(platform)) throw new Error("process_table_unsupported");
  const fields = options.ownership ? "ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine" : "ProcessId,ParentProcessId,Name,ExecutablePath";
  const command = platform === "win32" ? "powershell.exe" : "ps";
  const args = platform === "win32" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop'; ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 } | Select-Object ${fields}) -Compress -Depth 3`]
    : ["-axww", "-o", "pid=", "-o", "ppid=", "-o", options.ownership ? "command=" : "comm="];
  const output = await boundedProcessOutput(command, args, options);
  let rows: IdentityLeaseProcessTableEntry[];
  if (platform === "win32") {
    const parsed: unknown = JSON.parse(output.replace(/^\uFEFF/u, ""));
    if (!Array.isArray(parsed)) throw new Error("process_table_malformed");
    rows = parsed.map(row => ({ pid: row.ProcessId, parentPid: row.ParentProcessId, executable: row.ExecutablePath ?? row.Name,
      commandLine: options.ownership ? row.CommandLine ?? null : null }));
  } else rows = output.trim().split(/\r?\n/u).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match) throw new Error("process_table_malformed");
    return { pid: Number(match[1]), parentPid: Number(match[2]), executable: options.ownership ? null : match[3]!, commandLine: options.ownership ? match[3]! : null };
  });
  const ids = new Set<number>();
  if (!rows.length || rows.length > 32768) throw new Error("process_table_malformed");
  for (const row of rows) {
    if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || ids.has(row.pid) || !Number.isSafeInteger(row.parentPid) || row.parentPid < 0
      || !validField(row.executable) || !validField(row.commandLine)) throw new Error("process_table_malformed");
    ids.add(row.pid);
  }
  return rows;
}
function validField(value: unknown): boolean { return value === null || typeof value === "string" && value.length <= 131072 && !value.includes("\0"); }
export function asFamilyTable(rows: readonly IdentityLeaseProcessTableEntry[]): readonly ProcessTableEntry[] { return rows; }

/** Bounded asynchronous helper; deadline kills only the child created here. */
export function boundedProcessOutput(command: string, args: readonly string[], options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const chunks: Buffer[] = []; let bytes = 0; let failure: string | undefined;
    const fail = (code: string) => {
      failure ??= code; child.kill(); child.stdout.destroy();
    };
    const abort = () => fail("process_table_cancelled");
    const timer = setTimeout(() => fail("process_table_timeout"), options.timeoutMs ?? 5000);
    options.signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes >= 4 * 1024 * 1024) fail("process_table_truncated"); else chunks.push(chunk);
    });
    child.on("error", () => { cleanup(); reject(new Error("process_table_failed")); });
    child.on("close", code => {
      cleanup(); if (failure || code !== 0) reject(new Error(failure ?? "process_table_failed"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    if (options.signal?.aborted) abort();
  });
}
