import test from "node:test";
import assert from "node:assert/strict";
import { TabClaims } from "../apps/tab-adapter/src/claims.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function fixture({ sendCommand = async () => ({}), detach = async () => {} } = {}) {
  const detached = [];
  const authority = new TabClaims({
    attach: async () => {},
    detach: (target) => { detached.push(target.tabId); return detach(target); },
    sendCommand,
  }, "epoch");
  return { authority, detached };
}

test("a synchronous debugger command throw rejects cleanly without an unhandled command", async () => {
  const fixtureState = fixture({ sendCommand: () => { throw new Error("command_sync_throw"); } });
  const owner = fixtureState.authority.bindPort();
  const token = await fixtureState.authority.claim(owner, 1);
  await assert.rejects(fixtureState.authority.command(owner, token, "DOM.getDocument", {}), /command_sync_throw/);
  await fixtureState.authority.disconnect(owner);
});

test("release remains pending while detach is pending and does not report false success", async () => {
  const detachGate = deferred();
  const fixtureState = fixture({ detach: () => detachGate.promise });
  const owner = fixtureState.authority.bindPort();
  const token = await fixtureState.authority.claim(owner, 1);
  let released = false;
  const releasing = fixtureState.authority.release(owner, token).then(() => { released = true; });
  await Promise.resolve();

  assert.equal(released, false);
  assert.equal(fixtureState.authority.isClaimed(1), true);
  await assert.rejects(fixtureState.authority.claim(fixtureState.authority.bindPort(), 1), /tab_owned/);
  detachGate.resolve();
  await releasing;
  assert.equal(fixtureState.authority.isClaimed(1), false);
  const replacementOwner = fixtureState.authority.bindPort();
  const replacement = await fixtureState.authority.claim(replacementOwner, 1);
  await fixtureState.authority.release(replacementOwner, replacement);
});

test("detach failure quarantines the claim and rejects pending commands", async () => {
  const commandGate = deferred();
  const fixtureState = fixture({
    sendCommand: () => commandGate.promise,
    detach: async () => { throw new Error("detach_rejected"); },
  });
  const owner = fixtureState.authority.bindPort();
  const token = await fixtureState.authority.claim(owner, 1);
  const pending = fixtureState.authority.command(owner, token, "DOM.getDocument", {});
  await Promise.resolve();
  const [commandResult, releaseResult] = await Promise.allSettled([
    pending,
    fixtureState.authority.release(owner, token),
  ]);

  assert.equal(commandResult.status, "rejected");
  assert.match(commandResult.reason.message, /cleanup_uncertain/);
  assert.equal(releaseResult.status, "rejected");
  assert.match(releaseResult.reason.message, /detach_failed/);
  assert.equal(fixtureState.authority.isClaimed(1), true);
  await assert.rejects(fixtureState.authority.claim(fixtureState.authority.bindPort(), 1), /tab_owned/);
});

test("synchronous detach throw is normalized and quarantines the retired claim", async () => {
  const fixtureState = fixture({ detach: () => { throw new Error("detach_sync_throw"); } });
  const owner = fixtureState.authority.bindPort();
  const token = await fixtureState.authority.claim(owner, 1);

  await assert.rejects(fixtureState.authority.release(owner, token), /detach_failed/);
  assert.equal(fixtureState.authority.isClaimed(1), true);
  await assert.rejects(fixtureState.authority.claim(fixtureState.authority.bindPort(), 1), /tab_owned/);
});

test("detach failure on one tab does not affect an unrelated usable tab", async () => {
  const fixtureState = fixture({ detach: async ({ tabId }) => { if (tabId === 1) throw new Error("detach_rejected"); } });
  const owner = fixtureState.authority.bindPort();
  const first = await fixtureState.authority.claim(owner, 1);
  const second = await fixtureState.authority.claim(owner, 2);

  await assert.rejects(fixtureState.authority.release(owner, first), /detach_failed/);
  assert.deepEqual(await fixtureState.authority.command(owner, second, "DOM.getDocument", {}), {});
  await fixtureState.authority.release(owner, second);
});
