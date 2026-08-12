import assert from "node:assert/strict";
import test from "node:test";

import { createProfileSourceClosureVerifier } from "../../src/browser-runtime/profile-closure.ts";
import type { ProcessListProvider, ProcessTableEntry } from "../../src/browser-runtime/profile-closure.ts";

const SOURCE = Object.freeze({ userDataRoot: "/tmp/newton-source", profileDirectory: "Default" });

test("default-profile and explicit-root Chrome processes both fail closure evidence", () => {
  for (const commandLine of [
    "/opt/google/chrome/chrome --profile-directory=Default",
    "/usr/bin/google-chrome --user-data-dir=/tmp/another-root --profile-directory=Profile 2",
    "/usr/bin/chromium-browser --user-data-dir=/tmp/newton-source",
  ]) {
    const verifier = verifierFor("chrome", [{ pid: 101, executable: "/opt/google/chrome/chrome", commandLine }]);
    assert.equal(verifier(SOURCE), false, commandLine);
  }
});

test("Edge processes fail Edge verification while distinct browser families remain separated", () => {
  const edgeProcess = [{
    pid: 202,
    executable: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    commandLine: '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --profile-directory=Default',
  }];
  assert.equal(verifierFor("edge", edgeProcess)(SOURCE), false);
  assert.equal(verifierFor("chrome", edgeProcess)(SOURCE), true);

  const chromeProcess = [{ pid: 203, executable: "/opt/google/chrome/chrome", commandLine: "/opt/google/chrome/chrome" }];
  assert.equal(verifierFor("chrome", chromeProcess)(SOURCE), false);
  assert.equal(verifierFor("edge", chromeProcess)(SOURCE), true);
});

test("browser identity comes from the executable, never later command arguments", () => {
  const chromeWithEdgeArgument = [{
    pid: 303,
    executable: "chrome.exe",
    commandLine: "chrome.exe msedge.exe",
  }];
  assert.equal(verifierFor("chrome", chromeWithEdgeArgument)(SOURCE), false);
  assert.equal(verifierFor("edge", chromeWithEdgeArgument)(SOURCE), true);
  const newtonImport = [{
    pid: process.pid,
    executable: process.execPath,
    commandLine: `${process.execPath} newton-browser identity import --browser chrome`,
  }];
  assert.equal(verifierFor("chrome", newtonImport)(SOURCE), true, "Newton's own --browser flag is not a Chrome process");
  assert.equal(verifierFor("chrome", [{
    pid: process.pid,
    executable: "google-chrome",
    commandLine: "google-chrome --user-data-dir=/tmp/newton-source",
  }])(SOURCE), false, "the current process is not exempt without exact ownership proof");
});

test("hostile source paths are never passed to or interpolated into the process provider", () => {
  const calls: string[] = [];
  const provider: ProcessListProvider = (platform) => {
    calls.push(platform);
    return [{ pid: 404, executable: "/usr/bin/python3", commandLine: "python3 worker.py" }];
  };
  const verifier = createProfileSourceClosureVerifier({
    browserFamily: "chrome",
    platform: "linux",
    processListProvider: provider,
  });
  const hostile = {
    userDataRoot: "/tmp/source;$(google-chrome --user-data-dir=/escape) ' msedge.exe",
    profileDirectory: "Profile & rm -rf ignored",
  };
  assert.equal(verifier(hostile), true);
  assert.deepEqual(calls, ["linux"]);
});

test("provider failure, truncation, malformed rows, and hostile command lines all fail closed", () => {
  const failures: ProcessListProvider[] = [
    () => { throw new Error("process table failed with /secret/path"); },
    () => { throw new Error("process_table_truncated"); },
    () => null as never,
    () => [{ pid: 0, executable: "chrome", commandLine: "chrome" }],
    () => [{ pid: 1, executable: null, commandLine: null }],
    () => [{ pid: 1, executable: "python", commandLine: "python\nchrome.exe" }],
  ];
  for (const processListProvider of failures) {
    const verifier = createProfileSourceClosureVerifier({ browserFamily: "chrome", platform: "linux", processListProvider });
    assert.equal(verifier(SOURCE), false);
  }
  assert.equal(verifierFor("chrome", [{
    pid: 1,
    executable: "python",
    commandLine: "python --title='chrome.exe'",
  }])(SOURCE), true);
  assert.equal(verifierFor("chrome", [{
    pid: 2,
    executable: null,
    commandLine: "/usr/bin/google-chrome --profile-directory=Default",
  }])(SOURCE), false);
});

test("invalid source, unsupported platform, and invalid family never produce closure proof", () => {
  let providerCalls = 0;
  const provider: ProcessListProvider = () => { providerCalls += 1; return []; };
  const invalidSource = createProfileSourceClosureVerifier({
    browserFamily: "chrome",
    platform: "linux",
    processListProvider: provider,
  });
  assert.equal(invalidSource({ userDataRoot: "relative", profileDirectory: "Default" }), false);
  assert.equal(providerCalls, 0);
  assert.equal(createProfileSourceClosureVerifier({
    browserFamily: "chrome",
    platform: "freebsd",
    processListProvider: provider,
  })(SOURCE), false);
  assert.equal(createProfileSourceClosureVerifier({
    browserFamily: "firefox" as never,
    platform: "linux",
    processListProvider: provider,
  })(SOURCE), false);
});

function verifierFor(family: "chrome" | "edge", entries: readonly ProcessTableEntry[]) {
  return createProfileSourceClosureVerifier({
    browserFamily: family,
    platform: "linux",
    processListProvider: () => entries,
  });
}
