const COUNTER_FIELD_WHITELIST = ["name", "algorithm", "version", "provenance", "origin"];

function asSafeCounterMeta(raw) {
  if (!raw || (typeof raw !== "object" && typeof raw !== "function")) return undefined;
  const metadata = {};
  for (const field of COUNTER_FIELD_WHITELIST) {
    if (typeof raw[field] === "string" && raw[field].trim()) {
      metadata[field] = raw[field].trim();
    }
  }
  return metadata;
}

export function stableSortKeys(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => stableSortKeys(entry));

  const keys = Object.keys(value).sort();
  const output = {};
  for (const key of keys) {
    output[key] = stableSortKeys(value[key]);
  }
  return output;
}

export function serializeForBudget(value) {
  return JSON.stringify(stableSortKeys(value));
}

export function extractCounterMeta(counter) {
  if (typeof counter !== "function") throw new Error("token_counter_required");
  return {
    origin: "injected",
    algorithm: "token-counter",
    ...asSafeCounterMeta(counter),
  };
}

function estimateWithCounter(text, counter) {
  if (typeof counter !== "function") throw new Error("token_counter_required");
  try {
    const estimated = counter(text);
    const count = Number(estimated);
    if (!Number.isFinite(count) || count < 0) throw new Error("token_counter_invalid");
    return Number.isInteger(count) ? count : Math.round(count);
  } catch (error) {
    if (error instanceof Error && error.message === "token_counter_invalid") throw error;
    throw new Error("token_counter_failed");
  }
}

export function estimateTokensFromString(text, counter) {
  const safeText = typeof text === "string" ? text : "";
  const counted = estimateWithCounter(safeText, counter);
  return {
    count: counted,
    method: "token_counter",
    origin: "injected",
    ...extractCounterMeta(counter),
  };
}

export function estimateTokens(value, counter) {
  return estimateTokensFromString(serializeForBudget(value), counter);
}
