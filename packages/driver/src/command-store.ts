import { createHash } from "node:crypto";
import { ENGINE_LIMITS, EngineError, type EngineCommand, type EngineCommandState, type EngineReceipt } from "@newton-browser/core";
import { engineClock, type EngineClock } from "./command-context.ts";

export interface CommandRecord {
  readonly id: number;
  readonly hash: string;
  readonly result: Promise<EngineReceipt>;
  state: EngineCommandState;
  finishedAt?: number;
  complete(receipt: EngineReceipt): void;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
/** Only canonical parsed commands enter this store. Values are hashed, never retained here. */
export class CommandStore {
  private highWater = 0;
  private readonly records = new Map<number, CommandRecord>();
  private readonly clock: EngineClock;
  constructor(clock: EngineClock = engineClock) { this.clock = clock; }
  get nextId(): number { return this.highWater + 1; }
  lookup(command: EngineCommand): CommandRecord | undefined {
    this.expire();
    const record = this.records.get(command.commandId);
    if (record && record.hash !== this.hash(command)) throw new EngineError("command_id_conflict");
    if (!record && command.commandId <= this.highWater) throw new EngineError("command_expired");
    if (!record && command.commandId !== this.nextId) throw new EngineError("command_sequence_gap");
    return record;
  }
  get(id: number): EngineCommandState {
    this.expire();
    const record = this.records.get(id);
    if (!record) throw new EngineError(id <= this.highWater ? "command_expired" : "unknown_command");
    return record.state;
  }
  admit(command: EngineCommand): CommandRecord {
    const existing = this.lookup(command);
    if (existing) return existing;
    let resolve!: (receipt: EngineReceipt) => void;
    const record: CommandRecord = {
      id: command.commandId, hash: this.hash(command),
      result: new Promise(done => { resolve = done; }),
      state: Object.freeze({ commandId: command.commandId, state: "queued", dispatch: "not_started" }),
      complete: receipt => {
        if (record.finishedAt !== undefined) return;
        record.state = freeze(receipt);
        record.finishedAt = this.clock.now();
        resolve(receipt);
        this.expire();
      },
    };
    this.highWater = command.commandId;
    this.records.set(record.id, record);
    return record;
  }
  private hash(command: EngineCommand): string { return createHash("sha256").update(JSON.stringify(command)).digest("hex"); }
  private expire(): void {
    const finished = [...this.records.values()].filter(record => record.finishedAt !== undefined);
    let remaining = finished.length;
    for (const record of finished) {
      if (this.clock.now() - record.finishedAt! >= ENGINE_LIMITS.terminalTtlMs || remaining > ENGINE_LIMITS.terminalRecords) {
        this.records.delete(record.id); remaining--;
      }
    }
  }
}
