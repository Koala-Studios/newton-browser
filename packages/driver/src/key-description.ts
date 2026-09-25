/** Pure CDP key descriptions; no dispatch, queue or lifecycle ownership. */
type ModifierKey = "Alt" | "Control" | "Meta" | "Shift";
const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
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

function isModifierKey(key: string): key is ModifierKey {
  return key === "Alt" || key === "Control" || key === "Meta" || key === "Shift";
}
