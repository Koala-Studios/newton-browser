import {
  redactBrowserOrigin,
  redactBrowserResult,
  redactJson,
  redactText,
  BROWSER_ACTION_RESULT_STATUSES,
  BROWSER_COMMIT_BOUNDARIES,
  BROWSER_RISK_CLASSES,
  type BrowserActionResultStatus,
  type BrowserCommitBoundary,
  type BrowserRiskClass,
  type NewtonBrowserResult,
  type PageProvenance,
} from "@newton-browser/core";

type ObservationOutputFormat = "compact" | "json";
export type AgentObservationOptionsInput = { format?: unknown; includeGeometry?: unknown; includeInteractive?: unknown; query?: unknown; roles?: unknown; limit?: unknown };
type ObservationOptions = { format: ObservationOutputFormat; includeGeometry: boolean; includeInteractive: boolean; query: string; roles: string[]; limit: number };
type ProjectedNode = {
  ref: string; role: string; name?: string; value?: string; disabled?: boolean;
  checked?: boolean | "mixed"; selected?: boolean; expanded?: boolean; required?: boolean; level?: number;
  href?: string; elementType?: string; frameOrigin?: string;
  geometry?: { x: number; y: number; width: number; height: number };
};

const OBSERVATION_QUERY_LIMIT = 120;
const OBSERVATION_ROLE_LIMIT = 12;
const OBSERVATION_LIMIT_MAX = 200;
const OBSERVATION_LIMIT_DEFAULT = 80;
const OBSERVATION_SOURCE_NODE_CAP = 1_000;
const OBSERVATION_PROJECTION_NODE_CAP = 500;
const OBS_NODE_REF_CAP = 80;
const OBS_NODE_ROLE_CAP = 80;
const OBS_NODE_NAME_CAP = 180;
const OBS_NODE_TEXT_CAP = 220;
const OBS_NODE_VALUE_CAP = 400;
const OBS_REASON_CAP = 260;
const OBS_CHANGED_KEY_CAP = 80;
const OBS_CHANGED_VALUE_CAP = 120;
const OBS_TEXT_CAP = 2_000;

const ACTION_REASON_CAP = 240;
const ACTION_DELTA_CAP = 10;
const ACTION_DELTA_ITEM_CAP = 180;
const ACTION_ERROR_CODE_CAP = 80;
const ACTION_ORIGIN_CAP = 140;
const ACTION_STATUS_CAP = 80;

const AGENT_ACTION_OUTCOMES = ["completed", "prevented", "not_started", "outcome_unknown"] as const;
type AgentActionOutcome = (typeof AGENT_ACTION_OUTCOMES)[number];
const AGENT_ACTION_OUTCOME_SET = new Set<AgentActionOutcome>(AGENT_ACTION_OUTCOMES);

type AgentActionDecision = { class: BrowserRiskClass; commitBoundary: BrowserCommitBoundary; reason?: string };
type AgentActionProvenance = Pick<PageProvenance, "trust" | "origin">;
type ObservationProjectionBase = {
  trust: "untrusted_page_content";
  origin: string;
  mode: string;
  nodeCount: number;
  capturedAt: string;
  reason?: string;
  changed?: Record<string, unknown>;
  title?: string;
};
type ObservationBudget = { nodesScanned: number; nodesReturned: number; nodesOmitted: number; truncated: boolean; continuation?: ObservationBudgetContinuation };
type ObservationBudgetContinuation = {
  tool: "browser.observe";
  strategy: "raise_limit" | "refine_query_or_roles";
  reason: "node_limit" | "source_truncated";
  arguments: { format: ObservationOutputFormat; query?: string; roles?: string[]; limit?: number; includeGeometry?: true; includeInteractive?: true };
};
type ObservationProjectionResult =
  | { ok: true; projection: ObservationProjectionBase & { kind: "observation" | "observation_delta" | "observation_text"; format: ObservationOutputFormat; nodes: ProjectedNode[]; text?: string; output?: string; budget: ObservationBudget } }
  | { ok: false; errorCode: "invalid_observation" | "unsupported_observation_kind"; reason: string };
type AgentActionStatus = BrowserActionResultStatus;
type AgentActionResultProjection = {
  ok: boolean;
  status: AgentActionStatus;
  outcome: AgentActionOutcome;
  retrySafe: boolean;
  reason?: string;
  decision: AgentActionDecision;
  delta?: string[];
  changed?: boolean;
  provenance?: AgentActionProvenance;
  errorCode?: string;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asSafeString(raw: unknown, cap: number): string {
  return typeof raw === "string" ? redactText(raw).slice(0, cap) : "";
}

function asSafeBoundedText(raw: unknown, cap: number): string {
  return asSafeString(raw, cap).replace(/[\u0000-\u001f\u007f]/g, " ");
}

function asSafePositiveInt(raw: unknown, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  return Math.max(1, Math.min(max, value));
}

function asSafeNonNegativeInt(raw: unknown, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  return Math.max(0, Math.min(max, value));
}

function asSafeQuery(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, OBSERVATION_QUERY_LIMIT).replace(/[\u0000-\u001f\u007f]/g, " ").toLowerCase();
}

function asSafeRole(raw: unknown): string {
  return asSafeBoundedText(raw, OBS_NODE_ROLE_CAP).trim().toLowerCase();
}

function asBoolean(raw: unknown): boolean | undefined {
  return raw === true ? true : raw === false ? false : undefined;
}

function normalizeGeometry(value: unknown): { x: number; y: number; width: number; height: number } | undefined {
  if (!isObjectRecord(value)) return undefined;
  const x = Number.isFinite(Number(value.x)) ? Math.trunc(Number(value.x)) : undefined;
  const y = Number.isFinite(Number(value.y)) ? Math.trunc(Number(value.y)) : undefined;
  const width = Number.isFinite(Number(value.width)) ? Math.trunc(Number(value.width)) : undefined;
  const height = Number.isFinite(Number(value.height)) ? Math.trunc(Number(value.height)) : undefined;
  return x === undefined || y === undefined || width === undefined || height === undefined
    ? undefined
    : { x, y, width, height };
}

export function normalizeObservationOptions(input: AgentObservationOptionsInput): ObservationOptions {
  const rolesInput = input.roles == null ? [] : Array.isArray(input.roles) ? input.roles : [input.roles];
  const roles = rolesInput
    .map(asSafeRole)
    .filter((role): role is string => role.length > 0)
    .filter((role, index, list) => list.indexOf(role) === index)
    .slice(0, OBSERVATION_ROLE_LIMIT);

  return {
    format: input.format === "json" ? "json" : "compact",
    includeGeometry: input.includeGeometry === true,
    includeInteractive: input.includeInteractive === true,
    query: asSafeQuery(input.query),
    roles,
    limit: asSafePositiveInt(input.limit, OBSERVATION_LIMIT_DEFAULT, OBSERVATION_LIMIT_MAX),
  };
}

function toIso(value: unknown): string {
  if (typeof value !== "string") return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function normalizeChanged(value: unknown): Record<string, unknown> | undefined {
  if (!isObjectRecord(value)) return undefined;
  const redacted = redactJson(value);
  if (!isObjectRecord(redacted)) return undefined;
  const output: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(redacted).slice(0, 12)) {
    const safeKey = asSafeString(key, OBS_CHANGED_KEY_CAP);
    if (!safeKey) continue;
    if (typeof entry === "string") {
      output[safeKey] = asSafeString(entry, OBS_CHANGED_VALUE_CAP);
      continue;
    }
    if (entry === null || typeof entry === "number" || typeof entry === "boolean") {
      output[safeKey] = entry;
    }
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

function normalizeObservationBase(result: Record<string, unknown>): ObservationProjectionBase {
  const reason = asSafeBoundedText(result.reason, OBS_REASON_CAP);
  const changed = normalizeChanged(result.changed);
  return {
    trust: "untrusted_page_content",
    origin: asSafeBoundedText(redactBrowserOrigin(result.origin), OBS_NODE_TEXT_CAP) || "about:blank",
    mode: asSafeBoundedText(result.mode, 16) || "cdp",
    nodeCount: asSafeNonNegativeInt(result.nodeCount, 0, OBSERVATION_SOURCE_NODE_CAP),
    capturedAt: toIso(result.capturedAt),
    ...(reason ? { reason } : {}),
    ...(changed ? { changed } : {}),
    ...(typeof result.title === "string" ? { title: asSafeBoundedText(result.title, OBS_NODE_TEXT_CAP) } : {}),
  };
}

function isSupportedObservationKind(kind: string): kind is NewtonBrowserResult["kind"] {
  return kind === "observation" || kind === "observation_delta" || kind === "observation_text";
}

function normalizeObservationNode(raw: unknown, includeGeometry: boolean): ProjectedNode | undefined {
  if (!isObjectRecord(raw)) return undefined;
  const ref = asSafeString(raw.ref, OBS_NODE_REF_CAP);
  if (!ref) return undefined;

  const disabled = asBoolean(raw.disabled);
  const selected = asBoolean(raw.selected);
  const expanded = asBoolean(raw.expanded);
  const required = asBoolean(raw.required);
  const node: ProjectedNode = {
    ref,
    role: asSafeString(raw.role, OBS_NODE_ROLE_CAP) || "generic",
    ...(asSafeString(raw.name, OBS_NODE_NAME_CAP) ? { name: asSafeString(raw.name, OBS_NODE_NAME_CAP) } : {}),
    ...(asSafeString(raw.value, OBS_NODE_VALUE_CAP) ? { value: asSafeString(raw.value, OBS_NODE_VALUE_CAP) } : {}),
    ...(disabled !== undefined ? { disabled } : {}),
    ...(typeof raw.checked === "boolean" || raw.checked === "mixed" ? { checked: raw.checked } : {}),
    ...(selected !== undefined ? { selected } : {}),
    ...(expanded !== undefined ? { expanded } : {}),
    ...(required !== undefined ? { required } : {}),
    ...(Number.isSafeInteger(raw.level) && Number(raw.level) > 0 && Number(raw.level) <= 9 ? { level: Number(raw.level) } : {}),
    ...(asSafeString(raw.href, OBS_NODE_TEXT_CAP) ? { href: asSafeString(raw.href, OBS_NODE_TEXT_CAP) } : {}),
    ...(asSafeString(raw.elementType, OBS_NODE_ROLE_CAP) ? { elementType: asSafeString(raw.elementType, OBS_NODE_ROLE_CAP) } : {}),
    ...(asSafeString(raw.frameOrigin, OBS_NODE_TEXT_CAP) ? { frameOrigin: asSafeString(raw.frameOrigin, OBS_NODE_TEXT_CAP) } : {}),
  };

  if (includeGeometry) {
    const geometry = normalizeGeometry(raw.bbox);
    if (geometry) node.geometry = geometry;
  }

  return node;
}

function normalizeUpdatedNode(raw: unknown): ProjectedNode | undefined {
  return normalizeObservationNode(raw, false);
}

function retainSameOriginHref(node: ProjectedNode, origin: string): ProjectedNode {
  if (!node.href) return node;
  try {
    const destination = new URL(node.href);
    if (destination.origin === origin) return node;
  } catch {}
  const { href: _href, ...withoutHref } = node;
  return withoutHref;
}

function retainCrossOriginFrame(node: ProjectedNode, origin: string): ProjectedNode {
  if (!node.frameOrigin || node.frameOrigin !== origin) return node;
  const { frameOrigin: _frameOrigin, ...withoutFrameOrigin } = node;
  return withoutFrameOrigin;
}

function nodeSignature(node: ProjectedNode): string {
  return JSON.stringify([
    node.ref,
    node.role,
    node.name ?? "",
    node.value ?? "",
    node.disabled,
    node.checked,
    node.selected,
    node.expanded,
    node.required,
    node.level,
    node.href ?? "",
    node.elementType ?? "",
    node.frameOrigin ?? "",
    node.geometry ?? null,
  ]);
}

function dedupeNodes(nodes: ProjectedNode[]): ProjectedNode[] {
  const seen = new Set<string>();
  const output: ProjectedNode[] = [];

  for (const node of nodes) {
    const signature = nodeSignature(node);
    if (seen.has(signature)) continue;
    seen.add(signature);
    output.push(node);
  }

  return output;
}

function matchesRoles(node: ProjectedNode, roles: string[]): boolean {
  if (roles.length === 0) return true;
  const nodeRole = node.role.toLowerCase();
  return roles.includes(nodeRole);
}

function matchesQuery(node: ProjectedNode, query: string): boolean {
  if (!query) return true;
  const haystack = [
    node.ref,
    node.role,
    node.name,
    node.value,
    node.href,
    node.elementType,
    node.frameOrigin,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(" ")
    .toLowerCase();

  return haystack.includes(query);
}

export function enforceObservationBudget<T>(
  nodes: readonly T[],
  options: Pick<ObservationOptions, "limit" | "roles" | "query" | "includeGeometry" | "includeInteractive" | "format">,
  sourceNodeCount: number,
  sourceTruncated: boolean,
): { nodes: T[]; budget: ObservationBudget } {
  const limit = asSafePositiveInt(options.limit, OBSERVATION_LIMIT_DEFAULT, OBSERVATION_LIMIT_MAX);
  const sourceCount = asSafeNonNegativeInt(sourceNodeCount, 0, OBSERVATION_SOURCE_NODE_CAP);
  const nodesScanned = Math.max(0, Math.min(Math.max(sourceCount, nodes.length), OBSERVATION_SOURCE_NODE_CAP));
  const nodesReturned = Math.min(nodes.length, limit);
  const nodesOmitted = Math.max(0, nodesScanned - nodesReturned);
  const truncated = Boolean(sourceTruncated) || sourceCount > limit || nodesReturned < nodes.length;
  const canRaiseLimit = !sourceTruncated && nodesScanned > limit && limit < OBSERVATION_LIMIT_MAX;
  const isNodeLimited = sourceCount > limit;
  const continuation: ObservationBudgetContinuation | undefined = truncated
    ? {
        tool: "browser.observe" as const,
        strategy: sourceTruncated ? "refine_query_or_roles" : "raise_limit",
        reason: sourceTruncated ? "source_truncated" : "node_limit",
        arguments: {
          format: options.format,
          ...(options.query ? { query: options.query } : {}),
          ...(options.roles.length > 0 ? { roles: [...options.roles] } : {}),
          ...(options.includeGeometry ? { includeGeometry: true } : {}),
          ...(options.includeInteractive ? { includeInteractive: true } : {}),
          ...(canRaiseLimit ? { limit: Math.min(OBSERVATION_LIMIT_MAX, limit * 2) } : {}),
          ...(isNodeLimited && !canRaiseLimit ? { limit } : {}),
        },
      }
    : undefined;

  return {
    nodes: [...nodes].slice(0, nodesReturned),
    budget: {
      nodesScanned,
      nodesReturned,
      nodesOmitted,
      truncated,
      ...(continuation ? { continuation } : {}),
    },
  };
}

function renderCompactLine(node: ProjectedNode, includeGeometry: boolean, pageOrigin: string): string {
  const fields = [
    `ref=${JSON.stringify(node.ref)}`,
    ...(node.name ? [`name=${JSON.stringify(node.name)}`] : []),
    ...(node.value ? [`value=${JSON.stringify(node.value)}`] : []),
    ...(node.disabled !== undefined ? [`disabled=${JSON.stringify(node.disabled)}`] : []),
    ...(node.checked !== undefined ? [`checked=${JSON.stringify(node.checked)}`] : []),
    ...(node.selected !== undefined ? [`selected=${JSON.stringify(node.selected)}`] : []),
    ...(node.expanded !== undefined ? [`expanded=${JSON.stringify(node.expanded)}`] : []),
    ...(node.required !== undefined ? [`required=${JSON.stringify(node.required)}`] : []),
    ...(node.level !== undefined ? [`level=${node.level}`] : []),
    ...(node.href ? [`href=${JSON.stringify(node.href)}`] : []),
    ...(node.elementType ? [`type=${JSON.stringify(node.elementType)}`] : []),
    ...(node.frameOrigin && node.frameOrigin !== pageOrigin ? [`frameOrigin=${JSON.stringify(node.frameOrigin)}`] : []),
    ...(includeGeometry && node.geometry ? [`geometry=${JSON.stringify(node.geometry)}`] : []),
  ];

  return `- ${JSON.stringify(node.role)} ${fields.join(" ")}`;
}

function projectObservationLines(
  base: ObservationProjectionBase,
  nodes: ProjectedNode[],
  kind: "observation" | "observation_delta" | "observation_text",
  options: ObservationOptions,
  text = "",
): string {
  const title = base.title ? JSON.stringify(base.title) : JSON.stringify(base.mode || "page");
  const origin = JSON.stringify(base.origin);
  const header = `page trust=untrusted_page_content title=${title} origin=${origin} ${kind}`;
  const body = nodes.map((node) => renderCompactLine(node, options.includeGeometry, base.origin));

  if (kind === "observation_text" && text) {
    return `${header}\n${JSON.stringify(text)}`;
  }

  return [header, ...body].join("\n");
}

function normalizeObservationProjection(raw: Record<string, unknown>, options: ObservationOptions): ObservationProjectionResult {
  const base = normalizeObservationBase(raw);

  if (raw.kind === "observation_text") {
    const text = asSafeBoundedText(raw.text, OBS_TEXT_CAP);
    const { budget } = enforceObservationBudget([], options, base.nodeCount, raw.truncated === true);

    if (options.format === "json") {
      return {
        ok: true,
        projection: {
          kind: "observation_text",
          format: "json",
          nodes: [],
          text,
          ...base,
          budget,
        },
      };
    }

    return {
        ok: true,
        projection: {
          kind: "observation_text",
          format: "compact",
          nodes: [],
          output: projectObservationLines(base, [], "observation_text", options, text),
          ...base,
          budget,
        },
    };
  }

  const kind: "observation" | "observation_delta" = raw.kind === "observation" ? "observation" : "observation_delta";
  const sourceNodes = kind === "observation"
    ? raw.nodes
    : [...(Array.isArray(raw.added) ? raw.added : []), ...(Array.isArray(raw.updated) ? raw.updated : [])];

  const sourceNodeCount = asSafeNonNegativeInt(
    raw.nodeCount,
    Array.isArray(sourceNodes) ? sourceNodes.length : 0,
    OBSERVATION_SOURCE_NODE_CAP,
  );

  const sourceTruncated = raw.truncated === true;
  const normalized = (Array.isArray(sourceNodes)
    ? sourceNodes
      .map((entry) => {
        const node = kind === "observation" ? normalizeObservationNode(entry, options.includeGeometry) : normalizeUpdatedNode(entry);
        const safeNode = node ? retainCrossOriginFrame(retainSameOriginHref(node, base.origin), base.origin) : undefined;
        if (!safeNode || !matchesRoles(safeNode, options.roles) || !matchesQuery(safeNode, options.query)) return undefined;
        return safeNode;
      })
      .filter((entry): entry is ProjectedNode => Boolean(entry))
    : [])
    .filter((node) => node !== undefined);

  const deduped = dedupeNodes(normalized).slice(0, OBSERVATION_PROJECTION_NODE_CAP);
  const { nodes, budget } = enforceObservationBudget(deduped, options, sourceNodeCount, sourceTruncated);

  if (options.format === "compact") {
    return {
      ok: true,
      projection: {
        kind,
        format: "compact",
        nodes: [],
        output: projectObservationLines(base, nodes, kind, options),
        ...base,
        budget,
      },
    };
  }

  return {
    ok: true,
    projection: {
      kind,
      format: "json",
      nodes,
      ...base,
      budget,
    },
  };
}

function parseActionOutcome(raw: unknown): AgentActionOutcome | undefined {
  if (typeof raw !== "string") return undefined;
  const candidate = raw.trim().toLowerCase();
  return AGENT_ACTION_OUTCOME_SET.has(candidate as AgentActionOutcome) ? (candidate as AgentActionOutcome) : undefined;
}

function parseActionError(raw: unknown): string | undefined {
  return typeof raw === "string" ? asSafeString(raw, ACTION_ERROR_CODE_CAP) : undefined;
}

function parseActionStatus(raw: unknown): BrowserActionResultStatus | undefined {
  if (typeof raw !== "string") return undefined;
  const candidate = asSafeString(raw, ACTION_STATUS_CAP).toLowerCase();
  return BROWSER_ACTION_RESULT_STATUSES.includes(candidate as BrowserActionResultStatus)
    ? candidate as BrowserActionResultStatus
    : undefined;
}

function parseActionDecision(raw: unknown): AgentActionDecision | undefined {
  if (!isObjectRecord(raw)) return undefined;
  const redacted = redactJson(raw);
  if (!isObjectRecord(redacted)) return undefined;

  const riskClass = typeof redacted.class === "string" && BROWSER_RISK_CLASSES.includes(redacted.class as BrowserRiskClass)
    ? redacted.class as BrowserRiskClass
    : undefined;
  const commitBoundary = typeof redacted.commitBoundary === "string" && BROWSER_COMMIT_BOUNDARIES.includes(redacted.commitBoundary as BrowserCommitBoundary)
    ? redacted.commitBoundary as BrowserCommitBoundary
    : undefined;
  if (!riskClass || !commitBoundary) return undefined;

  const reason = asSafeString(redacted.reason, ACTION_REASON_CAP);
  return reason ? { class: riskClass, commitBoundary, reason } : { class: riskClass, commitBoundary };
}

function parseActionDelta(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const delta = raw
    .flatMap((entry) => (typeof entry === "string" ? [asSafeString(entry, ACTION_DELTA_ITEM_CAP)] : []))
    .filter((entry) => entry.length > 0)
    .slice(0, ACTION_DELTA_CAP);

  return delta.length > 0 ? delta : undefined;
}

function parseActionProvenance(raw: unknown): AgentActionProvenance | undefined {
  if (!isObjectRecord(raw)) return undefined;

  const origin = asSafeString(redactBrowserOrigin(raw.origin), ACTION_ORIGIN_CAP);
  return {
    trust: "untrusted_page_content",
    origin: origin || "unknown",
  };
}

export function normalizeAgentActionResult(raw: unknown): AgentActionResultProjection {
  if (!isObjectRecord(raw)) {
    return { ok: false, status: "failed", outcome: "outcome_unknown", retrySafe: false, decision: { class: "blocked", commitBoundary: "none", reason: "runner_contract_invalid" }, errorCode: "runner_contract_invalid" };
  }

  const redacted = redactJson(raw);
  if (!isObjectRecord(redacted)) {
    return { ok: false, status: "failed", outcome: "outcome_unknown", retrySafe: false, decision: { class: "blocked", commitBoundary: "none", reason: "runner_contract_invalid" }, errorCode: "runner_contract_invalid" };
  }

  const diagnosticStatus = parseActionStatus(redacted.status);
  const missingStatus = !("status" in redacted);
  const statusInvalid = !missingStatus && diagnosticStatus === undefined;
  const outcome = parseActionOutcome(redacted.outcome);
  const hasOutcome = "outcome" in redacted;
  const outcomeInvalid = hasOutcome && outcome === undefined;
  const missingOutcome = !hasOutcome;
  const errorCode = parseActionError(redacted.errorCode);
  const invalidError = "errorCode" in redacted && errorCode === undefined;
  const decision = parseActionDecision(redacted.decision);
  const invalid = missingStatus || statusInvalid || missingOutcome || outcomeInvalid || invalidError || !decision || "error" in redacted;
  const normalizedOutcome: AgentActionOutcome = invalid || !outcome ? "outcome_unknown" : outcome;
  const provenance = parseActionProvenance(redacted.provenance);
  const delta = parseActionDelta(redacted.delta);
  return {
    ok: !invalid && normalizedOutcome === "completed" && !errorCode,
    status: diagnosticStatus ?? "failed",
    outcome: normalizedOutcome,
    retrySafe: normalizedOutcome === "not_started" || normalizedOutcome === "prevented",
    ...(asSafeString(redacted.reason, ACTION_REASON_CAP) ? { reason: asSafeString(redacted.reason, ACTION_REASON_CAP) } : {}),
    decision: decision ?? { class: "blocked", commitBoundary: "none", reason: "runner_contract_invalid" },
    ...(delta ? { delta } : {}),
    ...(typeof redacted.changed === "boolean" ? { changed: redacted.changed } : {}),
    ...(provenance ? { provenance } : {}),
    ...(invalid ? { errorCode: "runner_contract_invalid" } : errorCode ? { errorCode } : {}),
  };
}

export function projectObservation(raw: unknown, input: AgentObservationOptionsInput = {}): ObservationProjectionResult {
  const redacted = redactBrowserResult(raw);
  if (!redacted || !isObjectRecord(redacted)) {
    return { ok: false, errorCode: "invalid_observation", reason: "observation could not be redacted" };
  }
  if (!isSupportedObservationKind(redacted.kind)) {
    return {
      ok: false,
      errorCode: "unsupported_observation_kind",
      reason: `unsupported kind ${(redacted as Record<string, unknown>).kind ?? "unknown"}`,
    };
  }

  const options = normalizeObservationOptions(input);
  return normalizeObservationProjection(redacted, options);
}

export function projectCompactObservation(raw: unknown, input: AgentObservationOptionsInput = {}): ObservationProjectionResult {
  return projectObservation(raw, { ...input, format: "compact" });
}

export function projectLeanObservation(raw: unknown, input: AgentObservationOptionsInput = {}): ObservationProjectionResult {
  return projectObservation(raw, { ...input, format: "json" });
}
