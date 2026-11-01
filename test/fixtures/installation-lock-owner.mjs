import {acquireInstallationLock} from '../../apps/mcp-server/src/installation-lock.ts';
// Holds the lock until the test kills this process. A child's IPC channel does not keep it alive on its own,
// and on macOS the lock is a file handle that is closed (releasing it) when collected: keep both.
globalThis.installationLock = await acquireInstallationLock(process.argv[2]);
process.on('message', () => {});
process.send('locked');
