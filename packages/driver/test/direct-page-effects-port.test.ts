import assert from "node:assert/strict";
import test from "node:test";

import { createDirectPageEffectsPort } from "../src/direct-page-effects-port.ts";

test("cosmetic effects are no-ops without CDP", async () => {
  const calls: unknown[] = [];
  const port = createDirectPageEffectsPort({
    syntheticTabId: 7,
    sendRootCommand: async (...args) => { calls.push(args); return {}; },
  });

  await port.begin(7, { ownerLabel: "owner" });
  await port.scroll(7, 10);
  await port.move(7, { x: 1, y: 2 });
  await port.click(7, { x: 1, y: 2 });
  await port.field(7, { x: 1, y: 2, width: 3, height: 4 });
  await port.end(7);

  assert.deepEqual(calls, []);
});

test("hostile page-derived details cannot reach CDP through cosmetic effects", async () => {
  const secret = "PAGE_SECRET_CARD_4111111111111111";
  let called = false;
  const port = createDirectPageEffectsPort({
    syntheticTabId: 9,
    sendRootCommand: async () => { called = true; throw new Error(secret); },
  });

  await port.begin(9, {});
  assert.equal(called, false);
});

test("configuration remains strict even though page-owned effects are disabled", () => {
  const sendRootCommand = async () => ({});
  assert.throws(
    () => createDirectPageEffectsPort({ syntheticTabId: -1, sendRootCommand }),
    /direct_page_effects_invalid_configuration/u,
  );
  assert.throws(
    () => createDirectPageEffectsPort({ syntheticTabId: 1, sendRootCommand: null as never }),
    /direct_page_effects_invalid_configuration/u,
  );
});
