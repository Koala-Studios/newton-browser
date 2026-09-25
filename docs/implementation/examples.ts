// Executable teaching examples for FOUNDATION.md, not production scaffolding.
// They deliberately do not implement a queue, session engine or transport.
export type Dispatch = "not_started" | "attempted" | "acknowledged";

export class ExampleBudget {
  readonly expiresAt: number;
  readonly now: () => number;
  readonly signal: AbortSignal;
  constructor(
    now: () => number,
    timeoutMs: number,
    signal: AbortSignal,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("invalid_budget");
    this.now = now;
    this.signal = signal;
    this.expiresAt = now() + timeoutMs;
  }
  assertActive(): void {
    this.remainingMs();
  }
  remainingMs(): number {
    if (this.signal.aborted) throw new Error("cancelled");
    const remaining = this.expiresAt - this.now();
    if (remaining <= 0) throw new Error("timed_out");
    return Math.ceil(remaining);
  }
}

export class ExampleDispatchLedger {
  private next = 0;
  private readonly attempts = new Map<number, boolean>();
  begin(): number {
    if (this.attempts.size >= 256) throw new Error("input_work_limit");
    const id = ++this.next;
    this.attempts.set(id, false);
    return id;
  }
  acknowledge(id: number): void {
    if (!this.attempts.has(id)) throw new Error("unknown_attempt");
    this.attempts.set(id, true);
  }
  summary(): Dispatch {
    if (this.attempts.size === 0) return "not_started";
    return [...this.attempts.values()].every(Boolean) ? "acknowledged" : "attempted";
  }
}

// One primitive only. A production input sequence calls its scoped primitive
// wrapper for EACH key/focus/text operation, not once around the entire sequence.
export async function exampleInput<T>(
  budget: ExampleBudget,
  ledger: ExampleDispatchLedger,
  send: () => Promise<T>,
): Promise<T> {
  budget.assertActive();
  const attempt = ledger.begin();
  const result = await send();
  ledger.acknowledge(attempt);
  budget.assertActive(); // Acknowledged input remains recorded if this throws.
  return result;
}

export function classifyCommandId(input: {
  id: number; highWater: number; incomingHash: string; retainedHash?: string;
}): "new" | "join" | "expired" | "conflict" | "gap" {
  if (!Number.isSafeInteger(input.id) || input.id < 1
    || !Number.isSafeInteger(input.highWater) || input.highWater < 0) {
    throw new Error("invalid_command_id");
  }
  if (input.retainedHash !== undefined) {
    if (input.id > input.highWater) throw new Error("invalid_store_state");
    return input.retainedHash === input.incomingHash ? "join" : "conflict";
  }
  if (input.id <= input.highWater) return "expired";
  return input.id === input.highWater + 1 ? "new" : "gap";
}

export function normalizeStartUrl(input: string): string {
  if (input.length > 8192) throw new Error("invalid_url");
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("invalid_url"); }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
    throw new Error("invalid_url");
  }
  return url.href;
}

type ExampleRow = Readonly<{ ref: string; label: string }>;
type ExampleBase = Readonly<{ commandId: number; dispatch: Dispatch; scope: string }>;

// Input rows are already validated/redacted. Demonstrates accounting for actual
// UTF-8 and JSON punctuation. Production also reserves all mandatory fields before
// input, caps read work and carries snapshot/expiry/provenance information.
export function packExampleRows(
  base: ExampleBase,
  rows: readonly ExampleRow[],
  sourceComplete: boolean,
  maxBytes: number,
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("invalid_budget");
  const selected: ExampleRow[] = [];
  let bytes = Buffer.byteLength(JSON.stringify({ ...base, complete: false, rows: [] }), "utf8");
  if (bytes > maxBytes) throw new Error("mandatory_envelope_does_not_fit");
  for (const row of rows) {
    const additional = Buffer.byteLength(JSON.stringify(row), "utf8") + (selected.length ? 1 : 0);
    if (bytes + additional > maxBytes) break;
    selected.push(row);
    bytes += additional;
  }
  const result = JSON.stringify({ ...base,
    complete: sourceComplete && selected.length === rows.length, rows: selected });
  if (Buffer.byteLength(result, "utf8") > maxBytes) throw new Error("encoder_invariant_failed");
  return result;
}
