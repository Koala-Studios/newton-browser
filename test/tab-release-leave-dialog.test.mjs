import test from "node:test";
import assert from "node:assert/strict";
import { TabClaims } from "../apps/tab-adapter/src/claims.ts";

// A debugger whose commands are recorded; `answer` decides each command's result.
function recordingDebugger({ answer = async () => ({}), detach = async () => {} } = {}) {
  const sent = [];
  const detached = [];
  const order = [];
  return {
    sent,
    detached,
    order,
    api: {
      async attach() {},
      async detach(target) { detached.push(target.tabId); order.push("detach"); return detach(target); },
      sendCommand(target, method, params) { sent.push({ tabId: target.tabId, method, params }); order.push(method); return answer(target, method, params); },
    },
  };
}

test("closing a created tab answers its Leave site? dialog instead of hanging release", async () => {
  let authority;
  let closeTab;
  const debug = recordingDebugger({
    answer: async (target, method, params) => {
      if (method === "Page.handleJavaScriptDialog" && params.accept === true) closeTab();
      return {};
    },
  });
  authority = new TabClaims(debug.api, "epoch");
  const owner = authority.bindPort();
  // tabs.remove runs the page's unload handlers: the dialog opens and the tab closes only once it is answered.
  const tabs = {
    async create() { return { id: 7 }; },
    remove(tabId) {
      return new Promise((resolve) => {
        closeTab = () => { authority.detached(tabId); resolve(); };
        authority.event(tabId, "Page.javascriptDialogOpening", { type: "beforeunload", message: "" });
      });
    },
  };
  const token = await authority.createTab(owner, tabs);
  await authority.release(owner, token, tabs);
  assert.ok(debug.sent.some(({ method, params }) => method === "Page.handleJavaScriptDialog" && params.accept === true));
  assert.equal(authority.isClaimed(7), false);
});

test("a created tab that will not close is released open within the close limit", async () => {
  const debug = recordingDebugger();
  const authority = new TabClaims(debug.api, "epoch", { closeLimitMs: 50 });
  const owner = authority.bindPort();
  const tabs = { async create() { return { id: 8 }; }, remove: () => new Promise(() => {}) };
  const token = await authority.createTab(owner, tabs);
  await authority.release(owner, token, tabs);
  assert.equal(authority.isClaimed(8), false, "the tab is no longer held");
  assert.deepEqual(debug.detached, [8]);
  const next = authority.bindPort();
  await authority.release(next, await authority.claim(next, 8));
});

test("releasing a kept tab dismisses a Leave site? the session raised, staying on the page", async () => {
  const debug = recordingDebugger();
  const authority = new TabClaims(debug.api, "epoch");
  const owner = authority.bindPort();
  const token = await authority.claim(owner, 9);
  authority.event(9, "Page.javascriptDialogOpening", { type: "beforeunload", message: "" });
  await authority.release(owner, token);
  const answer = debug.sent.find(({ method }) => method === "Page.handleJavaScriptDialog");
  assert.deepEqual(answer?.params, { accept: false });
  assert.deepEqual(debug.order, ["Page.handleJavaScriptDialog", "detach"], "answered before the debugger leaves");
});

test("releasing a kept tab leaves its other dialogs open", async () => {
  const debug = recordingDebugger();
  const authority = new TabClaims(debug.api, "epoch");
  const owner = authority.bindPort();
  const token = await authority.claim(owner, 10);
  authority.event(10, "Page.javascriptDialogOpening", { type: "prompt", message: "" });
  authority.event(11, "Page.javascriptDialogOpening", { type: "beforeunload", message: "" });
  await authority.release(owner, token);
  assert.equal(debug.sent.some(({ method }) => method === "Page.handleJavaScriptDialog"), false);
});

test("a disconnecting client's Leave site? on a kept tab is dismissed too", async () => {
  const debug = recordingDebugger();
  const authority = new TabClaims(debug.api, "epoch");
  const owner = authority.bindPort();
  await authority.claim(owner, 12);
  authority.event(12, "Page.javascriptDialogOpening", { type: "beforeunload", message: "" });
  authority.event(12, "Page.javascriptDialogClosed", { result: false });
  authority.event(12, "Page.javascriptDialogOpening", { type: "beforeunload", message: "" });
  await authority.disconnect(owner);
  assert.equal(debug.sent.filter(({ method }) => method === "Page.handleJavaScriptDialog").length, 1);
  assert.equal(authority.isClaimed(12), false);
});

test("a quarantined claim ends when the browser reports the tab detached", async () => {
  const debug = recordingDebugger({ detach: async () => { throw new Error("detach_rejected"); } });
  const authority = new TabClaims(debug.api, "epoch");
  const owner = authority.bindPort();
  const token = await authority.claim(owner, 13);
  await assert.rejects(authority.release(owner, token), /detach_failed/);
  assert.equal(authority.isClaimed(13), true, "quarantined while detach is unproven");
  authority.detached(13);
  assert.equal(authority.isClaimed(13), false);
  const next = authority.bindPort();
  await authority.claim(next, 13);
});

test("a quarantined claim ends when its slow detach completes", async () => {
  let finish;
  let calls = 0;
  const debug = recordingDebugger({
    detach: () => { calls += 1; return calls === 1 ? new Promise((resolve) => { finish = resolve; }) : Promise.reject(new Error("detach_rejected")); },
  });
  const authority = new TabClaims(debug.api, "epoch");
  const owner = authority.bindPort();
  const token = await authority.claim(owner, 14);
  await assert.rejects(authority.release(owner, token), /detach_failed/);
  assert.equal(authority.isClaimed(14), true);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(authority.isClaimed(14), false);
});

test("a tab the browser closes during release is not quarantined", async () => {
  let authority;
  const debug = recordingDebugger({ detach: async (target) => { authority.detached(target.tabId); throw new Error("not_attached"); } });
  authority = new TabClaims(debug.api, "epoch");
  const owner = authority.bindPort();
  const token = await authority.claim(owner, 15);
  await authority.release(owner, token);
  assert.equal(authority.isClaimed(15), false);
});
