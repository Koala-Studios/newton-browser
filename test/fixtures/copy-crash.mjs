import { openProfileStore, prepareOpaqueProfileSource, importOpaqueProfile } from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
const [root, sourceRoot] = process.argv.slice(2);
const store = openProfileStore(root); let checks = 0;
const source = prepareOpaqueProfileSource({ browserFamily: 'chrome', userDataRoot: sourceRoot, profileDirectory: 'Default', verifyClosed() {
  if (++checks === 3) process.exit(77); return true;
} });
importOpaqueProfile(store, { source });
