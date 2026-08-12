import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type BrowserFamily = "chrome" | "edge";
export type BrowserPlatform = "win32" | "darwin" | "linux";

export type BrowserExecutable = {
  family: BrowserFamily;
  path: string;
  source: "explicit" | "system";
};

export type BrowserDiscoveryInput = {
  family: BrowserFamily;
  explicitPath?: string;
  platform?: BrowserPlatform;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
};

const TRUSTED_LINUX_BROWSER_PREFIXES = ["/opt/google", "/opt/microsoft", "/usr/lib", "/usr/lib64"] as const;

export function browserExecutableCandidates(input: Omit<BrowserDiscoveryInput, "explicitPath">): string[] {
  const platform = input.platform ?? supportedPlatform(process.platform);
  const env = input.env ?? process.env;
  const home = input.homeDirectory ?? os.homedir();
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const suffixes = input.family === "chrome"
      ? [path.win32.join("Google", "Chrome", "Application", "chrome.exe")]
      : [path.win32.join("Microsoft", "Edge", "Application", "msedge.exe")];
    return unique(roots.flatMap((root) => suffixes.map((suffix) => path.win32.resolve(root, suffix))));
  }
  if (platform === "darwin") {
    const application = input.family === "chrome"
      ? path.posix.join("Google Chrome.app", "Contents", "MacOS", "Google Chrome")
      : path.posix.join("Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge");
    return unique([
      path.posix.join("/Applications", application),
      path.posix.join(home, "Applications", application),
    ]);
  }
  return input.family === "chrome"
    ? ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
    : ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "/opt/microsoft/msedge/msedge"];
}

export function discoverBrowserExecutable(input: BrowserDiscoveryInput): BrowserExecutable | null {
  const platform = input.platform ?? supportedPlatform(process.platform);
  if (input.explicitPath !== undefined) {
    return { family: input.family, path: validateExecutable(input.explicitPath, platform, "explicit"), source: "explicit" };
  }
  for (const candidate of browserExecutableCandidates(input)) {
    try {
      return { family: input.family, path: validateExecutable(candidate, platform, "system"), source: "system" };
    } catch (error) {
      if (!isUnavailable(error)) throw error;
    }
  }
  return null;
}

export function trustedLinuxSystemBrowserTarget(linkPath: string, canonicalTarget: string): boolean {
  if (!path.posix.isAbsolute(linkPath) || !path.posix.isAbsolute(canonicalTarget) || !linkPath.startsWith("/usr/bin/")) return false;
  return TRUSTED_LINUX_BROWSER_PREFIXES.some((prefix) => {
    const relative = path.posix.relative(prefix, canonicalTarget);
    return relative.length > 0 && relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative);
  });
}

function validateExecutable(candidate: string, platform: BrowserPlatform, source: BrowserExecutable["source"]): string {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0")) throw new Error("browser_executable_invalid");
  const absolute = path.resolve(candidate);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    throw unavailable(error);
  }
  if (stat.isSymbolicLink()) {
    if (source !== "system" || platform !== "linux") throw new Error("browser_executable_invalid");
    let canonicalTarget: string;
    try {
      canonicalTarget = fs.realpathSync.native(absolute);
    } catch {
      throw new Error("browser_executable_invalid");
    }
    if (!trustedLinuxSystemBrowserTarget(absolute.replaceAll("\\", "/"), canonicalTarget.replaceAll("\\", "/"))) throw new Error("browser_executable_invalid");
    let targetStat: fs.Stats;
    try {
      targetStat = fs.lstatSync(canonicalTarget);
    } catch {
      throw new Error("browser_executable_invalid");
    }
    if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1) throw new Error("browser_executable_invalid");
    try {
      fs.accessSync(canonicalTarget, fs.constants.X_OK);
    } catch {
      throw new Error("browser_executable_not_executable");
    }
    return canonicalTarget;
  }
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("browser_executable_invalid");
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(absolute);
  } catch {
    throw new Error("browser_executable_invalid");
  }
  if (path.resolve(resolved) !== absolute) throw new Error("browser_executable_invalid");
  if (platform !== "win32") {
    try {
      fs.accessSync(resolved, fs.constants.X_OK);
    } catch {
      throw new Error("browser_executable_not_executable");
    }
  } else if (path.win32.extname(resolved).toLowerCase() !== ".exe") {
    throw new Error("browser_executable_not_executable");
  }
  return resolved;
}

function supportedPlatform(value: NodeJS.Platform): BrowserPlatform {
  if (value === "win32" || value === "darwin" || value === "linux") return value;
  throw new Error("browser_platform_unsupported");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function unavailable(cause: unknown): Error & { unavailable: true } {
  const error = new Error("browser_executable_unavailable") as Error & { unavailable: true; cause?: unknown };
  error.unavailable = true;
  error.cause = cause;
  return error;
}

function isUnavailable(error: unknown): error is Error & { unavailable: true } {
  return error instanceof Error && "unavailable" in error && error.unavailable === true;
}
