import { buildNativeRuntime } from "./native-artifacts.ts";

export {hashNativeFile} from "./native-file.ts";

export async function ensureNativeRuntimeBuild(
  root: string,
  entry: Buffer,
  runtime: string,
): Promise<{ digest: string; directory: string; }> {
  const runtimeName = process.platform === "win32" ? "node.exe" : process.platform === "linux" || process.platform === "darwin" ? "node" : null;
  if (runtimeName === null) throw new Error("native_install_arguments");
  return buildNativeRuntime(root, entry, runtime, runtimeName);
}
