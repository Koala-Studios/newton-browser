import fs from "node:fs";
import path from "node:path";

export function resolvePnpmInvocation(options = {}) {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const hasExplicitNpmExecPath = Object.hasOwn(options, "npmExecPath");
  const npmExecPath = hasExplicitNpmExecPath ? options.npmExecPath : process.env.npm_execpath;
  if (typeof npmExecPath === "string" && npmExecPath.length > 0) {
    if (hasExplicitNpmExecPath || regularAbsoluteFileExists(npmExecPath, "release_pnpm_execpath_invalid")) {
      requireRegularAbsoluteFile(npmExecPath, "release_pnpm_execpath_invalid");
      return Object.freeze({ command: execPath, argsPrefix: Object.freeze([npmExecPath]) });
    }
  }
  if (platform === "win32") {
    const pnpmHome = options.pnpmHome ?? process.env.PNPM_HOME;
    const entrypoint = typeof pnpmHome === "string" && pnpmHome.length > 0
      ? path.resolve(pnpmHome, "..", "pnpm", "bin", "pnpm.cjs")
      : path.join(path.dirname(execPath), "node_modules", "pnpm", "bin", "pnpm.cjs");
    requireRegularAbsoluteFile(entrypoint, "release_pnpm_entrypoint_missing");
    return Object.freeze({ command: execPath, argsPrefix: Object.freeze([entrypoint]) });
  }
  return Object.freeze({ command: "pnpm", argsPrefix: Object.freeze([]) });
}

function regularAbsoluteFileExists(value, code) {
  if (!path.isAbsolute(value) || value.includes("\0")) throw new Error(code);
  try {
    const stat = fs.lstatSync(value);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(code);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw new Error(code);
  }
}

function requireRegularAbsoluteFile(value, code) {
  if (!path.isAbsolute(value) || value.includes("\0")) throw new Error(code);
  const stat = fs.lstatSync(value);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(code);
}
