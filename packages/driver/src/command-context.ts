import { ENGINE_LIMITS, EngineError, type EngineDispatch } from "@newton-browser/core";

export interface EngineClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}
export const engineClock: EngineClock = {
  now: () => performance.now(),
  schedule(callback, delayMs) { const timer = setTimeout(callback, delayMs); return () => clearTimeout(timer); },
};

/** A deadline prevents subsequent input, including after a transport finally returns. */
export class CommandContext {
  readonly signal: AbortSignal;
  readonly aborted: Promise<void>;
  readonly deadline: number;
  private readonly controller = new AbortController();
  private readonly clock: EngineClock;
  private readonly disposeTimer: () => void;
  private resolveAbort!: () => void;
  private attempts = 0;
  private acknowledgements = 0;
  private cause: "cancelled" | "timed_out" | undefined;

  constructor(timeoutMs: number, clock: EngineClock = engineClock) {
    this.clock = clock;
    this.deadline = clock.now() + timeoutMs;
    this.signal = this.controller.signal;
    this.aborted = new Promise(resolve => { this.resolveAbort = resolve; });
    this.disposeTimer = clock.schedule(() => this.cancel("timed_out"), timeoutMs);
  }
  get dispatch(): EngineDispatch {
    return !this.attempts ? "not_started" : this.attempts === this.acknowledgements ? "acknowledged" : "attempted";
  }
  get cancellation(): "cancelled" | "timed_out" | undefined { return this.cause; }
  ensureInputCapacity(count: number): void {
    this.checkpoint();
    if (!Number.isSafeInteger(count) || count < 0 || this.attempts + count > ENGINE_LIMITS.maxInputPrimitives) throw new EngineError("work_limit");
  }
  mark(): readonly [number, number] { return [this.attempts, this.acknowledgements]; }
  since(mark: readonly [number, number]): EngineDispatch {
    const attempts = this.attempts - mark[0], acknowledgements = this.acknowledgements - mark[1];
    return attempts === 0 ? "not_started" : attempts === acknowledgements ? "acknowledged" : "attempted";
  }
  checkpoint(): void {
    if (!this.cause && this.clock.now() >= this.deadline) this.cancel("timed_out");
    if (this.cause) throw new EngineError(this.cause);
  }
  cancel(cause: "cancelled" | "timed_out" = "cancelled"): void {
    if (this.cause) return;
    this.cause = cause;
    this.controller.abort(new EngineError(cause));
    this.resolveAbort();
  }
  async read<T>(operation: () => Promise<T>): Promise<T> {
    this.checkpoint();
    let abort!:()=>void;
    const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(this.signal.reason);this.signal.addEventListener('abort',abort,{once:true});});
    try {
      const result = await Promise.race([operation(),cancelled]);
      this.checkpoint();
      return result;
    } finally {this.signal.removeEventListener('abort',abort);}
  }
  async input<T>(operation: () => Promise<T>): Promise<T> {
    this.checkpoint();
    if (this.attempts >= ENGINE_LIMITS.maxInputPrimitives) throw new EngineError("work_limit");
    this.attempts++;
    const result = await operation();
    this.acknowledgements++;
    this.checkpoint();
    return result;
  }
  dispose(): void { this.disposeTimer(); }
}
