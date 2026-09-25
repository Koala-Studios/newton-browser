// Private integration entry, exercised from packed artifacts before the default catalog cutover.
export { EngineHost, ownedEngineConnection } from "./browser-runtime/engine-host.ts";
export { LoginSource } from "./browser-runtime/login-source.ts";
export { connectExistingTab,discoverExistingBrowser } from "./existing-connection.ts";
export {connectNative} from './native-client.ts';
export {developmentUpdateControl} from './adapter-update-control.ts';
export {updateInstalledAdapter,recoverInstalledAdapter} from './adapter-update-transaction.ts';
export {createDefaultEngineHost} from './browser-runtime/default-engine-host.ts';
export { handleMcpMessage } from "./mcp-server.ts";
