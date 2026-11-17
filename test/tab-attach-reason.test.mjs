import test from "node:test";
import assert from "node:assert/strict";
import { chromeReason, TabClaims } from "../apps/tab-adapter/src/claims.ts";
import { EngineHost } from "../apps/mcp-server/src/browser-runtime/engine-host.ts";

test("a refused attach keeps Chrome's reason, without page paths", async () => {
  const api = {
    async attach() { throw new Error("Cannot access a chrome-extension:// URL of different extension"); },
    async detach() {}, async sendCommand() { return {}; },
  };
  const authority = new TabClaims(api, "epoch");
  const owner = authority.bindPort();
  await assert.rejects(authority.claim(owner, 7), error => error.message === "attach_failed"
    && error.detail === "Cannot access a chrome-extension:// URL of different extension");
  assert.equal(authority.isClaimed(7), false);
  assert.equal(chromeReason(new Error("Cannot access contents of url \"https://pay.example/checkout/c1?token=secret\".")),
    "Cannot access contents of url \"https://pay.example\".");
  assert.equal(chromeReason(undefined), undefined);
});

test("browser.session.start on an existing tab names Chrome's reason when the attach is refused", async () => {
  const host = new EngineHost(async () => { throw Error("standalone_forbidden"); },
    async () => { throw Object.assign(new Error("attach_failed"), { detail: "Another debugger is already attached to the tab with id: 7." }); });
  try {
    await assert.rejects(host.start({ mode: "existing", target: { kind: "tab", tabId: 7, instanceId: "epoch" } }),
      error => error.code === "browser_launch_failed" && error.phase === "attach_failed"
        && error.detail === "Another debugger is already attached to the tab with id: 7.");
  } finally { await host.close(); }
});

test("a command on a tab Chrome detached says so, with Chrome's reason", async () => {
  const { existingPageConnection } = await import("../apps/mcp-server/src/existing-page-family.ts");
  const listeners = [];
  const client = { hello: { capabilities: [] }, signal: new AbortController().signal, close() {},
    onEvent(listener) { listeners.push(listener); return () => {}; }, async call() { return {}; } };
  const root = { tabId: 7, epoch: "epoch", generation: 1 };
  const connection = existingPageConnection(client, root, []);
  for (const listener of listeners) listener({ type: "event", token: root, event: { method: "Newton.pageClosed", params: { reason: "target_closed" }, sessionId: null } });
  await assert.rejects(connection.wire.send("Page.getFrameTree", {}, "tab_7"),
    error => error.code === "connection_lost" && error.detail === "Chrome detached the debugger from this tab (target_closed).");
});
