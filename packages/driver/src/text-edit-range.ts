import { EngineError } from "@newton-browser/core";

export interface TextEditMatch {
  match: string;
  replacement: string;
  prefix?: string;
  suffix?: string;
  occurrence?: number;
}

export interface TextEditRange {
  start: number;
  end: number;
  expected: string;
}

const MAX_VALUE_UNITS = 65_536;
const MAX_MATCH_UNITS = 4_096;
const MAX_CONTEXT_UNITS = 4_096;
const MAX_REPLACEMENT_UNITS = 65_536;
const MAX_OCCURRENCE = 65_536;

export function resolveTextEditRange(value: string, edit: TextEditMatch): TextEditRange {
  if (typeof value !== "string" || !edit || typeof edit !== "object" || Array.isArray(edit)) {
    throw new EngineError("invalid_arguments");
  }
  const { match, replacement } = edit;
  const prefix = edit.prefix;
  const suffix = edit.suffix;
  if (typeof match !== "string" || typeof replacement !== "string"
    || (prefix !== undefined && typeof prefix !== "string")
    || (suffix !== undefined && typeof suffix !== "string")) {
    throw new EngineError("invalid_arguments");
  }
  if (value.length > MAX_VALUE_UNITS || match.length > MAX_MATCH_UNITS || replacement.length > MAX_REPLACEMENT_UNITS
    || (prefix?.length ?? 0) > MAX_CONTEXT_UNITS || (suffix?.length ?? 0) > MAX_CONTEXT_UNITS) {
    throw new EngineError("work_limit");
  }
  if (match.length < 1) throw new EngineError("invalid_arguments");
  if (!isWellFormedUnicode(match) || !isWellFormedUnicode(replacement)
    || (prefix !== undefined && !isWellFormedUnicode(prefix))
    || (suffix !== undefined && !isWellFormedUnicode(suffix))) {
    throw new EngineError("invalid_arguments");
  }
  if (edit.occurrence !== undefined) {
    if (!Number.isSafeInteger(edit.occurrence) || edit.occurrence < 1 || edit.occurrence > MAX_OCCURRENCE) {
      throw new EngineError("invalid_arguments");
    }
  }
  let index = 0;
  let seen = 0;
  let selectedStart = -1;
  while (index <= value.length) {
    const start = value.indexOf(match, index);
    if (start < 0) break;
    const end = start + match.length;
    index = start + 1;
    if (!isBoundarySafe(value, start) || !isBoundarySafe(value, end)) continue;
    if (prefix !== undefined && !matchesContext(value, start, "prefix", prefix)) continue;
    if (suffix !== undefined && !matchesContext(value, end, "suffix", suffix)) continue;
    seen += 1;
    if (edit.occurrence === undefined) {
      if (seen > 1) throw new EngineError("ambiguous");
      selectedStart = start;
    } else if (seen === edit.occurrence) {
      selectedStart = start;
      break;
    }
  }
  if (selectedStart < 0) {
    throw new EngineError("not_found");
  }
  const selectedEnd = selectedStart + match.length;
  const expectedLength = value.length - match.length + replacement.length;
  if (expectedLength > MAX_VALUE_UNITS) throw new EngineError("work_limit");
  return Object.freeze({
    start: selectedStart,
    end: selectedEnd,
    expected: value.slice(0, selectedStart) + replacement + value.slice(selectedEnd),
  });
}

function isBoundarySafe(value: string, index: number): boolean {
  return index <= 0 || index >= value.length
    || !(isHighSurrogate(value.charCodeAt(index - 1)) && isLowSurrogate(value.charCodeAt(index)));
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xDC00 && value <= 0xDFFF;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xD800 && value <= 0xDBFF;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const head = value.charCodeAt(index);
    if (isHighSurrogate(head)) {
      const tail = value.charCodeAt(index + 1);
      if (!isLowSurrogate(tail)) return false;
      index += 1;
      continue;
    }
    if (isLowSurrogate(head)) return false;
  }
  return true;
}

function matchesContext(text: string, boundary: number, side: "prefix" | "suffix", context: string): boolean {
  if (!context.length) return true;
  if (side === "prefix") {
    return boundary >= context.length && text.slice(boundary - context.length, boundary) === context;
  }
  return boundary + context.length <= text.length && text.slice(boundary, boundary + context.length) === context;
}
