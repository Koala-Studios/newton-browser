import { LoginSource } from '../apps/mcp-server/src/browser-runtime/login-source.ts';
import { openProfileStore } from '../apps/mcp-server/src/browser-runtime/profile-store.ts';
const [storeRoot,metadataRoot,executablePath,family,cutpoint]=process.argv.slice(2);
const source=await LoginSource.open(openProfileStore(storeRoot),metadataRoot,'shared',family);
const runtime=await source.beginMaintenance(executablePath);
await source.publish(runtime,async stage=>{if(stage===cutpoint)process.exit(77);});
