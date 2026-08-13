import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { browserExecutableCandidates, discoverBrowserExecutable, trustedLinuxSystemBrowserTarget } from "../../src/browser-runtime/browser-discovery.ts";

test("browser candidates are deterministic for Windows, macOS, and Linux", () => {
  assert.deepEqual(browserExecutableCandidates({
    family: "chrome",
    platform: "win32",
    env: { PROGRAMFILES: "C:\\Program Files", "PROGRAMFILES(X86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local" },
  }), [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Users\\Test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
  ]);
  assert.deepEqual(browserExecutableCandidates({ family: "edge", platform: "darwin", env: {}, homeDirectory: "/Users/test" }), [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Users/test/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ]);
  assert.deepEqual(browserExecutableCandidates({ family: "chrome", platform: "linux", env: {}, homeDirectory: "/home/test" }), [
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ]);
});

test("explicit executable wins and must be an exact executable regular file", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-discovery-"));
  try {
    const executable = path.join(root, process.platform === "win32" ? "custom.exe" : "custom");
    fs.writeFileSync(executable, "fixture", { mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(executable, 0o700);
    const result = discoverBrowserExecutable({ family: "edge", explicitPath: executable, platform: process.platform as "win32" | "darwin" | "linux" });
    assert.deepEqual(result, { family: "edge", path: fs.realpathSync.native(executable), source: "explicit" });

    const directory = path.join(root, "directory.exe");
    fs.mkdirSync(directory);
    assert.throws(() => discoverBrowserExecutable({ family: "chrome", explicitPath: directory, platform: process.platform as "win32" | "darwin" | "linux" }), /browser_executable_invalid/);

    const link = path.join(root, process.platform === "win32" ? "linked.exe" : "linked");
    try {
      fs.symlinkSync(executable, link, "file");
      assert.throws(() => discoverBrowserExecutable({ family: "chrome", explicitPath: link, platform: process.platform as "win32" | "darwin" | "linux" }), /browser_executable_invalid/);
    } catch (error) {
      if (error instanceof Error && "code" in error && ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))) context.diagnostic(`symlink unavailable: ${String(error.code)}`);
      else throw error;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explicit executable canonicalizes a linked ancestor but rejects a linked executable leaf", (context) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "newton-browser-discovery-link-"));
  try {
    const physicalParent = path.join(root, "physical");
    const linkedParent = path.join(root, "linked");
    fs.mkdirSync(physicalParent);
    try {
      fs.symlinkSync(physicalParent, linkedParent, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))) {
        context.skip(`directory link unavailable: ${String(error.code)}`);
        return;
      }
      throw error;
    }
    const name = process.platform === "win32" ? "browser.exe" : "browser";
    const physicalExecutable = path.join(physicalParent, name);
    const linkedExecutable = path.join(linkedParent, name);
    fs.writeFileSync(physicalExecutable, "fixture", { mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(physicalExecutable, 0o700);
    assert.equal(discoverBrowserExecutable({
      family: "chrome",
      explicitPath: linkedExecutable,
      platform: process.platform as "win32" | "darwin" | "linux",
    })?.path, fs.realpathSync.native(physicalExecutable));

    const linkedLeaf = path.join(root, process.platform === "win32" ? "linked-leaf.exe" : "linked-leaf");
    fs.symlinkSync(physicalExecutable, linkedLeaf, "file");
    assert.throws(() => discoverBrowserExecutable({
      family: "chrome",
      explicitPath: linkedLeaf,
      platform: process.platform as "win32" | "darwin" | "linux",
    }), /browser_executable_invalid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing system candidates return null while invalid explicit paths fail closed", () => {
  assert.equal(discoverBrowserExecutable({ family: "chrome", platform: "win32", env: {} }), null);
  assert.throws(() => discoverBrowserExecutable({ family: "chrome", explicitPath: path.join(os.tmpdir(), "missing-newton-browser.exe"), platform: "win32" }), /browser_executable_unavailable/);
});

test("Linux system symlink targets are confined to exact trusted installation prefixes", () => {
  assert.equal(trustedLinuxSystemBrowserTarget("/usr/bin/google-chrome", "/opt/google/chrome/chrome"), true);
  assert.equal(trustedLinuxSystemBrowserTarget("/usr/bin/microsoft-edge", "/opt/microsoft/msedge/msedge"), true);
  assert.equal(trustedLinuxSystemBrowserTarget("/usr/bin/chromium", "/usr/lib/chromium/chromium"), true);
  assert.equal(trustedLinuxSystemBrowserTarget("/usr/bin/google-chrome", "/opt/google-evil/chrome"), false);
  assert.equal(trustedLinuxSystemBrowserTarget("/usr/bin/chromium", "/home/user/chromium"), false);
  assert.equal(trustedLinuxSystemBrowserTarget("/tmp/google-chrome", "/opt/google/chrome/chrome"), false);
  assert.equal(trustedLinuxSystemBrowserTarget("/usr/bin/chromium", "/snap/bin/chromium"), false);
});
