import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile, chmod, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildNativeLauncher, buildNativeRuntime } from '../../apps/mcp-server/src/native-artifacts.ts';
import { nativePlatformLayout } from '../../apps/mcp-server/src/native-platform.ts';
import { LoginSource } from '../../apps/mcp-server/src/browser-runtime/login-source.ts';
import { createNewtonIdentity, openProfileStore } from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
import { resolveTextEditRange } from '../../packages/driver/src/text-edit-range.ts';

async function tempDirectory(prefix) {
  return mkdtemp(path.join(await realpath(tmpdir()), prefix));
}

test('precise edit range helper resolves bounded unique, contextual and occurrence matches', () => {
  const unique = resolveTextEditRange('alpha middle omega', { match: 'middle', replacement: 'X' });
  assert.deepEqual(unique, { start: 6, end: 12, expected: 'alpha X omega' });
  assert.equal(Object.isFrozen(unique), true);
  assert.deepEqual(resolveTextEditRange('same same', { match: 'same', replacement: '', occurrence: 2 }), { start: 5, end: 9, expected: 'same ' });
  assert.deepEqual(resolveTextEditRange('a target one target two', { match: 'target', replacement: 'X', prefix: 'one ' }), { start: 13, end: 19, expected: 'a target one X two' });
  assert.throws(() => resolveTextEditRange('same same', { match: 'same', replacement: 'X' }), /ambiguous/);
  assert.throws(() => resolveTextEditRange('abc', { match: 'missing', replacement: 'X' }), /not_found/);
  assert.throws(() => resolveTextEditRange('a😀b', { match: '😀', replacement: 'X', occurrence: 0 }), /invalid_arguments/);
  assert.throws(() => resolveTextEditRange('a😀b', { match: '\ud83d', replacement: 'X' }), /invalid_arguments/);
  assert.throws(() => resolveTextEditRange('x'.repeat(65_537), { match: 'x', replacement: 'y' }), /work_limit/);
});

test('native platform layouts keep browser keys and user-local registration paths independent', () => {
  const home = '/home/newton-owned-home';
  const chrome = nativePlatformLayout({ platform: 'win32', browser: 'chrome', hostName: 'com.newton.browser', homeDirectory: home });
  const edge = nativePlatformLayout({ platform: 'win32', browser: 'edge', hostName: 'com.newton.browser', homeDirectory: home });
  assert.equal(chrome.runtimeName, 'node.exe');
  assert.equal(chrome.launcherName, 'native-launcher.exe');
  assert.notEqual(chrome.registration.key, edge.registration.key);
  const linux = nativePlatformLayout({ platform: 'linux', browser: 'chrome', hostName: 'com.newton.browser', homeDirectory: home, configDirectory: `${home}/.config` });
  assert.equal(linux.runtimeName, 'node');
  assert.equal(linux.launcherName, 'native-launcher');
  assert.equal(linux.registration.path, `${home}/.config/google-chrome/NativeMessagingHosts/com.newton.browser.json`);
});

test('native runtime publication refuses corrupt partial output and preserves an immutable winner', async () => {
  const root = await tempDirectory('newton-batch02-artifacts-');
  try {
    const entry = Buffer.from('module.exports = {}\n');
    const first = await buildNativeRuntime(root, entry, process.execPath, process.platform === 'win32' ? 'node.exe' : 'node');
    const original = await readFile(path.join(first.directory, 'build.json'), 'utf8');
    const same = await Promise.all(Array.from({ length: 3 }, () => buildNativeRuntime(root, entry, process.execPath, process.platform === 'win32' ? 'node.exe' : 'node')));
    assert.ok(same.every(result => result.directory === first.directory));
    assert.equal(await readFile(path.join(first.directory, 'build.json'), 'utf8'), original);
    await writeFile(path.join(first.directory, 'build.json'), '{"version":1,"entryDigest":"bad"}\n');
    await assert.rejects(buildNativeRuntime(root, entry, process.execPath, process.platform === 'win32' ? 'node.exe' : 'node'), /native_installation_changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native launcher SEA build is immutable when the supported Node runtime is available (Windows)', async t => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (process.platform !== 'win32') { t.skip('script launcher on this platform'); return; }
  if (major < 25 || (major === 25 && minor < 5)) {
    t.diagnostic(`gap: Node ${process.versions.node} is below the required Node 25.5 SEA minimum`);
    return;
  }
  const root = await tempDirectory('newton-batch02-launcher-');
  try {
    const source = Buffer.from('#!/usr/bin/env node\nprocess.stdout.write("ok\\n")\n');
    const runtime = path.join(root, 'builds', 'x', 'node.exe');
    const first = await buildNativeLauncher(root, source, 'native-launcher.exe', runtime);
    const before = await readFile(first);
    const second = await buildNativeLauncher(root, source, 'native-launcher.exe', runtime);
    assert.equal(second, first);
    assert.deepEqual(await readFile(second), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native launcher on Linux and macOS is an immutable script that runs the launcher on the pinned runtime', async t => {
  if (process.platform === 'win32') { t.skip('SEA launcher on Windows'); return; }
  const root = await realpath(await tempDirectory('newton-batch02-script-launcher-'));
  try {
    const runtime = path.join(root, 'builds', 'x', 'node');
    await mkdir(path.dirname(runtime), { recursive: true });
    await symlink(process.execPath, runtime);
    const source = Buffer.from('process.stdout.write(JSON.stringify(process.argv.slice(2)))\n');
    const first = await buildNativeLauncher(root, source, 'native-launcher', runtime);
    assert.equal((await lstat(first)).mode & 0o777, 0o700);
    const second = await buildNativeLauncher(root, source, 'native-launcher', runtime);
    assert.equal(second, first);
    const { stdout } = await promisify(execFile)(first, ['chrome-extension://abc/', "it's"]);
    assert.deepEqual(JSON.parse(stdout), ['chrome-extension://abc/', "it's"]);
    // Another runtime is another launcher; a changed launcher source is refused.
    assert.notEqual(await buildNativeLauncher(root, source, 'native-launcher', path.join(root, 'builds', 'y', 'node')), first);
    await writeFile(path.join(path.dirname(first), 'launcher.cjs'), 'process.exit(3)\n');
    await assert.rejects(buildNativeLauncher(root, source, 'native-launcher', runtime), /native_launcher_changed/);
    await assert.rejects(buildNativeLauncher(root, source, 'native-launcher', "/tmp/x'y/node"), /native_install_arguments/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('login source refresh foundation clones opaque identities and collect is explicit', async () => {
  const root = await tempDirectory('newton-batch02-source-');
  try {
    const store = openProfileStore(path.join(root, 'identities'));
    const source = await LoginSource.open(store, path.join(root, 'login-sources'), 'batch02', 'chrome');
    const initial = await source.status();
    assert.equal(initial.generation, null);
    const clone = await source.clone();
    assert.equal(clone.generation, null);
    assert.equal(clone.authentication, 'unknown');
    assert.notEqual(clone.identity.id, createNewtonIdentity(store, { browserFamily: 'chrome' }).id);
    assert.equal(await source.collectRetired(), 0);
    assert.equal((await source.status()).generation, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
