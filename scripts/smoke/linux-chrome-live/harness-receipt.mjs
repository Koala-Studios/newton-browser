import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "start": start(...args); break;
  case "log": logReceipt(...args); break;
  case "final": finalReceipt(...args); break;
  default: throw new Error("unknown receipt command");
}

function start(directory, runId) {
  assertRunDirectory(directory, runId);
  writeExclusive(path.join(directory, "run-state.json"), { runId, status: "in_progress", stage: "source_preflight" });
}

function logReceipt(input, output, label, exitCodeValue) {
  const exitCode = boundedInteger(exitCodeValue);
  const stats = fs.statSync(input);
  if (!stats.isFile()) throw new Error("diagnostic input must be a regular file");
  const maxTailBytes = 64 * 1024;
  const handle = fs.openSync(input, "r");
  const tailBytes = Math.min(stats.size, maxTailBytes);
  const tail = Buffer.alloc(tailBytes);
  try { fs.readSync(handle, tail, 0, tailBytes, stats.size - tailBytes); } finally { fs.closeSync(handle); }
  const lines = tail.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-80);
  const diagnosticTail = lines.map((line) => ({
    category: categorize(line),
    bytes: Buffer.byteLength(line),
    sha256: crypto.createHash("sha256").update(line).digest("hex"),
  }));
  const steps = [];
  for (const line of lines) {
    if (steps.length >= 80) break;
    try {
      const value = JSON.parse(line);
      if (value && typeof value.step === "string" && /^[a-z0-9_]{1,80}$/.test(value.step)) {
        steps.push(value.step);
      }
    } catch {}
  }
  writeAtomic(output, {
    label: boundedLabel(label),
    exitCode,
    bytes: stats.size,
    truncated: stats.size > maxTailBytes || lines.length >= 80,
    steps,
    diagnosticTail,
  });
}

function finalReceipt(directory, runId, stage, processExitValue, directSelectionValue, agentValue, liveValue) {
  assertRunDirectory(directory, runId);
  const processExit = boundedInteger(processExitValue);
  const receipt = {
    runId,
    status: processExit === 0 ? "pass" : "fail",
    stage: boundedLabel(stage),
    architecture: "owned_process_private_cdp",
    processExit,
    directRuntimeSelectionStatus: nullableStatus(directSelectionValue),
    agentCostStatus: nullableStatus(agentValue),
    liveStatus: nullableStatus(liveValue),
    gateStatus: processExit,
  };
  writeAtomic(path.join(directory, "gate-status.json"), receipt);
  writeAtomic(path.join(directory, "run-state.json"), receipt);
}

function categorize(line) {
  if (/ELIFECYCLE|Command failed/i.test(line)) return "lifecycle_failure";
  if (/Error|failed|failure/i.test(line)) return "error";
  if (/pass|ready|completed/i.test(line)) return "state";
  return "output";
}

function assertRunDirectory(directory, runId) {
  if (!/^[a-z0-9_-]{12,80}$/.test(runId)) throw new Error("invalid run id");
  const resolved = path.resolve(directory);
  if (path.basename(resolved) !== runId || !fs.statSync(resolved).isDirectory()) throw new Error("invalid run directory");
}

function boundedLabel(value) {
  const label = String(value ?? "").slice(0, 80);
  if (!/^[a-z0-9_.-]+$/i.test(label)) throw new Error("invalid receipt label");
  return label;
}

function boundedInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 255) throw new Error("invalid exit code");
  return number;
}

function nullableStatus(value) {
  return value === "null" ? null : boundedInteger(value);
}

function writeExclusive(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function writeAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, file);
}
