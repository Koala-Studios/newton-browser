import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Headless Chrome announces itself as "HeadlessChrome" in its user agent, which sign-in pages treat as a bot and
 * answer with endless CAPTCHAs. Headless launches send the same user agent the installed browser sends with a
 * window: the reduced form Chrome uses everywhere, with the browser's real major version so it matches the
 * client-hint headers.
 */
export function headedUserAgent(major: number, platform: NodeJS.Platform, family: "chrome" | "edge" = "chrome"): string {
  const system = platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7"
    : platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64";
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
    + (family === "edge" ? ` Edg/${major}.0.0.0` : "");
}

const majors = new Map<string, number | null>();

/** The browser's major version, or null when it can't be read. Read once per executable. */
export function browserMajorVersion(executablePath: string, platform: NodeJS.Platform = process.platform,
  readVersion: (executable: string) => string = runVersion): number | null {
  const cached = majors.get(executablePath);
  if (cached !== undefined) return cached;
  let major: number | null = null;
  try {
    const text = platform === "win32" ? windowsVersionDirectory(executablePath) : readVersion(executablePath);
    const match = /(\d{2,4})\.\d+\.\d+\.\d+/u.exec(text);
    if (match) major = Number(match[1]);
  } catch { major = null; }
  majors.set(executablePath, major);
  return major;
}

function runVersion(executable: string): string {
  return execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
}

/** Windows Chrome and Edge keep a folder named after the full version beside the executable. */
function windowsVersionDirectory(executable: string): string {
  const versions = fs.readdirSync(path.dirname(executable)).filter((name) => /^\d+\.\d+\.\d+\.\d+$/u.test(name));
  versions.sort((a, b) => Number(b.split(".")[0]) - Number(a.split(".")[0]));
  return versions[0] ?? "";
}
