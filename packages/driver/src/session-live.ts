import { EngineError } from "@newton-browser/core";
import type { EngineWire } from "./connection.ts";
import type { PageDirectory } from "./page-directory.ts";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";

/** A WebAuthn credential held by the embedder. Never crosses the model-facing MCP boundary. */
export type EngineWebAuthnCredential = Readonly<{
  rpId: string; credentialId: string; privateKey: string; userHandle?: string; signCount: number;
}>;

/** Session events for the embedding host only. Credential events carry key material and must stay out of logs and MCP. */
export type EngineSessionEvent =
  | Readonly<{ type: "navigated"; pageId: string; url: string }>
  | Readonly<{ type: "dialog"; pageId: string; dialogType: string; message: string }>
  | Readonly<{ type: "page_opened"; pageId: string; openerPageId?: string }>
  | Readonly<{ type: "closed" }>
  | Readonly<{ type: "credential_created"; credential: EngineWebAuthnCredential }>
  | Readonly<{ type: "credential_used"; rpId: string; credentialId: string; signCount: number }>;

export type EngineFrame = Readonly<{ pageId: string; data: string; mimeType: "image/jpeg"; width: number; height: number; timestamp: number }>;
export type EngineFrameOptions = Readonly<{ maxWidth?: number; maxHeight?: number; quality?: number }>;

/** Operator input in page CSS pixels, applied to the same page the model uses. */
export type EngineOperatorInput =
  | Readonly<{ type: "mouse"; action: "move" | "down" | "up"; x: number; y: number; button?: "left" | "middle" | "right"; clickCount?: number; modifiers?: number }>
  | Readonly<{ type: "wheel"; x: number; y: number; deltaX: number; deltaY: number }>
  | Readonly<{ type: "key"; action: "down" | "up"; key: string; code?: string; text?: string; modifiers?: number; keyCode?: number }>
  | Readonly<{ type: "text"; text: string }>;

type FrameSubscription = { route: string; listeners: Set<(frame: EngineFrame) => void | Promise<void>>; busy: Set<unknown>; latest: Map<unknown, EngineFrame>; last?: EngineFrame };

/** Live view, takeover input, authenticator and host events for one executor's pages. */
export class SessionLive {
  private readonly wire: EngineWire;
  private readonly directory: PageDirectory;
  private readonly ownsBrowser: boolean;
  private readonly listeners = new Set<(event: EngineSessionEvent) => void>();
  private readonly frames = new Map<string, FrameSubscription>();
  private readonly authenticators = new Map<string, string>();
  private credentials: EngineWebAuthnCredential[] | undefined;
  constructor(wire: EngineWire, directory: PageDirectory, ownsBrowser: boolean) {
    this.wire = wire; this.directory = directory; this.ownsBrowser = ownsBrowser;
  }

  /** Enable the virtual authenticator for every page of this session. */
  useAuthenticator(credentials: readonly EngineWebAuthnCredential[]): void {
    if (credentials.length > 64) throw new EngineError("work_limit");
    this.credentials = credentials.map(validCredential);
  }

  subscribe(listener: (event: EngineSessionEvent) => void): () => void {
    if (this.listeners.size >= 16) throw new EngineError("work_limit");
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(event: EngineSessionEvent): void {
    for (const listener of this.listeners) { try { listener(event); } catch { /* host listener errors never affect the session */ } }
  }

  /** Called for each attached page session before navigation, like other domain enables. */
  async attachPage(route: string, send: (method: string, params?: RecordValue) => Promise<RecordValue>): Promise<void> {
    if (!this.credentials) return;
    await send("WebAuthn.enable", { enableUI: false });
    const created = await send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    const authenticatorId = string(created.authenticatorId);
    if (!authenticatorId) throw new EngineError("evidence_unavailable");
    this.authenticators.set(route, authenticatorId);
    for (const credential of this.credentials) await send("WebAuthn.addCredential", { authenticatorId, credential: cdpCredential(credential) });
  }

  handle(event: { method: string; params: RecordValue; sessionId?: string | null }, pageOf: (route: string) => string | undefined): void {
    const route = event.sessionId ?? "";
    if (event.method === "Page.screencastFrame") { this.frame(route, event.params, pageOf(route)); return; }
    if (event.method === "Page.frameNavigated") {
      const frame = object(event.params.frame), pageId = pageOf(route);
      if (pageId && string(frame.id) === pageId && !frame.parentId) this.emit({ type: "navigated", pageId, url: string(frame.url).slice(0, 2048) });
      return;
    }
    if (event.method === "Page.javascriptDialogOpening") {
      const pageId = pageOf(route);
      if (pageId) this.emit({ type: "dialog", pageId, dialogType: string(event.params.type), message: string(event.params.message).slice(0, 512) });
      return;
    }
    if (event.method === "WebAuthn.credentialAdded" && this.credentials) {
      const credential = fromCdpCredential(object(event.params.credential));
      if (!credential) return;
      this.credentials = [...this.credentials.filter(item => item.credentialId !== credential.credentialId), credential];
      // Other pages of the session (a sign-in popup, a second tab) get the new key too.
      for (const [other, authenticatorId] of this.authenticators) {
        if (other === route) continue;
        void this.wire.send("WebAuthn.addCredential", { authenticatorId, credential: cdpCredential(credential) }, other).catch(() => undefined);
      }
      this.emit({ type: "credential_created", credential });
      return;
    }
    if (event.method === "WebAuthn.credentialAsserted" && this.credentials) {
      const credential = fromCdpCredential(object(event.params.credential));
      if (!credential) return;
      this.credentials = this.credentials.map(item => item.credentialId === credential.credentialId ? { ...item, signCount: credential.signCount } : item);
      this.emit({ type: "credential_used", rpId: credential.rpId, credentialId: credential.credentialId, signCount: credential.signCount });
      return;
    }
    if (event.method === "Target.detachedFromTarget") { this.authenticators.delete(string(event.params.sessionId)); this.frames.delete(string(event.params.sessionId)); }
  }

  /** JPEG frames of one page while it changes. A slow listener receives only the latest frame. */
  async subscribeFrames(pageId: string, listener: (frame: EngineFrame) => void | Promise<void>, options: EngineFrameOptions = {}): Promise<() => Promise<void>> {
    if (!this.ownsBrowser) throw new EngineError("unsupported_capability");
    const route = this.directory.route(this.directory.binding(this.directory.stamp(pageId), 1));
    let subscription = this.frames.get(route);
    if (subscription && subscription.listeners.size >= 8) throw new EngineError("work_limit");
    if (!subscription) {
      subscription = { route, listeners: new Set(), busy: new Set(), latest: new Map() };
      this.frames.set(route, subscription);
      const bounded = (value: number | undefined, fallback: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value ?? fallback)));
      await this.wire.send("Page.startScreencast", { format: "jpeg", quality: bounded(options.quality, 70, 20, 90),
        maxWidth: bounded(options.maxWidth, 1280, 160, 3840), maxHeight: bounded(options.maxHeight, 900, 120, 2160), everyNthFrame: 1 }, route);
    }
    subscription.listeners.add(listener);
    // Chromium sends frames only when the page changes: a listener joining a running screencast starts from the latest one.
    if (subscription.last) this.deliver(subscription, listener, subscription.last);
    const current = subscription;
    return async () => {
      current.listeners.delete(listener); current.latest.delete(listener); current.busy.delete(listener);
      if (current.listeners.size || this.frames.get(route) !== current) return;
      this.frames.delete(route);
      await this.wire.send("Page.stopScreencast", {}, route).catch(() => undefined);
    };
  }

  private frame(route: string, params: RecordValue, pageId: string | undefined): void {
    // Always acknowledge so Chromium keeps producing frames; backpressure is per listener.
    void this.wire.send("Page.screencastFrameAck", { sessionId: params.sessionId }, route).catch(() => undefined);
    const subscription = this.frames.get(route);
    if (!subscription || !pageId || typeof params.data !== "string") return;
    const metadata = object(params.metadata);
    const frame: EngineFrame = { pageId, data: params.data, mimeType: "image/jpeg",
      width: Number(metadata.deviceWidth) || 0, height: Number(metadata.deviceHeight) || 0, timestamp: Number(metadata.timestamp) || Date.now() / 1000 };
    subscription.last = frame;
    for (const listener of subscription.listeners) this.deliver(subscription, listener, frame);
  }

  private deliver(subscription: FrameSubscription, listener: (frame: EngineFrame) => void | Promise<void>, frame: EngineFrame): void {
    if (subscription.busy.has(listener)) { subscription.latest.set(listener, frame); return; }
    subscription.busy.add(listener);
    void Promise.resolve().then(() => listener(frame)).catch(() => undefined).finally(() => {
      subscription.busy.delete(listener);
      const next = subscription.latest.get(listener);
      if (next && subscription.listeners.has(listener)) { subscription.latest.delete(listener); this.deliver(subscription, listener, next); }
    });
  }

  async operatorInput(route: string, input: EngineOperatorInput): Promise<void> {
    const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 100_000;
    const modifiers = (value: unknown) => value === undefined ? 0 : Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 15 ? Number(value) : invalid();
    if (input.type === "mouse") {
      if (!finite(input.x) || !finite(input.y) || !["move", "down", "up"].includes(input.action)) invalid();
      await this.wire.send("Input.dispatchMouseEvent", { type: input.action === "move" ? "mouseMoved" : input.action === "down" ? "mousePressed" : "mouseReleased",
        x: input.x, y: input.y, button: input.action === "move" ? "none" : input.button ?? "left",
        clickCount: input.action === "move" ? 0 : Math.min(3, Math.max(1, input.clickCount ?? 1)), modifiers: modifiers(input.modifiers) }, route);
    } else if (input.type === "wheel") {
      if (![input.x, input.y, input.deltaX, input.deltaY].every(finite)) invalid();
      await this.wire.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY }, route);
    } else if (input.type === "key") {
      if (typeof input.key !== "string" || !input.key || input.key.length > 32 || (input.text !== undefined && (typeof input.text !== "string" || input.text.length > 8))) invalid();
      await this.wire.send("Input.dispatchKeyEvent", { type: input.action === "down" ? (input.text ? "keyDown" : "rawKeyDown") : "keyUp",
        key: input.key, ...(input.code ? { code: String(input.code).slice(0, 32) } : {}), ...(input.text && input.action === "down" ? { text: input.text } : {}),
        ...(Number.isSafeInteger(input.keyCode) ? { windowsVirtualKeyCode: input.keyCode, nativeVirtualKeyCode: input.keyCode } : {}), modifiers: modifiers(input.modifiers) }, route);
    } else if (input.type === "text") {
      if (typeof input.text !== "string" || !input.text || input.text.length > 4096) invalid();
      await this.wire.send("Input.insertText", { text: input.text }, route);
    } else invalid();
  }

  close(): void {
    this.frames.clear(); this.authenticators.clear(); this.credentials = undefined;
    this.emit({ type: "closed" });
    this.listeners.clear();
  }
}

function invalid(): never { throw new EngineError("invalid_arguments"); }

function validCredential(value: EngineWebAuthnCredential): EngineWebAuthnCredential {
  const base64 = /^[A-Za-z0-9+/_-]+={0,2}$/u;
  if (!value || typeof value.rpId !== "string" || !/^[a-z0-9.-]{1,253}$/iu.test(value.rpId)
    || typeof value.credentialId !== "string" || !base64.test(value.credentialId) || value.credentialId.length > 1024
    || typeof value.privateKey !== "string" || !base64.test(value.privateKey) || value.privateKey.length > 8192
    || (value.userHandle !== undefined && (typeof value.userHandle !== "string" || !base64.test(value.userHandle) || value.userHandle.length > 1024))
    || !Number.isSafeInteger(value.signCount) || value.signCount < 0) invalid();
  return { rpId: value.rpId, credentialId: value.credentialId, privateKey: value.privateKey, ...(value.userHandle ? { userHandle: value.userHandle } : {}), signCount: value.signCount };
}

function cdpCredential(credential: EngineWebAuthnCredential): RecordValue {
  return { credentialId: credential.credentialId, isResidentCredential: true, rpId: credential.rpId, privateKey: credential.privateKey,
    ...(credential.userHandle ? { userHandle: credential.userHandle } : {}), signCount: credential.signCount };
}

function fromCdpCredential(raw: RecordValue): EngineWebAuthnCredential | undefined {
  try {
    return validCredential({ rpId: string(raw.rpId), credentialId: string(raw.credentialId), privateKey: string(raw.privateKey),
      ...(typeof raw.userHandle === "string" && raw.userHandle ? { userHandle: raw.userHandle } : {}), signCount: Number(raw.signCount) || 0 });
  } catch { return undefined; }
}
