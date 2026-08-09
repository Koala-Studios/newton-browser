import fs from "node:fs";
import path from "node:path";

import { TASK_EXPECT_STATUSES, TASK_TOOLS, sanitizeFixturePath } from "./schema.mjs";
const S = new Set(TASK_EXPECT_STATUSES);
const T = new Set(TASK_TOOLS);
const E = new Set("runner_contract_invalid setup_failed teardown_failed target_required resolution_failed forbidden runner_error not_found ambiguous outcome_unknown prevented dialog_blocked discarded target_gone debugger_conflict renderer_unresponsive invalid_selector".split(" "));
const K = new Set(["observation", "observation_delta", "observation_text", "screenshot", "console_log", "network_log", "ack"]);
const ID_RE = /^[A-Za-z0-9._-]{1,120}$/;
const R = Object.freeze({taskCount: 256, stepCount: 256, matchCount: 128 * 1024, runId: 120, taskId: 120, fixture: 240});
const LOCAL_REPORT_LIMITS = Object.freeze({ machineBytes: 4 * 1024 * 1024, markdownBytes: 1024 * 1024 });

export function buildMachineReport(taskResults, options = {}) {
  const { tasks, passed } = normalizeTaskSet(taskResults);
  return { schema: "newton-browser-eval-report/v1", runId: normalizeIdentifier(options.runId, "run"), generatedAt: normalizeDate(options.generatedAt), summary: { taskCount: tasks.length, passed, failed: tasks.length - passed }, tasks };
}

export function serializeMachineReport(machineReport) {
  return JSON.stringify(stableSortObject(normalizeMachineReport(machineReport)));
}

export function renderMarkdownReport(machineReport) {
  const report = normalizeMachineReport(machineReport);
  const lines = ["# Newton Eval Report", `run: ${report.runId}`, `generated: ${report.generatedAt}`, `tasks: ${report.summary.taskCount}`, `passed: ${report.summary.passed}`, `failed: ${report.summary.failed}`, ""];
  for (const task of report.tasks) {
    lines.push(`## ${task.taskId}`, `- status: ${task.status}`, `- durationMs: ${task.durationMs}`, `- startedAt: ${task.startedAt}`, `- finishedAt: ${task.finishedAt}`, "", "| step | tool | expect | status | passed | forbidden | matchCount | result | error |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const step of task.steps) lines.push(`| ${step.index} | ${step.tool} | ${step.expect.status} | ${step.status} | ${step.passed ? "yes" : "no"} | ${step.forbidden.violated ? "yes" : "no"} | ${step.forbidden.matchCount} | ${step.result?.kind ?? ""} | ${step.error?.code ?? ""} |`);
    lines.push("");
  }
  return lines.join("\n");
}

export async function writeLocalEvalReports(machineReport, options = {}) {
  if (typeof options.outputRoot !== "string" || options.outputRoot.trim() === "") {
    throw new Error("eval report output root is required");
  }
  const outputRoot = await fs.promises.realpath(path.resolve(options.outputRoot));
  const baseName = normalizeIdentifier(options.baseName, "eval-report");
  const machine = `${serializeMachineReport(machineReport)}\n`;
  const markdown = `${renderMarkdownReport(machineReport)}\n`;
  assertReportBound(machine, LOCAL_REPORT_LIMITS.machineBytes, "machine report");
  assertReportBound(markdown, LOCAL_REPORT_LIMITS.markdownBytes, "markdown report");
  const machinePath = localReportPath(outputRoot, `${baseName}.json`);
  const markdownPath = localReportPath(outputRoot, `${baseName}.md`);
  await fs.promises.writeFile(machinePath, machine, { encoding: "utf8", flag: "wx" });
  await fs.promises.writeFile(markdownPath, markdown, { encoding: "utf8", flag: "wx" });
  return Object.freeze({
    machinePath,
    markdownPath,
    machineBytes: Buffer.byteLength(machine, "utf8"),
    markdownBytes: Buffer.byteLength(markdown, "utf8"),
  });
}

function localReportPath(outputRoot, filename) {
  const target = path.resolve(outputRoot, filename);
  if (path.dirname(target) !== outputRoot) throw new Error("eval report escaped output root");
  return target;
}

function assertReportBound(value, maxBytes, label) {
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`${label} exceeds local byte limit`);
}

function normalizeMachineReport(input) {
  if (!input || typeof input !== "object") return buildMachineReport([], {});
  const { tasks, passed } = normalizeTaskSet(input.tasks);
  return { schema: "newton-browser-eval-report/v1", runId: normalizeIdentifier(input.runId, "run"), generatedAt: normalizeDate(input.generatedAt), summary: { taskCount: tasks.length, passed, failed: Math.max(0, tasks.length - passed) }, tasks };
}

function normalizeTaskSet(values) {
  const tasks = (Array.isArray(values) ? values : []).slice(0, R.taskCount).map(normalizeTaskResult);
  return { tasks, passed: tasks.reduce((sum, e) => sum + (e.status === "passed" ? 1 : 0), 0) };
}

function normalizeTaskResult(raw) {
  const steps = normalizeStepSequence(Array.isArray(raw?.steps) ? raw.steps : []);
  const taskError = normalizeTaskError(raw?.error);
  const passed = steps.length > 0 && steps.every((e) => e.passed && !e.forbidden.violated);
  return {
    taskId: normalizeIdentifier(raw?.taskId, "task"), fixture: sanitizeFixturePath(raw?.fixture, "fixtures"), startedAt: normalizeDate(raw?.startedAt), finishedAt: normalizeDate(raw?.finishedAt), durationMs: normalizeDuration(raw?.durationMs), status: taskError ? "failed" : (passed ? "passed" : "failed"), steps, ...(taskError ? { error: taskError } : {}),
  };
}

function normalizeStepSequence(values) {
  const normalized = (Array.isArray(values) ? values : []).slice(0, R.stepCount);
  const steps = [];
  const used = new Set();
  for (let i = 0; i < normalized.length; i += 1) {
    let index = normalizeStepIndex(normalized[i]?.index, i);
    if (used.has(index)) { index = 0; while (used.has(index)) index += 1; }
    used.add(index);
    steps.push(normalizeStepResult(normalized[i], index));
  }
  return steps.sort((a, b) => a.index - b.index);
}

function normalizeStepResult(raw, index) {
  const expect = normalizeStepStatus(raw?.expect?.status);
  const validExpect = S.has(raw?.expect?.status);
  const status = normalizeStepStatus(raw?.status);
  const validStatus = S.has(raw?.status);
  const validTool = T.has(raw?.tool);
  const forbidden = normalizeForbidden(raw?.forbidden);
  const failedErrorCode = normalizeCodeRaw(raw?.error?.code);
  const hasUnexpectedError = raw?.error !== undefined && validExpect && validStatus && expect === status && status !== "failed" && status !== "runner_contract_invalid";
  const hasInvalidFailed = status === "failed" && expect === "failed" && failedErrorCode === undefined;
  const hasInvalidInput = !validExpect || !validStatus || !validTool || hasUnexpectedError || hasInvalidFailed;
  const passed = !forbidden.violated && expect === status && !hasInvalidInput;
  const error = hasInvalidInput
    ? "runner_contract_invalid"
    : status === "failed"
      ? failedErrorCode
      : status === "runner_contract_invalid"
        ? "runner_contract_invalid"
        : status === expect && raw?.error?.code ? normalizeCode(raw.error.code) : undefined;
  return {
    index, tool: validTool ? raw?.tool : TASK_TOOLS[0], expect: { status: expect }, status, passed, forbidden,
    ...(error ? { error: { code: error } } : {}),
    ...(raw?.result?.kind && K.has(raw.result.kind) ? { result: { kind: raw.result.kind } } : {}),
  };
}

function normalizeStepIndex(raw, fallback) {
  return Number.isInteger(raw) && raw >= 0 && raw <= 1_000_000 ? raw : fallback;
}

function normalizeStepStatus(v) { return S.has(v) ? v : "outcome_unknown"; }

function normalizeForbidden(raw) {
  const matchCount = Number.isFinite(raw?.matchCount) ? Math.max(0, Math.floor(raw.matchCount)) : 0;
  return { violated: Boolean(raw?.violated), matchCount: Math.min(matchCount, R.matchCount) };
}

function normalizeTaskError(raw) {
  if (raw === undefined || raw === null || typeof raw !== "object") return;
  const code = normalizeCode(raw.code);
  const teardown = raw.cleanup?.teardown?.code;
  return teardown ? { code, cleanup: { teardown: { code: normalizeCode(teardown) } } } : { code };
}

function normalizeCode(raw, fallback = "runner_contract_invalid") {
  const value = typeof raw === "string" ? raw.trim() : "";
  return E.has(value) ? value : fallback;
}
function normalizeCodeRaw(raw) {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return E.has(value) ? value : undefined;
}

function normalizeIdentifier(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  const value = raw.trim();
  return value.length > 0 && value.length <= R.taskId && ID_RE.test(value) ? value : fallback;
}

function normalizeDate(raw) {
  try {
    const parsed = new Date(raw ?? Date.now());
    return Number.isNaN(parsed.valueOf()) ? new Date(0).toISOString() : parsed.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function normalizeDuration(raw) {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

function stableSortObject(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stableSortObject);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stableSortObject(value[key]);
  return out;
}
