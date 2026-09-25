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

function fixture() {
  const detached = [];
  let attach = async () => {};
  const authority = new TabClaims({
    attach: (target) => attach(target),
    detach: async (target) => { detached.push(target.tabId); },
    sendCommand: async () => ({}),
  }, "epoch");
  return {
    authority,
    detached,
    setAttach(next) { attach = next; },
  };
}

test("failed popup attach removes only the failed child reservation", async () => {
  const { authority, detached, setAttach } = fixture();
  const owner = authority.bindPort();
  await authority.claim(owner, 1);
  setAttach(async ({ tabId }) => {
    if (tabId === 2) throw new Error("debugger_attach_failed");
  });

  await assert.rejects(authority.claimPopup(2, 1), /attach_failed/);
  assert.equal(authority.isClaimed(1), true);
  assert.equal(authority.isClaimed(2), false);
  assert.deepEqual(detached, []);

  setAttach(async () => {});
  const child = await authority.claimPopup(2, 1);
  assert.equal(child.token.tabId, 2);
  await authority.disconnect(owner);
});

test("disconnect waits for a pending child attach and revokes opener and child", async () => {
  const { authority, detached, setAttach } = fixture();
  const owner = authority.bindPort();
  await authority.claim(owner, 1);
  const attachGate = deferred();
  setAttach(() => attachGate.promise);
  const child = authority.claimPopup(2, 1);
  const disconnecting = authority.disconnect(owner);

  assert.equal(authority.isClaimed(2), true);
  attachGate.resolve();
  const [childResult, disconnectResult] = await Promise.allSettled([child, disconnecting]);
  assert.equal(childResult.status, "rejected");
  assert.match(childResult.reason.message, /claim_revoked/);
  assert.equal(disconnectResult.status, "fulfilled");
  assert.equal(authority.isClaimed(1), false);
  assert.equal(authority.isClaimed(2), false);
  assert.ok(detached.includes(1));
  assert.ok(detached.includes(2));
});

test("already-owned popup refusal leaves both existing owners usable", async () => {
  const { authority } = fixture();
  const openerOwner = authority.bindPort();
  const childOwner = authority.bindPort();
  const opener = await authority.claim(openerOwner, 1);
  const child = await authority.claim(childOwner, 2);

  await assert.rejects(authority.claimPopup(2, 1), /tab_owned/);
  assert.equal(authority.isClaimed(1), true);
  assert.equal(authority.isClaimed(2), true);
  assert.deepEqual(await authority.command(openerOwner, opener, "DOM.getDocument", {}), {});
  assert.deepEqual(await authority.command(childOwner, child, "DOM.getDocument", {}), {});
  await authority.disconnect(openerOwner);
  assert.equal(authority.isClaimed(2), true);
  await authority.disconnect(childOwner);
});

test("capacity rejects a popup without disturbing the opener and quiescence rejects new claims", async () => {
  const { authority } = fixture();
  const owner = authority.bindPort();
  const opener = await authority.claim(owner, 1);
  for (let tabId = 2; tabId <= 32; tabId += 1) await authority.claim(owner, tabId);

  await assert.rejects(authority.claimPopup(33, 1), /claim_capacity/);
  assert.equal(authority.isClaimed(1), true);
  assert.equal(authority.isClaimed(33), false);
  assert.deepEqual(await authority.command(owner, opener, "DOM.getDocument", {}), {});
  await authority.disconnect(owner);

  const quiescedOwner = authority.bindPort();
  await authority.claim(quiescedOwner, 40);
  await authority.quiesce();
  assert.equal(authority.isClaimed(40), false);
  await assert.rejects(authority.claim(quiescedOwner, 41), /connection_closed/);
  assert.equal(await authority.claimPopup(42, 40), undefined);
});
