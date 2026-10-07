/** Private adapter surface. Never exposed as an MCP method or model command. */
export interface EngineWire {
  send(method: string, params?: Record<string, unknown>, sessionId?: string | null): Promise<Record<string, unknown>>;
  onEvent(listener: (event: { method: string; params: Record<string, unknown>; sessionId: string | null }) => void | Promise<void>): () => void;
}
export interface EngineConnection {
  /** Private owned process only; borrowed tab adapters never grant browser discovery. */
  readonly ownsBrowser?: boolean;
  /** A tab of the operator's own browser: usually in the background, where Chromium runs no frames. */
  readonly borrowedTab?: boolean;
  /** The adapter emits only pages already claimed by this connection's owner. */
  readonly tracksOwnedPages?: boolean;
  /** Sites the cloned login source holds cookies for (domains only), when the session starts from one. */
  readonly loginSites?: readonly string[];
  readonly wire: EngineWire;
  readonly rootTargetId: string;
  readonly epoch: string;
  readonly claimGeneration: number;
  readonly signal: AbortSignal;
  close(): Promise<void>;
}
