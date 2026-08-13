import fs from "node:fs";
import path from "node:path";

export function resolvePnpmInvocation(options = {}) {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const npmExecPath = Object.hasOwn(options, "npmExecPath")
    ? options.npmExecPath
    : process.env.npm_execpath;
  if (typeof npmExecPath === "string" && npmExecPath.length > 0) {
    requireRegularAbsoluteFile(npmExecPath, "release_pnpm_execpath_invalid");
    return Object.freeze({ command: execPath, argsPrefix: Object.freeze([npmExecPath]) });
  }
  if (platform === "win32") {
    const entrypoint = path.join(path.dirname(execPath), "node_modules", "pnpm", "bin", "pnpm.cjs");
    requireRegularAbsoluteFile(entrypoint, "release_pnpm_entrypoint_missing");
    return Object.freeze({ command: execPath, argsPrefix: Object.freeze([entrypoint]) });
  }
  return Object.freeze({ command: "pnpm", argsPrefix: Object.freeze([]) });
}

function requireRegularAbsoluteFile(value, code) {
  if (!path.isAbsolute(value) || value.includes("\0")) throw new Error(code);
  const stat = fs.lstatSync(value);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(code);
}
