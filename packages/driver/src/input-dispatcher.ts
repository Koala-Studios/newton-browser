type ModifierKey = "Alt" | "Control" | "Meta" | "Shift";
type MouseButton = "left" | "right" | "middle" | "back" | "forward";
export type InputRoute = { sessionId?: string | null; timeoutMs?: number };
type PointInput = { x?: unknown; y?: unknown };
type CdpParams = Record<string, unknown>;
type InputSend = (method: string, params: CdpParams, route: InputRoute) => unknown | PromiseLike<unknown>;

const MODIFIER_BITS: Readonly<Record<ModifierKey, number>> = Object.freeze({ Alt: 1, Control: 2, Meta: 4, Shift: 8 });
const MOUSE_BUTTON_BITS: Readonly<Record<MouseButton, number>> = Object.freeze({ left: 1, right: 2, middle: 4, back: 8, forward: 16 });

type NamedKey = Readonly<{ code: string; vk: number; text?: string }>;

const NAMED_KEYS: Readonly<Record<string, NamedKey>> = Object.freeze({
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
  Insert: { code: "Insert", vk: 45 },
  Space: { code: "Space", vk: 32, text: " " },
});

const KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  AltGraph: "Alt",
  Cmd: "Meta",
  Command: "Meta",
  Ctrl: "Control",
  Del: "Delete",
  Down: "ArrowDown",
  Esc: "Escape",
  Left: "ArrowLeft",
  Option: "Alt",
  Return: "Enter",
  Right: "ArrowRight",
  Up: "ArrowUp",
  " ": "Space",
});

const PRINTABLE_CODES: Readonly<Record<string, readonly [string, number]>> = Object.freeze({
  "-": ["Minus", 189], "=": ["Equal", 187], "[": ["BracketLeft", 219], "]": ["BracketRight", 221],
  "\\": ["Backslash", 220], ";": ["Semicolon", 186], "'": ["Quote", 222], "`": ["Backquote", 192],
  ",": ["Comma", 188], ".": ["Period", 190], "/": ["Slash", 191],
});

export type KeyDescriptor = {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
  modifiers: number;
  text?: string;
  unmodifiedText?: string;
};

export class InputDispatcher {
  readonly send: InputSend;
  private activeScope: InputScope | null = null;
  private readonly idleWaiters = new Set<() => void>();

  constructor(send: InputSend) {
    if (typeof send !== "function") throw new Error("input_send_required");
    this.send = send;
  }

  async run<T>(route: InputRoute | null | undefined, operation: (input: InputScope) => T | PromiseLike<T>): Promise<T> {
    if (this.activeScope) throw new Error("input_dispatch_already_active");
    if (typeof operation !== "function") throw new Error("input_operation_required");
    const scope = new InputScope(this.send, route);
    this.activeScope = scope;
    let failure: unknown = null;
    try {
      return await operation(scope);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const cleanupErrors = await scope.releaseAll();
      this.activeScope = null;
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
      if (cleanupErrors.length > 0) {
        if (failure && typeof failure === "object") {
          Object.defineProperty(failure, "inputCleanupErrors", { value: cleanupErrors, enumerable: false });
        } else {
          throw Object.assign(new Error("input_cleanup_failed"), {
            code: "input_cleanup_failed",
            cleanupErrors,
          });
        }
      }
    }
  }

  whenIdle(): Promise<void> {
    if (!this.activeScope) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }
}

export type PendingDialog = Readonly<{
  dialogType: string;
  message: string;
  defaultPrompt?: string;
}>;

type DialogEvent = { type?: unknown; message?: unknown; defaultPrompt?: unknown };
type DialogWaiter = { commandId: string; resolve: (dialog: PendingDialog) => void };
type DialogTarget = { pending: PendingDialog | null; waiters: Set<DialogWaiter> };
type DialogTrackerOptions = { maxTargets?: unknown; maxWaitersPerTarget?: unknown };

export type DialogRaceResult<T> = { kind: "effect"; value: T } | { kind: "dialog"; dialog: PendingDialog };

export class DialogTracker {
  readonly maxTargets: number;
  readonly maxWaitersPerTarget: number;
  private readonly targets = new Map<string, DialogTarget>();

  constructor({ maxTargets = 64, maxWaitersPerTarget = 8 }: DialogTrackerOptions = {}) {
    this.maxTargets = positiveBound(maxTargets, 64);
    this.maxWaitersPerTarget = positiveBound(maxWaitersPerTarget, 8);
  }

  open(targetKey: unknown, event: DialogEvent | null | undefined = {}): PendingDialog {
    const target = this.target(targetKey, true);
    target.pending = Object.freeze({
      dialogType: String(event?.type ?? "alert").slice(0, 32),
      message: String(event?.message ?? "").slice(0, 500),
      ...(event?.type === "prompt" ? { defaultPrompt: String(event?.defaultPrompt ?? "").slice(0, 500) } : {}),
    });
    for (const waiter of target.waiters) waiter.resolve(target.pending);
    target.waiters.clear();
    return target.pending;
  }

  close(targetKey: unknown): boolean {
    const target = this.target(targetKey, false);
    if (!target) return false;
    target.pending = null;
    if (target.waiters.size === 0) this.targets.delete(String(targetKey));
    return true;
  }

  pending(targetKey: unknown): PendingDialog | null {
    return this.target(targetKey, false)?.pending ?? null;
  }

  async race<T>(targetKey: unknown, commandId: unknown, dispatch: () => T | PromiseLike<T>): Promise<DialogRaceResult<T>> {
    if (typeof dispatch !== "function") throw new Error("input_dispatch_required");
    const target = this.target(targetKey, true);
    if (target.pending) return { kind: "dialog", dialog: target.pending };
    if (target.waiters.size >= this.maxWaitersPerTarget) throw new Error("dialog_waiter_limit");
    const deferred = createDialogWaiter(commandId);
    target.waiters.add(deferred.waiter);
    let effect: Promise<T> | undefined;
    try {
      effect = Promise.resolve().then(dispatch);
      const result = await Promise.race<DialogRaceResult<T>>([
        effect.then((value) => ({ kind: "effect", value })),
        deferred.promise.then((dialog) => ({ kind: "dialog", dialog })),
      ]);
      if (result.kind === "dialog") void effect.catch(() => {});
      return result;
    } finally {
      target.waiters.delete(deferred.waiter);
      if (!target.pending && target.waiters.size === 0) this.targets.delete(String(targetKey));
    }
  }

  private target(targetKey: unknown, create: true): DialogTarget;
  private target(targetKey: unknown, create: false): DialogTarget | null;
  private target(targetKey: unknown, create: boolean): DialogTarget | null;
  private target(targetKey: unknown, create: boolean): DialogTarget | null {
    const key = String(targetKey ?? "").trim();
    if (!key || key.length > 160) throw new Error("invalid_dialog_target");
    let target = this.targets.get(key);
    if (!target && create) {
      if (this.targets.size >= this.maxTargets) throw new Error("dialog_target_limit");
      target = { pending: null, waiters: new Set() };
      this.targets.set(key, target);
    }
    return target ?? null;
  }
}

class InputScope {
  private readonly send: InputSend;
  private readonly route: InputRoute;
  private point = { x: 0, y: 0 };
  private readonly pressedButtons: MouseButton[] = [];
  private readonly pressedModifiers: ModifierKey[] = [];

  constructor(send: InputSend, route: InputRoute | null | undefined) {
    this.send = send;
    this.route = route ?? {};
  }

  modifierMask(): number {
    return this.pressedModifiers.reduce((mask, key) => mask | MODIFIER_BITS[key], 0);
  }

  buttonMask(): number {
    return this.pressedButtons.reduce((mask, button) => mask | MOUSE_BUTTON_BITS[button], 0);
  }

  async pointerMove(point: PointInput | null | undefined): Promise<void> {
    this.point = normalizePoint(point);
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseMoved", ...this.point, button: "none", buttons: this.buttonMask(),
      modifiers: this.modifierMask(), pointerType: "mouse",
    }, this.route);
  }

  async wheel(point: PointInput | null | undefined, delta: { x?: unknown; y?: unknown } | null | undefined = {}): Promise<void> {
    const next = normalizePoint(point);
    this.point = next;
    const deltaX = Number(delta?.x ?? 0);
    const deltaY = Number(delta?.y ?? 0);
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) throw new Error("invalid_wheel_delta");
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", ...next, deltaX, deltaY, modifiers: this.modifierMask(), pointerType: "mouse",
    }, this.route);
  }

  async mouseDown(button: unknown = "left", clickCount: unknown = 1): Promise<void> {
    const normalized = normalizeButton(button);
    if (this.pressedButtons.includes(normalized)) throw new Error("input_button_already_pressed");
    this.pressedButtons.push(normalized);
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed", ...this.point, button: normalized, buttons: this.buttonMask(),
      clickCount: boundedClickCount(clickCount), modifiers: this.modifierMask(), pointerType: "mouse",
    }, this.route);
  }

  async mouseUp(button: unknown = "left", clickCount: unknown = 1): Promise<void> {
    const normalized = normalizeButton(button);
    const index = this.pressedButtons.lastIndexOf(normalized);
    if (index >= 0) this.pressedButtons.splice(index, 1);
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", ...this.point, button: normalized, buttons: this.buttonMask(),
      clickCount: boundedClickCount(clickCount), modifiers: this.modifierMask(), pointerType: "mouse",
    }, this.route);
  }

  async insertText(text: unknown): Promise<void> {
    await this.send("Input.insertText", { text: String(text ?? "") }, this.route);
  }

  async keyDown(input: unknown): Promise<KeyDescriptor> {
    const key = normalizeKey(input);
    const modifier = isModifierKey(key);
    if (modifier && !this.pressedModifiers.includes(key)) this.pressedModifiers.push(key);
    const descriptor = keyDescriptor(key, this.modifierMask());
    const suppressText = Boolean(this.modifierMask() & (MODIFIER_BITS.Alt | MODIFIER_BITS.Control | MODIFIER_BITS.Meta));
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...(suppressText ? withoutText(descriptor) : descriptor) }, this.route);
    return descriptor;
  }

  async keyUp(input: unknown): Promise<void> {
    const key = normalizeKey(input);
    const descriptor = keyDescriptor(key, this.modifierMask());
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...withoutText(descriptor) }, this.route);
    if (isModifierKey(key)) {
      const index = this.pressedModifiers.lastIndexOf(key);
      if (index >= 0) this.pressedModifiers.splice(index, 1);
    }
  }

  async keyPress(input: unknown): Promise<void> {
    const descriptor = await this.keyDown(input);
    try {
      const suppressText = Boolean(this.modifierMask() & (MODIFIER_BITS.Alt | MODIFIER_BITS.Control | MODIFIER_BITS.Meta));
      if (descriptor.text && !suppressText) {
        await this.send("Input.dispatchKeyEvent", { type: "char", ...descriptor }, this.route);
      }
    } finally {
      await this.keyUp(input);
    }
  }

  async chord(inputs: unknown): Promise<void> {
    const keys = (Array.isArray(inputs) ? inputs : [inputs]).map(normalizeKey).filter(Boolean);
    if (keys.length === 0) throw new Error("input_keys_required");
    const modifiers = keys.filter(isModifierKey);
    const ordinary = keys.filter((key) => !isModifierKey(key));
    for (const modifier of modifiers) await this.keyDown(modifier);
    try {
      if (ordinary.length === 0) return;
      for (const key of ordinary) await this.keyPress(key);
    } finally {
      for (const modifier of [...modifiers].reverse()) await this.keyUp(modifier);
    }
  }

  async releaseAll(): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const button of [...this.pressedButtons].reverse()) {
      try { await this.mouseUp(button); } catch (error) { errors.push(error); }
    }
    for (const modifier of [...this.pressedModifiers].reverse()) {
      try { await this.keyUp(modifier); } catch (error) { errors.push(error); }
    }
    this.pressedButtons.length = 0;
    this.pressedModifiers.length = 0;
    return errors;
  }
}

export function keyDescriptor(input: unknown, modifiers = 0): KeyDescriptor {
  const key = normalizeKey(input);
  if (isModifierKey(key)) {
    const vk = key === "Alt" ? 18 : key === "Control" ? 17 : key === "Meta" ? 91 : 16;
    return { key, code: `${key}Left`, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  }
  if (/^F(?:[1-9]|1\d|2[0-4])$/.test(key)) {
    const number = Number(key.slice(1));
    const vk = 111 + number;
    return { key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  }
  const named = NAMED_KEYS[key];
  if (named) {
    return {
      key, code: named.code, windowsVirtualKeyCode: named.vk, nativeVirtualKeyCode: named.vk,
      modifiers, ...(named.text ? { text: named.text, unmodifiedText: named.text } : {}),
    };
  }
  if (key.length !== 1) throw new Error("unsupported_key");
  const shifted = Boolean(modifiers & MODIFIER_BITS.Shift);
  const printableKey = shifted && /^[a-z]$/.test(key) ? key.toUpperCase() : key;
  const upper = printableKey.toUpperCase();
  const alpha = /^[A-Z]$/.test(upper);
  const digit = /^\d$/.test(printableKey);
  const printable = PRINTABLE_CODES[printableKey];
  const code = alpha ? `Key${upper}` : digit ? `Digit${printableKey}` : printable?.[0] ?? "Unidentified";
  const vk = alpha ? upper.charCodeAt(0) : digit ? printableKey.charCodeAt(0) : printable?.[1] ?? printableKey.codePointAt(0) ?? 0;
  return {
    key: printableKey, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers,
    text: printableKey, unmodifiedText: key,
  };
}

export function normalizeKey(input: unknown): string {
  const raw = String(input ?? "");
  return KEY_ALIASES[raw] ?? raw;
}

function withoutText(descriptor: KeyDescriptor): Omit<KeyDescriptor, "text" | "unmodifiedText"> {
  const { text: _text, unmodifiedText: _unmodifiedText, ...rest } = descriptor;
  return rest;
}

function normalizePoint(point: PointInput | null | undefined): { x: number; y: number } {
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("invalid_pointer_point");
  return { x, y };
}

function normalizeButton(button: unknown): MouseButton {
  const normalized = String(button ?? "left").toLowerCase();
  switch (normalized) {
    case "left":
    case "right":
    case "middle":
    case "back":
    case "forward":
      return normalized;
    default:
      throw new Error("unsupported_mouse_button");
  }
}

function isModifierKey(key: string): key is ModifierKey {
  return key === "Alt" || key === "Control" || key === "Meta" || key === "Shift";
}

function boundedClickCount(value: unknown): number {
  const count = Number(value);
  return Number.isInteger(count) && count >= 1 && count <= 3 ? count : 1;
}

function positiveBound(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function boundedCommandId(value: unknown): string {
  return String(value ?? "").slice(0, 160);
}

function createDialogWaiter(commandId: unknown): { waiter: DialogWaiter; promise: Promise<PendingDialog> } {
  let resolveDialog: ((dialog: PendingDialog) => void) | undefined;
  const promise = new Promise<PendingDialog>((resolve) => { resolveDialog = resolve; });
  if (!resolveDialog) throw new Error("dialog_waiter_initialization_failed");
  return { waiter: { commandId: boundedCommandId(commandId), resolve: resolveDialog }, promise };
}
