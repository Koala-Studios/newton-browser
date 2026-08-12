import { randomUUID } from "node:crypto";

import type { CdpRecord, DebuggerPort, DebuggerTarget } from "./types.ts";

const DEBUGGER_VERSION = "1.3";
const BROWSER_SESSION_PREFIX = "newton-direct-browser:";
const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;
const SESSION_ID_PATTERN = /^[^\s\0]{1,512}$/u;
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/u;
const MAX_PENDING_ADAPTER_EVENTS = 256;

type UnknownRecord = Record<string, unknown>;

export type BrowserLevelTransport = Readonly<{
  send(method: string, params: UnknownRecord, sessionId?: string | null): Promise<UnknownRecord>;
  onEvent(listener: BrowserTransportEventListener): () => void;
}>;

export type BrowserTransportEvent = Readonly<{
  method: string;
  params: UnknownRecord;
  sessionId: string | null;
}>;

export type BrowserTransportEventListener = (
  event: BrowserTransportEvent,
) => void | Promise<void>;

export type DirectDebuggerSource = Readonly<{ tabId: number; sessionId?: string }>;
export type DirectDebuggerEventListener = (
  source: DirectDebuggerSource,
  method: string,
  params: UnknownRecord,
) => void | Promise<void>;

export type DirectDebuggerPortErrorCode =
  | "direct_debugger_already_attached"
  | "direct_debugger_attach_failed"
  | "direct_debugger_attach_response_invalid"
  | "direct_debugger_command_failed"
  | "direct_debugger_detach_uncertain"
  | "direct_debugger_event_overflow"
  | "direct_debugger_forged_session"
  | "direct_debugger_invalid_method"
  | "direct_debugger_invalid_params"
  | "direct_debugger_not_attached"
  | "direct_debugger_transport_closed"
  | "direct_debugger_wrong_tab"
  | "direct_debugger_wrong_version";

export type DirectDebuggerPortError = Error & Readonly<{
  code: DirectDebuggerPortErrorCode;
  retryable: boolean;
  uncertain: boolean;
}>;

export type DirectDebuggerPort = DebuggerPort & Readonly<{
  onDebuggerEvent(listener: DirectDebuggerEventListener): () => void;
}>;

export type DirectDebuggerPortOptions = Readonly<{
  transport: BrowserLevelTransport;
  rootTargetId: string;
  tabId: number;
}>;

export function createDirectDebuggerPort(options: DirectDebuggerPortOptions): DirectDebuggerPort {
  const { transport } = options;
  const rootTargetId = requiredTargetId(options.rootTargetId);
  const tabId = requiredTabId(options.tabId);
  const browserSessionToken = `${BROWSER_SESSION_PREFIX}${randomUUID()}`;
  const listeners = new Set<DirectDebuggerEventListener>();
  let rootSessionId: string | null = null;
  let unsubscribeTransport: (() => void) | null = null;
  let generation = 0;
  let eventQueue: Promise<void> = Promise.resolve();
  let pendingEventCount = 0;
  let attachInProgress = false;
  let terminalError: DirectDebuggerPortError | null = null;

  const port: DirectDebuggerPort = {
    async attach(target, version) {
      requireTab(target, tabId);
      if (version !== DEBUGGER_VERSION) throw directError("direct_debugger_wrong_version", false, false);
      requireOperational(terminalError);
      if (attachInProgress || rootSessionId !== null || unsubscribeTransport !== null) {
        throw directError("direct_debugger_already_attached", false, false);
      }
      attachInProgress = true;
      const attachedGeneration = generation + 1;
      let resolveAttachment: (sessionId: string | null) => void = () => {};
      const attachment = new Promise<string | null>((resolve) => { resolveAttachment = resolve; });
      let attemptActive = true;
      let unsubscribe: () => void;
      try {
        unsubscribe = transport.onEvent((event) => {
          if (!attemptActive) return;
          if (pendingEventCount >= MAX_PENDING_ADAPTER_EVENTS) {
            const overflow = directError("direct_debugger_event_overflow", false, true);
            terminalError ??= overflow;
            attemptActive = false;
            resolveAttachment(null);
            return Promise.reject(overflow);
          }
          pendingEventCount += 1;
          const eventListeners = [...listeners];
          const delivery = eventQueue.then(async () => {
            const attachedSessionId = await attachment;
            if (attachedSessionId === null) return;
            if (generation !== attachedGeneration || rootSessionId !== attachedSessionId) return;
            await dispatchEvent(
              event.method,
              event.params,
              event.sessionId,
              attachedSessionId,
              browserSessionToken,
              tabId,
              eventListeners,
            );
          }).finally(() => { pendingEventCount -= 1; });
          eventQueue = delivery.catch(() => {});
          return delivery;
        });
      } catch (error) {
        attemptActive = false;
        resolveAttachment(null);
        attachInProgress = false;
        throw transportError("direct_debugger_attach_failed", error, false);
      }
      if (typeof unsubscribe !== "function") {
        attemptActive = false;
        resolveAttachment(null);
        await eventQueue;
        attachInProgress = false;
        throw directError("direct_debugger_attach_failed", true, false);
      }
      let response: UnknownRecord;
      try {
        response = await transport.send("Target.attachToTarget", { targetId: rootTargetId, flatten: true }, null);
      } catch (error) {
        attemptActive = false;
        resolveAttachment(null);
        try { unsubscribe(); } catch { /* no attachment was confirmed */ }
        await eventQueue;
        attachInProgress = false;
        throw transportError("direct_debugger_attach_failed", error, true);
      }
      const candidateSessionId = safeTransportSessionId(response.sessionId);
      if (terminalError) {
        attemptActive = false;
        resolveAttachment(null);
        try { unsubscribe(); } catch { /* the provisional event route is already invalid */ }
        await eventQueue;
        attachInProgress = false;
        if (candidateSessionId) {
          try {
            await transport.send("Target.detachFromTarget", { sessionId: candidateSessionId }, null);
          } catch {
            throw directError("direct_debugger_attach_failed", true, true);
          }
        }
        throw terminalError;
      }
      if (!candidateSessionId || isReservedSession(candidateSessionId)) {
        attemptActive = false;
        resolveAttachment(null);
        try { unsubscribe(); } catch { /* the provisional event route is already invalid */ }
        await eventQueue;
        attachInProgress = false;
        if (candidateSessionId) {
          try {
            await transport.send("Target.detachFromTarget", { sessionId: candidateSessionId }, null);
          } catch {
            throw directError("direct_debugger_attach_failed", true, true);
          }
        }
        throw directError("direct_debugger_attach_response_invalid", true, true);
      }
      generation = attachedGeneration;
      rootSessionId = candidateSessionId;
      unsubscribeTransport = unsubscribe;
      resolveAttachment(candidateSessionId);
      attachInProgress = false;
    },

    async detach(target) {
      requireTab(target, tabId);
      const attachedSessionId = requireAttached(rootSessionId);
      try {
        await transport.send("Target.detachFromTarget", { sessionId: attachedSessionId }, null);
      } catch (error) {
        throw transportError("direct_debugger_detach_uncertain", error, true);
      }
      generation += 1;
      rootSessionId = null;
      const unsubscribe = unsubscribeTransport;
      unsubscribeTransport = null;
      try { unsubscribe?.(); } catch { /* the root detach is already authoritative */ }
      await eventQueue;
      listeners.clear();
    },

    async sendCommand(target: DebuggerTarget, method: string, params: CdpRecord): Promise<CdpRecord> {
      requireTab(target, tabId);
      requireOperational(terminalError);
      const attachedSessionId = requireAttached(rootSessionId);
      const safeMethod = requiredMethod(method);
      const safeParams = requiredParams(params);
      const requestedSessionId = target.sessionId;

      if (requestedSessionId === undefined) {
        if (safeMethod === "Target.attachToBrowserTarget") {
          if (Object.keys(safeParams).length !== 0) throw directError("direct_debugger_invalid_params", false, false);
          return { sessionId: browserSessionToken };
        }
        if (isSyntheticBrowserDetach(safeMethod, safeParams, browserSessionToken)) return {};
        return sendTransport(transport, safeMethod, safeParams, attachedSessionId);
      }

      const safeSessionId = requiredSessionId(requestedSessionId);
      if (safeSessionId === browserSessionToken) {
        if (safeMethod === "Target.attachToBrowserTarget") {
          throw directError("direct_debugger_already_attached", false, false);
        }
        if (!safeMethod.startsWith("Target.")) throw directError("direct_debugger_forged_session", false, false);
        if (isSyntheticBrowserDetach(safeMethod, safeParams, browserSessionToken)) return {};
        return sendTransport(transport, safeMethod, safeParams, null);
      }
      if (isReservedSession(safeSessionId)) throw directError("direct_debugger_forged_session", false, false);
      return sendTransport(transport, safeMethod, safeParams, safeSessionId);
    },

    onDebuggerEvent(listener) {
      if (typeof listener !== "function") throw directError("direct_debugger_invalid_params", false, false);
      listeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
      };
    },
  };

  return Object.freeze(port);
}

async function sendTransport(
  transport: BrowserLevelTransport,
  method: string,
  params: UnknownRecord,
  sessionId: string | null,
): Promise<UnknownRecord> {
  try {
    const response = await transport.send(method, params, sessionId);
    return isRecord(response) ? response : {};
  } catch (error) {
    throw transportError("direct_debugger_command_failed", error, true);
  }
}

async function dispatchEvent(
  method: string,
  params: UnknownRecord,
  sessionId: string | null | undefined,
  rootSessionId: string,
  browserSessionToken: string,
  tabId: number,
  listeners: readonly DirectDebuggerEventListener[],
): Promise<void> {
  if (!METHOD_PATTERN.test(method) || !isRecord(params)) return;
  let source: DirectDebuggerSource;
  if (sessionId === null || sessionId === undefined) {
    source = { tabId, sessionId: browserSessionToken };
  } else if (!SESSION_ID_PATTERN.test(sessionId) || isReservedSession(sessionId)) {
    return;
  } else if (sessionId === rootSessionId) {
    source = { tabId };
  } else {
    source = { tabId, sessionId };
  }
  for (const listener of [...listeners]) {
    try { await listener(source, method, params); } catch { /* preserve ordered delivery to remaining listeners */ }
  }
}

function isSyntheticBrowserDetach(method: string, params: UnknownRecord, browserSessionToken: string): boolean {
  return method === "Target.detachFromTarget"
    && Object.keys(params).length === 1
    && params.sessionId === browserSessionToken;
}

function requiredTargetId(value: string): string {
  if (!TARGET_ID_PATTERN.test(value)) throw new Error("direct_debugger_invalid_root_target");
  return value;
}

function requiredTabId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("direct_debugger_invalid_tab_id");
  return value;
}

function requireTab(target: { tabId: number | null }, expectedTabId: number): void {
  if (!target || target.tabId !== expectedTabId) throw directError("direct_debugger_wrong_tab", false, false);
}

function requireAttached(sessionId: string | null): string {
  if (sessionId === null) throw directError("direct_debugger_not_attached", true, false);
  return sessionId;
}

function requireOperational(terminalError: DirectDebuggerPortError | null): void {
  if (terminalError) throw terminalError;
}

function requiredMethod(method: string): string {
  if (!METHOD_PATTERN.test(method)) throw directError("direct_debugger_invalid_method", false, false);
  return method;
}

function requiredParams(params: unknown): UnknownRecord {
  if (!isRecord(params)) throw directError("direct_debugger_invalid_params", false, false);
  return params;
}

function requiredSessionId(value: string): string {
  if (!SESSION_ID_PATTERN.test(value)) throw directError("direct_debugger_forged_session", false, false);
  return value;
}

function safeTransportSessionId(value: unknown): string | null {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value) ? value : null;
}

function isReservedSession(sessionId: string): boolean {
  return sessionId.startsWith(BROWSER_SESSION_PREFIX);
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function transportError(
  fallbackCode: DirectDebuggerPortErrorCode,
  error: unknown,
  uncertain: boolean,
): DirectDebuggerPortError {
  const code = isTransportClosedError(error) ? "direct_debugger_transport_closed" : fallbackCode;
  return directError(code, true, uncertain);
}

function isTransportClosedError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.code === "transport_closed"
    || error.code === "cdp_transport_closed"
    || error.code === "ERR_STREAM_DESTROYED"
    || error.code === "ECONNRESET";
}

function directError(
  code: DirectDebuggerPortErrorCode,
  retryable: boolean,
  uncertain: boolean,
): DirectDebuggerPortError {
  return Object.assign(new Error(code), { code, retryable, uncertain });
}
