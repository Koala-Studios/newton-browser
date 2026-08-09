const COUNTER_FIELD_WHITELIST = ["name", "algorithm", "version", "provenance", "origin"];

function asSafeCounterMeta(raw) {
  if (!raw || typeof raw !== "object") return undefined;
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
  if (typeof counter !== "function") return { origin: "fallback", algorithm: "utf8-byte-upper-bound" };
  return {
    origin: "injected",
    algorithm: "token-counter",
    ...asSafeCounterMeta(counter),
  };
}

function estimateWithCounter(text, counter) {
  if (typeof counter !== "function") return null;
  try {
    const estimated = counter(text);
    const count = Number(estimated);
    if (!Number.isFinite(count) || count < 0) return null;
    return Number.isInteger(count) ? count : Math.round(count);
  } catch {
    return null;
  }
}

export function estimateTokensFromString(text, counter) {
  const safeText = typeof text === "string" ? text : "";
  const counted = estimateWithCounter(safeText, counter);
  if (counted !== null) {
    return {
      count: counted,
      method: "token_counter",
      origin: "injected",
      ...extractCounterMeta(counter),
    };
  }

  const bytes = Buffer.byteLength(safeText, "utf8");
  return {
    count: bytes,
    method: "utf8_byte_upper_bound",
    origin: "heuristic",
    algorithm: "utf8-byte-length",
  };
}

export function estimateTokens(value, counter) {
  return estimateTokensFromString(serializeForBudget(value), counter);
}
