import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { temporaryRoot } from '../../scripts/prototypes/support.mjs';
import { discoverBrowserExecutable } from '../../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import { openProfileStore, listNewtonIdentities } from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
import { LoginSource } from '../../apps/mcp-server/src/browser-runtime/login-source.ts';

// Audit D8: publishing or cancelling sign-in maintenance leaves only the published generation.
test('login source maintenance leaves no staging identity after publish or cancel', async () => {
  const temp = temporaryRoot('login-source-lifecycle');
  try {
    const store = openProfileStore(`${temp.root}/identities`);
    const source = await LoginSource.open(store, path.join(temp.root, 'login-sources'), 'shared', 'chrome');
    const executable = discoverBrowserExecutable({ family: 'chrome' }).path;
    const first = await source.beginMaintenance(executable);
    assert.equal(listNewtonIdentities(store).length, 1);
    const generation = await source.publish(first);
    assert.deepEqual(listNewtonIdentities(store).map(identity => identity.id), [generation.identityId]);
    const second = await source.beginMaintenance(executable);
    assert.equal(listNewtonIdentities(store).length, 2);
    await source.cancelMaintenance(second);
    assert.deepEqual(listNewtonIdentities(store).map(identity => identity.id), [generation.identityId]);
  } finally { temp.remove(); }
});
