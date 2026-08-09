import { runInputReliabilityLive } from "../../test/fixtures/input-reliability/live-harness.mjs";

await runInputReliabilityLive("dialog-renderer-live", async ({ mcp, sessionId, resultOf, statusOf, assert, log }) => {
  const act = (action) => mcp("browser.act", { sessionId, action });
  for (const name of ["Dialog on click", "Same-origin frame dialog", "Cross-origin frame dialog"]) {
    const dialog = await act({ kind: "click", name, exact: true });
    assert(statusOf(dialog) === "dialog_blocked", `${name} did not preserve dialog_blocked`, dialog);
    const dismissed = await act({ kind: "dialog_dismiss" });
    assert(dismissed.ok !== false, `${name} could not be dismissed`, dismissed);
    log("scoped_dialog", { name, status: statusOf(dialog) });
  }

  const frameAck = await act({ kind: "click", name: "Cross-origin frame acknowledgement", exact: true });
  assert(frameAck.ok !== false, "cross-origin frame did not recover after its scoped dialog", frameAck);

  const invalidSelector = await act({ kind: "click", selector: "]" });
  assert(statusOf(invalidSelector) === "invalid_selector", "invalid selector lost its lifecycle category", invalidSelector);
  log("invalid_selector", { status: statusOf(invalidSelector) });

  const observed = resultOf(await mcp("browser.observe", { sessionId, format: "json", query: "Removable target", maxNodes: 80 }));
  const staleRef = (observed.nodes ?? observed.added ?? []).find((node) => node.name === "Removable target")?.ref;
  assert(typeof staleRef === "string", "removable target ref missing", observed);
  const removed = await act({ kind: "click", name: "Remove target", exact: true });
  assert(removed.ok !== false, "fixture target removal failed", removed);
  const stale = await act({ kind: "click", target: { ref: staleRef } });
  assert(["stale_target", "target_gone", "not_found"].includes(statusOf(stale)), "removed target lost its lifecycle category", stale);
  log("target_lifecycle", { status: statusOf(stale) });

  log("production_gap", {
    categories: ["discarded", "debugger_conflict", "renderer_unresponsive"],
    reason: "requires browser-owned lifecycle injection not exposed by the public MCP contract",
  });
}, {
  mainPort: Number(process.env.NEWTON_BROWSER_DIALOG_FIXTURE_PORT ?? 18331),
  crossPort: Number(process.env.NEWTON_BROWSER_DIALOG_CROSS_PORT ?? 18332),
  hostPort: Number(process.env.NEWTON_BROWSER_PORT ?? 17321),
});
