import assert from "node:assert/strict";
import test from "node:test";

import {
  createIdentityLeaseClosureVerifier,
  type IdentityLeaseProcessListProvider,
  type IdentityLeaseProcessTableEntry,
} from "../../src/browser-runtime/identity-lease-closure.ts";

const WINDOWS_SOURCE = Object.freeze({
  userDataRoot: "C:\\Users\\Operator\\AppData\\Local\\NewtonBrowser\\identities\\nbi_0123456789abcdef0123456789abcdef",
  profileDirectory: "Default",
  recordedHostPid: 700,
});

test("lease recovery ignores unrelated Chrome while rejecting the exact Newton identity root", () => {
  const ordinaryChrome = processEntry({
    pid: 100,
    executable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    commandLine: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --profile-directory=Default',
  });
  assert.equal(verifier([ordinaryChrome])(WINDOWS_SOURCE), true);
  assert.equal(verifier([processEntry({
    pid: 99,
    executable: "node.exe",
    commandLine: "node.exe --eval \"first line\r\nsecond line\"",
  }), ordinaryChrome])(WINDOWS_SOURCE), true);

  for (const commandLine of [
    `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" "--user-data-dir=${WINDOWS_SOURCE.userDataRoot}" --profile-directory=Default`,
    `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir="${WINDOWS_SOURCE.userDataRoot}" --profile-directory=Default`,
    `chrome.exe --user-data-dir=${WINDOWS_SOURCE.userDataRoot.replaceAll("\\", "/").toLocaleUpperCase("en-US")} --profile-directory=Default`,
  ]) {
    assert.equal(verifier([processEntry({ pid: 101, executable: ordinaryChrome.executable, commandLine })])(WINDOWS_SOURCE), false);
  }
});

test("recorded host liveness and every surviving descendant prevent lease recovery", () => {
  assert.equal(verifier([processEntry({ pid: 700, parentPid: 10 })])(WINDOWS_SOURCE), false);
  assert.equal(verifier([
    processEntry({ pid: 701, parentPid: 700, executable: "node.exe", commandLine: "node.exe browser-guardian.js" }),
    processEntry({ pid: 702, parentPid: 701 }),
  ])(WINDOWS_SOURCE), false);
  assert.equal(verifier([
    processEntry({ pid: 701, parentPid: 999, executable: "node.exe", commandLine: "node.exe worker.js" }),
  ])(WINDOWS_SOURCE), true);
});

test("browser rows without command-line ownership evidence fail closed while another family remains independent", () => {
  const opaqueChrome = processEntry({
    pid: 200,
    executable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    commandLine: null,
  });
  assert.equal(verifier([opaqueChrome])(WINDOWS_SOURCE), false);
  assert.equal(verifier([processEntry({
    pid: 201,
    executable: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    commandLine: "msedge.exe --profile-directory=Default",
  })])(WINDOWS_SOURCE), true);
});

test("provider errors, malformed tables, duplicate PIDs, and ancestry cycles never prove closure", () => {
  const providers: IdentityLeaseProcessListProvider[] = [
    () => { throw new Error("private process failure"); },
    () => null as never,
    () => [processEntry({ pid: 0 })],
    () => [processEntry({ pid: 1 }), processEntry({ pid: 1 })],
    () => [processEntry({ pid: 1, parentPid: 2 }), processEntry({ pid: 2, parentPid: 1 })],
  ];
  for (const processListProvider of providers) {
    const candidate = createIdentityLeaseClosureVerifier({
      browserFamily: "chrome",
      platform: "win32",
      processListProvider,
    });
    assert.equal(candidate(WINDOWS_SOURCE), false);
  }
});

test("identity paths stay private from the provider and invalid recovery facts are refused", () => {
  const calls: string[] = [];
  const processListProvider: IdentityLeaseProcessListProvider = (platform) => {
    calls.push(platform);
    return [processEntry({ pid: 300, executable: "python.exe", commandLine: "python.exe worker.py" })];
  };
  const candidate = createIdentityLeaseClosureVerifier({
    browserFamily: "chrome",
    platform: "win32",
    processListProvider,
  });
  assert.equal(candidate(WINDOWS_SOURCE), true);
  assert.deepEqual(calls, ["win32"]);
  assert.equal(candidate({ ...WINDOWS_SOURCE, userDataRoot: "relative" }), false);
  assert.equal(candidate({ ...WINDOWS_SOURCE, recordedHostPid: 0 }), false);
  assert.deepEqual(calls, ["win32"], "invalid facts are rejected before process enumeration");
});

function verifier(entries: readonly IdentityLeaseProcessTableEntry[]) {
  return createIdentityLeaseClosureVerifier({
    browserFamily: "chrome",
    platform: "win32",
    processListProvider: () => entries,
  });
}

function processEntry(overrides: Partial<IdentityLeaseProcessTableEntry> = {}): IdentityLeaseProcessTableEntry {
  return {
    pid: 100,
    parentPid: 10,
    executable: "C:\\Windows\\System32\\notepad.exe",
    commandLine: "notepad.exe",
    ...overrides,
  };
}
