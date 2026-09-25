import path from "node:path";

export type NativeBrowserFamily = "chrome" | "edge";

export interface NativePlatformLayout {
  runtimeName: "node.exe" | "node";
  launcherName: "native-launcher.exe" | "native-launcher";
  registration: { kind: "registry"; key: string; } | { kind: "file"; path: string; };
}

const MAX_HOST_LENGTH = 100;
const REGISTRY_CHROME = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts";
const REGISTRY_EDGE = "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts";
const HOST_NAME_PATTERN = /^(?:[a-z][a-z0-9_]*)(?:\.[a-z][a-z0-9_]*)*$/u;

export function nativePlatformLayout(input: {
  platform: NodeJS.Platform;
  browser: NativeBrowserFamily;
  hostName: string;
  homeDirectory?: string;
  configDirectory?: string;
}): NativePlatformLayout {
  if (typeof input.hostName !== "string" || typeof input.platform !== "string" || typeof input.browser !== "string") {
    throw new Error("native_install_arguments");
  }
  if (input.hostName.length === 0 || input.hostName.length > MAX_HOST_LENGTH || !HOST_NAME_PATTERN.test(input.hostName)) {
    throw new Error("native_install_arguments");
  }
  if (input.browser !== "chrome" && input.browser !== "edge") throw new Error("native_install_arguments");
  if (input.platform === "win32") {
    return Object.freeze({
      runtimeName: "node.exe",
      launcherName: "native-launcher.exe",
      registration: Object.freeze({
        kind: "registry",
        key: `${input.browser === "chrome" ? REGISTRY_CHROME : REGISTRY_EDGE}\\${input.hostName}`,
      }),
    });
  }
  if (input.platform === "darwin") {
    // Chrome and Edge on macOS read per-user host manifests from their Application Support directories.
    const home = normalizeHome(input.homeDirectory);
    const relative = input.browser === "chrome"
      ? "Library/Application Support/Google/Chrome/NativeMessagingHosts"
      : "Library/Application Support/Microsoft Edge/NativeMessagingHosts";
    return Object.freeze({
      runtimeName: "node",
      launcherName: "native-launcher",
      registration: Object.freeze({ kind: "file", path: path.posix.join(home, relative, `${input.hostName}.json`) }),
    });
  }
  if (input.platform !== "linux") throw new Error("native_install_arguments");

  const configDirectory = input.configDirectory === undefined
    ? normalizeLinuxHomeConfig(input.homeDirectory)
    : validateLinuxConfigDirectory(input.configDirectory);
  const relative = input.browser === "chrome"
    ? "google-chrome/NativeMessagingHosts"
    : "microsoft-edge/NativeMessagingHosts";
  return Object.freeze({
    runtimeName: "node",
    launcherName: "native-launcher",
    registration: Object.freeze({
      kind: "file",
      path: path.posix.join(configDirectory, relative, `${input.hostName}.json`),
    }),
  });
}

function validateLinuxConfigDirectory(configDirectory: unknown): string {
  if (typeof configDirectory !== "string" || !configDirectory.length || configDirectory.includes("\0")) {
    throw new Error("native_install_arguments");
  }
  const normalized = path.posix.normalize(configDirectory);
  if (!path.posix.isAbsolute(normalized) || normalized !== configDirectory || /\/\.\.?(?:\/|$)/.test(normalized)) {
    throw new Error("native_install_arguments");
  }
  return normalized;
}

function normalizeLinuxHomeConfig(homeDirectory: unknown): string {
  return path.posix.join(normalizeHome(homeDirectory), ".config");
}

function normalizeHome(homeDirectory: unknown): string {
  if (typeof homeDirectory !== "string" || !homeDirectory.length || !path.posix.isAbsolute(homeDirectory) || homeDirectory.includes("\0")) {
    throw new Error("native_install_arguments");
  }
  return homeDirectory;
}
