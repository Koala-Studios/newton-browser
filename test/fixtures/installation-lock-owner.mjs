import {acquireInstallationLock} from '../../apps/mcp-server/src/installation-lock.ts';
await acquireInstallationLock(process.argv[2]);
process.send('locked');
