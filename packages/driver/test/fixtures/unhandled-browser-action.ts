import type { BrowserActionKind } from "../../../core/src/protocol.ts";

declare const kind: BrowserActionKind;

switch (kind) {
  case "observe":
  case "screenshot":
  case "click":
  case "fill":
  case "type":
  case "select":
  case "scroll":
  case "navigate":
  case "back":
  case "forward":
  case "reload":
  case "press":
  case "clear":
  case "set_files":
  case "hover":
  case "move":
  case "wait_for":
  case "dialog_accept":
  case "dialog_dismiss":
  case "resize":
  case "fill_form":
  case "console":
    break;
  default:
    assertNever(kind);
}

function assertNever(value: never): never {
  throw new Error(`unhandled action: ${value}`);
}
