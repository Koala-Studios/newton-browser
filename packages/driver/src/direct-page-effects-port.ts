import type { PageEffectsPort } from "./types.ts";

export type RootSessionCdpSender = (
  method: string,
  params: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

export type DirectPageEffectsPortOptions = Readonly<{
  syntheticTabId: number;
  sendRootCommand: RootSessionCdpSender;
}>;

/**
 * Cosmetic pointer/field effects are intentionally no-ops in the direct runtime.
 * Sensitive screenshot zones are handled after capture in the trusted Node raster
 * pipeline and never delegated to page-controlled DOM/CSS.
 */
export function createDirectPageEffectsPort(options: DirectPageEffectsPortOptions): PageEffectsPort {
  if (!Number.isSafeInteger(options.syntheticTabId) || options.syntheticTabId < 0
    || typeof options.sendRootCommand !== "function") {
    throw new Error("direct_page_effects_invalid_configuration");
  }

  const noop = async (): Promise<void> => {};
  return {
    begin: noop,
    end: noop,
    scroll: noop,
    move: noop,
    click: noop,
    field: noop,
  };
}
