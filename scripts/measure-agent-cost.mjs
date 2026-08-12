import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { getEncoding } from "js-tiktoken";

import {
  projectCompactObservation,
  projectLeanObservation,
  normalizeAgentActionResult,
} from "../apps/mcp-server/src/agent-output.ts";
import { toolList } from "../apps/mcp-server/src/mcp-server.ts";
import { MCP_SERVER_INSTRUCTIONS } from "../apps/mcp-server/src/mcp-contract.ts";
import { estimateTokensFromString, serializeForBudget, extractCounterMeta } from "./evals/token-budget.mjs";

const PROJECT_ROOT = process.cwd();
const DEFAULT_FIXTURE_ROOT = path.join(PROJECT_ROOT, "test", "evals", "agent-output-fixtures");

const OBSERVATION_FORMATS = new Set(["compact", "json"]);
const ALLOWED_CASE_FIELDS = {
  observation: new Set(["id", "caseType", "format", "limit", "maxTokens", "input", "inputRef"]),
  action: new Set(["id", "caseType", "maxTokens", "input"]),
  workflow: new Set(["id", "caseType", "maxTokens", "steps", "reason"]),
  deferred: new Set(["id", "caseType", "reason", "maxTokens"]),
  catalog: new Set(["id", "caseType", "maxTokens"]),
  invalid: new Set(["id", "caseType", "reason"]),
};
const ALLOWED_WORKFLOW_STEP_FIELDS = new Set(["id", "type", "maxTokens", "input", "inputRef", "options", "reason"]);
const ALLOWED_WORKFLOW_OBSERVATION_OPTION_FIELDS = new Set(["format", "query", "roles", "limit", "includeGeometry", "includeInteractive"]);
const OBSERVATION_FORMAT_DEFAULT = "compact";

function isObjectRecord(raw) {
  return Boolean(raw && typeof raw === "object" && !Array.isArray(raw));
}

function safeString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function assertNoUnknownKeys(raw, allowed, label) {
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unsupported field(s): ${unknown.join(",")}`);
  }
}

function parseMaxTokens(raw, label, optional = false) {
  if (raw === undefined) {
    if (optional) return 0;
    throw new Error(`${label}.maxTokens missing`);
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label}.maxTokens must be a non-negative integer`);
  }
  return value;
}

function parseLimit(raw, label, optional = false) {
  if (raw === undefined) return optional ? undefined : undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label}.limit must be a non-negative integer`);
  }
  return value;
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!isObjectRecord(parsed)) throw new Error(`${path.basename(filePath)} must be a JSON object`);
  return parsed;
}

function readFixtureInput(value, root) {
  if (isObjectRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("observation input must be object or inputRef");
  }
  const refPath = path.isAbsolute(value) ? value : path.join(root, value);
  return readJsonFile(refPath);
}

function parseObservationCase(raw, filePath) {
  assertNoUnknownKeys(raw, ALLOWED_CASE_FIELDS.observation, `${filePath}: observation`);
  const format = safeString(raw.format, OBSERVATION_FORMAT_DEFAULT);
  if (!OBSERVATION_FORMATS.has(format)) throw new Error(`${filePath}: observation format must be compact|json`);
  if (raw.input !== undefined && raw.inputRef !== undefined) throw new Error(`${filePath}: observation cannot include both input and inputRef`);
  if (raw.input === undefined && raw.inputRef === undefined) throw new Error(`${filePath}: observation missing input/inputRef`);

  return {
    id: safeString(raw.id, path.basename(filePath)),
    caseType: "observation",
    format,
    limit: parseLimit(raw.limit, `${filePath}: observation`),
    maxTokens: parseMaxTokens(raw.maxTokens, `${filePath}: observation`),
    input: readFixtureInput(raw.inputRef ?? raw.input, path.dirname(filePath)),
  };
}

function parseActionCase(raw, filePath) {
  assertNoUnknownKeys(raw, ALLOWED_CASE_FIELDS.action, `${filePath}: action`);
  if (!isObjectRecord(raw.input)) throw new Error(`${filePath}: action input required`);
  return {
    id: safeString(raw.id, path.basename(filePath)),
    caseType: "action",
    maxTokens: parseMaxTokens(raw.maxTokens, `${filePath}: action`),
    input: raw.input,
  };
}

function parseWorkflowStep(raw, filePath) {
  if (!isObjectRecord(raw)) throw new Error(`${filePath}: workflow step must be object`);
  assertNoUnknownKeys(raw, ALLOWED_WORKFLOW_STEP_FIELDS, `${filePath}: workflow step`);

  const type = safeString(raw.type);
  if (!type) throw new Error(`${filePath}: workflow step missing type`);
  if (type !== "action" && type !== "observation") {
    throw new Error(`${filePath}: unsupported workflow step type ${type}`);
  }

  if (type === "observation") {
    if (raw.inputRef !== undefined && raw.input !== undefined) {
      throw new Error(`${filePath}: workflow observation step cannot include both input and inputRef`);
    }
    if (raw.inputRef === undefined && !isObjectRecord(raw.input)) {
      throw new Error(`${filePath}: workflow observation step needs input or inputRef`);
    }

    const parsed = {
      id: safeString(raw.id, `step@${filePath}`),
      type,
      maxTokens: parseMaxTokens(raw.maxTokens, `${filePath}: workflow step`, true),
      input: raw.inputRef !== undefined ? readFixtureInput(raw.inputRef, path.dirname(filePath)) : raw.input,
    };

    if (raw.options !== undefined) {
      if (!isObjectRecord(raw.options)) throw new Error(`${filePath}: workflow observation step options must be object`);
      assertNoUnknownKeys(raw.options, ALLOWED_WORKFLOW_OBSERVATION_OPTION_FIELDS, `${filePath}: workflow observation step options`);
      if (raw.options.format !== undefined && !OBSERVATION_FORMATS.has(safeString(raw.options.format))) {
        throw new Error(`${filePath}: workflow observation step options.format must be compact|json`);
      }
      parsed.options = raw.options;
    }

    return parsed;
  }

  if (!isObjectRecord(raw.input)) throw new Error(`${filePath}: workflow action step input required`);

  return {
    id: safeString(raw.id, `step@${filePath}`),
    type,
    maxTokens: parseMaxTokens(raw.maxTokens, `${filePath}: workflow step`, true),
    input: raw.input,
  };
}

function parseWorkflowCase(raw, filePath) {
  assertNoUnknownKeys(raw, ALLOWED_CASE_FIELDS.workflow, `${filePath}: workflow`);
  if (!Array.isArray(raw.steps)) throw new Error(`${filePath}: workflow steps must be array`);
  return {
    id: safeString(raw.id, path.basename(filePath)),
    caseType: "workflow",
    reason: safeString(raw.reason),
    maxTokens: parseMaxTokens(raw.maxTokens, `${filePath}: workflow`),
    steps: raw.steps.map((step) => parseWorkflowStep(step, filePath)),
  };
}

function parseDeferredCase(raw, filePath) {
  assertNoUnknownKeys(raw, ALLOWED_CASE_FIELDS.deferred, `${filePath}: deferred`);
  return {
    id: safeString(raw.id, path.basename(filePath)),
    caseType: "deferred",
    reason: safeString(raw.reason, "deferred"),
    maxTokens: parseMaxTokens(raw.maxTokens, `${filePath}: deferred`, true),
  };
}

export function parseFixtureCase(raw, filePath = "fixture.json") {
  if (!isObjectRecord(raw)) throw new Error(`${filePath}: fixture must be object`);
  const caseType = safeString(raw.caseType);
  if (!caseType) throw new Error(`${filePath}: missing caseType`);

  if (caseType === "observation") return parseObservationCase(raw, filePath);
  if (caseType === "action") return parseActionCase(raw, filePath);
  if (caseType === "workflow") return parseWorkflowCase(raw, filePath);
  if (caseType === "deferred") return parseDeferredCase(raw, filePath);
  if (caseType === "catalog") {
    assertNoUnknownKeys(raw, ALLOWED_CASE_FIELDS.catalog, `${filePath}: catalog`);
    return { id: safeString(raw.id, path.basename(filePath)), caseType, maxTokens: parseMaxTokens(raw.maxTokens, `${filePath}: catalog`) };
  }
  throw new Error(`${filePath}: unsupported caseType ${caseType}`);
}

function readFixtureFile(filePath) {
  try {
    return parseFixtureCase(readJsonFile(filePath), filePath);
  } catch (error) {
    return { id: path.basename(filePath), caseType: "invalid", reason: String(error.message || error) };
  }
}

export function listFixtureFiles(root = DEFAULT_FIXTURE_ROOT) {
  return fs.readdirSync(root)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(root, name));
}

export function readFixtures(root = DEFAULT_FIXTURE_ROOT) {
  return listFixtureFiles(root).map((filePath) => readFixtureFile(filePath));
}

function serializeObservationProjection(projection, format) {
  const metadata = { outcome: "completed", retrySafe: false, sequence: 1 };
  const provenance = { trust: "untrusted_page_content", origin: projection.origin, capturedAt: projection.capturedAt };
  if (format === "compact") {
    return serializeForBudget({
      ok: true,
      output: String(projection.output ?? ""),
      ...(projection.budget?.truncated ? { budget: projection.budget } : {}),
      provenance,
      ...metadata,
    });
  }
  return serializeForBudget({ ok: true, result: projection, provenance, ...metadata });
}

export function measureObservationCase(entry, tokenCounter) {
  const format = entry.format || OBSERVATION_FORMAT_DEFAULT;
  const projector = format === "json" ? projectLeanObservation : projectCompactObservation;
  const projection = projector(entry.input, {
    format,
    ...(entry.limit !== undefined ? { limit: entry.limit } : {}),
  });
  if (!projection.ok) {
    return {
      id: entry.id,
      type: "observation",
      status: "fail",
      reason: projection.errorCode,
      measured: { count: 0, method: "invalid-observation", origin: "validation" },
      tokens: 0,
    };
  }

  const serialized = serializeObservationProjection(projection.projection, format);
  const measured = estimateTokensFromString(serialized, tokenCounter);
  const exact = measured.method === "token_counter";
  const pass = exact ? measured.count <= entry.maxTokens : undefined;
  return {
    id: entry.id,
    type: "observation",
    status: exact ? (pass ? "pass" : "fail") : "deferred",
    format,
    ...(exact ? { pass } : {}),
    measured,
    maxTokens: entry.maxTokens,
    ...(exact ? { tokens: measured.count } : { bytes: measured.count }),
  };
}

export function measureActionCase(entry, tokenCounter) {
  const projection = normalizeAgentActionResult(entry.input);
  if (projection.errorCode === "runner_contract_invalid") {
    return {
      id: entry.id,
      type: "action",
      status: "fail",
      pass: false,
      reason: projection.errorCode,
      maxTokens: entry.maxTokens,
    };
  }
  const measured = estimateTokensFromString(serializeForBudget({ ...projection, sequence: 1 }), tokenCounter);
  const exact = measured.method === "token_counter";
  const pass = exact ? measured.count <= entry.maxTokens : undefined;
  return {
    id: entry.id,
    type: "action",
    status: exact ? (pass ? "pass" : "fail") : "deferred",
    ...(exact ? { pass } : {}),
    measured,
    maxTokens: entry.maxTokens,
    ...(exact ? { tokens: measured.count } : { bytes: measured.count }),
    ...(projection.errorCode ? { errorCode: projection.errorCode } : {}),
  };
}

function measureWorkflowObservationStep(step, tokenCounter) {
  const format = safeString(step.options?.format, OBSERVATION_FORMAT_DEFAULT);
  const projector = format === "json" ? projectLeanObservation : projectCompactObservation;
  const options = {
    format,
    ...(step.options?.limit !== undefined ? { limit: parseLimit(step.options.limit) } : {}),
    ...(step.options?.query !== undefined ? { query: step.options.query } : {}),
    ...(step.options?.roles !== undefined ? { roles: step.options.roles } : {}),
    ...(step.options?.includeGeometry === true ? { includeGeometry: true } : {}),
    ...(step.options?.includeInteractive === true ? { includeInteractive: true } : {}),
  };

  const projection = projector(step.input, options);
  if (!projection.ok) {
    return {
      id: step.id,
      type: "observation",
      status: "fail",
      reason: projection.errorCode,
      pass: false,
      tokens: 0,
      maxTokens: step.maxTokens,
    };
  }

  const serialized = serializeObservationProjection(projection.projection, format);
  const measured = estimateTokensFromString(serialized, tokenCounter);
  const exact = measured.method === "token_counter";
  const pass = exact ? measured.count <= (step.maxTokens ?? 0) : undefined;
  return {
    id: step.id,
    type: "observation",
    status: exact ? (pass ? "pass" : "fail") : "deferred",
    ...(exact ? { pass } : {}),
    measured,
    maxTokens: step.maxTokens,
    ...(exact ? { tokens: measured.count } : { bytes: measured.count }),
  };
}

function measureWorkflowActionStep(step, tokenCounter) {
  return measureActionCase({ ...step, maxTokens: step.maxTokens ?? Number.MAX_SAFE_INTEGER }, tokenCounter);
}

export function measureWorkflowCase(entry, tokenCounter) {
  const details = [];
  let tokens = 0;
  let bytes = 0;
  for (const step of entry.steps) {
    const measured = step.type === "observation"
      ? measureWorkflowObservationStep(step, tokenCounter)
      : measureWorkflowActionStep(step, tokenCounter);
    details.push(measured);
    tokens += measured.tokens || 0;
    bytes += measured.bytes || 0;
  }

  const hasFailure = details.some((detail) => detail.status === "fail");
  const deferred = details.some((detail) => detail.status === "deferred");
  const pass = !hasFailure && !deferred && tokens <= entry.maxTokens;
  const status = hasFailure ? "fail" : deferred ? "deferred" : pass ? "pass" : "fail";
  return {
    id: entry.id,
    type: "workflow",
    status,
    ...(status !== "deferred" ? { pass } : {}),
    ...(deferred ? { bytes } : { tokens }),
    maxTokens: entry.maxTokens,
    measured: { count: deferred ? bytes : tokens, method: "sum", origin: deferred ? "heuristic" : "aggregated" },
    details,
  };
}

export function measureDeferredCase(entry) {
  return {
    id: entry.id,
    type: "deferred",
    status: "deferred",
    reason: entry.reason || "deferred",
    maxTokens: entry.maxTokens,
    metrics: { gate: "deferred", pass: false },
  };
}

export function measureCase(entry, tokenCounter) {
  if (entry.caseType === "observation") return measureObservationCase(entry, tokenCounter);
  if (entry.caseType === "action") return measureActionCase(entry, tokenCounter);
  if (entry.caseType === "workflow") return measureWorkflowCase(entry, tokenCounter);
  if (entry.caseType === "deferred") return measureDeferredCase(entry);
  if (entry.caseType === "catalog") {
    const measured = estimateTokensFromString(serializeForBudget({ instructions: MCP_SERVER_INSTRUCTIONS, tools: toolList() }), tokenCounter);
    const exact = measured.method === "token_counter";
    const pass = exact ? measured.count <= entry.maxTokens : undefined;
    return {
      id: entry.id,
      type: "catalog",
      status: exact ? (pass ? "pass" : "fail") : "deferred",
      ...(exact ? { pass, tokens: measured.count } : { bytes: measured.count }),
      measured,
      maxTokens: entry.maxTokens,
    };
  }
  return { id: entry.id ?? "unknown", type: "invalid", status: "fail", reason: entry.reason || "unsupported caseType", pass: false };
}

function normalizeCounterMetadata(tokenCounter) {
  if (typeof tokenCounter !== "function") throw new Error("token_counter_required");
  return { origin: "injected", name: tokenCounter.name || "custom", ...extractCounterMeta(tokenCounter) };
}

export function buildReport(entries, tokenCounter) {
  const results = entries.map((entry) => measureCase(entry, tokenCounter));
  const failures = results.filter((result) => result.status === "fail");
  const deferred = results.filter((result) => result.status === "deferred");
  return {
    counter: normalizeCounterMetadata(tokenCounter),
    status: failures.length > 0 ? "fail" : deferred.length > 0 ? "deferred" : "pass",
    passed: failures.length === 0 && deferred.length === 0,
    failing: failures.length,
    deferred: deferred.length,
    results,
  };
}

export function createPinnedTokenCounter() {
  const encoding = getEncoding("o200k_base");
  const counter = (value) => encoding.encode(typeof value === "string" ? value : "").length;
  counter.algorithm = "o200k_base";
  counter.version = "js-tiktoken@1.0.21";
  counter.provenance = "workspace-dev-dependency";
  counter.origin = "local";
  return counter;
}

export async function runMeasurement(opts = {}) {
  const fixtureRoot = safeString(opts.fixtureRoot, DEFAULT_FIXTURE_ROOT);
  const tokenCounter = opts.tokenCounter ?? createPinnedTokenCounter();
  const fixtures = readFixtures(fixtureRoot);
  return buildReport(fixtures, tokenCounter);
}

export async function runMeasurementCli() {
  const fixtureRoot = safeString(process.env.AGENT_OUTPUT_FIXTURE_ROOT, DEFAULT_FIXTURE_ROOT);
  return buildReport(readFixtures(fixtureRoot), createPinnedTokenCounter());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const report = await runMeasurementCli();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}
