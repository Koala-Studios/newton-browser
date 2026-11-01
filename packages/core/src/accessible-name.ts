// Names as a person reads them. Pages pad labels with invisible format characters (a zero-width space
// before "Reject all") and irregular whitespace, and a model copying a name out of an observation cannot
// reproduce characters it cannot see. Observations show names this way and targets compare them this way.

// Zero-width space, soft hyphen, word joiner, invisible operators, byte-order mark, direction marks and
// bidirectional controls. The zero-width joiner and non-joiner stay in shown names: emoji sequences and
// several scripts need them.
const INVISIBLE = /[­᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]/gu;
const JOINERS = /[‌‍]/gu;

/** A name as it reads: invisible format characters removed, each run of whitespace one space, trimmed. */
export function readableName(value: string): string {
  return value.replace(INVISIBLE, "").replace(/\s+/gu, " ").trim();
}

/** The form two names are compared in: readable, without joiners, composed. */
export function nameKey(value: string): string {
  return readableName(value).replace(JOINERS, "").normalize("NFC");
}

/** Whether a page's name matches a requested one, both read as above: exact is equality, otherwise the
 * requested text appears anywhere in the name, ignoring case. */
export function nameMatches(actual: string, wanted: string, exact: boolean): boolean {
  const name = nameKey(actual), requested = nameKey(wanted);
  return exact ? name === requested : name.toLocaleLowerCase().includes(requested.toLocaleLowerCase());
}

// ARIA subclass roles: an alertdialog is a dialog and a searchbox is a textbox, so asking for the broader
// role also finds them.
const SUBCLASS_ROLES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  dialog: Object.freeze(["alertdialog"]),
  textbox: Object.freeze(["searchbox"]),
  menuitem: Object.freeze(["menuitemcheckbox", "menuitemradio"]),
});

/** The roles a requested role finds: itself and its ARIA subclass roles. */
export function rolesFor(role: string): readonly string[] {
  return Object.hasOwn(SUBCLASS_ROLES, role) ? [role, ...SUBCLASS_ROLES[role]!] : [role];
}
