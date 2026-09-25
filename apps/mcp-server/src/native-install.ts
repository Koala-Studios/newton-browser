import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { Stats } from 'node:fs';
import { buildNativeLauncher, buildNativeRuntime } from './native-artifacts.ts';
import { hashNativeFile } from './native-file.ts';
import { nativePlatformLayout } from './native-platform.ts';
import type { NativeBrowserFamily } from './native-platform.ts';
import { publishLinuxNativeRegistration, removeLinuxNativeRegistration } from './linux-native-registration.ts';

const execute = promisify(execFile);
type NativeLocalOptions = { browser?: NativeBrowserFamily };

export async function installNativeLocal(
  root: string,
  extensionId: string,
  options: NativeLocalOptions = {},
) {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('native_install_arguments');
  const browser = options.browser ?? 'chrome';
  const platform = process.platform;
  const homeDirectory = platform === 'linux' ? os.homedir() : undefined;
  const hostName = `newton.browser.${extensionId}`;
  const layout = nativePlatformLayout({
    platform,
    browser,
    hostName,
    ...(platform === 'linux' && homeDirectory ? {homeDirectory} : {}),
    ...(platform === 'linux' && process.env.XDG_CONFIG_HOME ? {configDirectory: process.env.XDG_CONFIG_HOME} : {}),
  });
  root = await ensureRootParent(path.resolve(root));
  await ensureNativeOwner(root, extensionId);
  await ensureDirectory(root, "native_directory_invalid", { level: "private", requireCurrentUser: true });
  if (platform === 'linux') {
    await ensureLinuxConfigBase(homeDirectory!, layout.registration.kind === 'file' ? layout.registration.path : undefined);
  }
  const connections = path.join(root, 'connections');
  try {
    await fs.mkdir(connections, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await ensureDirectory(connections, 'native_directory_invalid', { level: "private", requireCurrentUser: true });
  const artifacts = path.dirname(fileURLToPath(import.meta.url));
  const entry = await fs.readFile(path.join(artifacts, 'native-host.js'));
  const { digest } = await buildNativeRuntime(root, entry, process.execPath, layout.runtimeName);
  const launcher = await buildNativeLauncher(root, await fs.readFile(path.join(artifacts, 'native-launcher.cjs')), layout.launcherName);
  await publishNativeJson(root, 'launcher.json', { digest });
  const manifest = path.join(root, 'manifest.json');
  await publishNativeJson(root, 'manifest.json', {
    name: hostName,
    description: 'Newton local tab connection',
    path: launcher,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  });
  if (layout.registration.kind === 'registry') {
    await execute('reg.exe', ['add', layout.registration.key, '/ve', '/t', 'REG_SZ', '/d', manifest, '/f'], { windowsHide: true });
    return {
      root,
      digest,
      registry: layout.registration.key,
      registration: layout.registration,
      unregister: () => unregisterNativeLocal(root, extensionId, { browser }),
    };
  }
  await publishLinuxNativeRegistration(root, layout.registration.path);
  return {
    root,
    digest,
    registration: layout.registration,
    unregister: () => unregisterNativeLocal(root, extensionId, { browser }),
  };
}

export async function unregisterNativeLocal(root: string, extensionId: string, options: NativeLocalOptions = {}): Promise<void> {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('native_install_arguments');
  const browser = options.browser ?? 'chrome';
  const platform = process.platform;
  const hostName = `newton.browser.${extensionId}`;
  const layout = nativePlatformLayout({
    platform,
    browser,
    hostName,
    ...(platform === 'linux' ? {homeDirectory: os.homedir()} : {}),
    ...(platform === 'linux' && process.env.XDG_CONFIG_HOME ? {configDirectory: process.env.XDG_CONFIG_HOME} : {}),
  });
  const canonical = await ensureDirectory(path.resolve(root), 'native_directory_invalid');
  if (layout.registration.kind === 'registry') {
    const manifest = path.join(canonical, 'manifest.json');
    const { stdout } = await execute('reg.exe', ['query', layout.registration.key, '/ve'], { windowsHide: true });
    if (!nativeRegistrationMatches(stdout, manifest)) throw new Error('native_registration_changed');
    await execute('reg.exe', ['delete', layout.registration.key, '/f'], { windowsHide: true });
    return;
  }
  await removeLinuxNativeRegistration(canonical, layout.registration.path);
}

export function nativeRegistrationMatches(stdout: string, manifest: string): boolean {
  const values = stdout.split(/\r?\n/).flatMap(line => {
    const value = /\sREG_SZ\s+(.+)$/u.exec(line)?.[1]?.trim();
    return value === undefined ? [] : [value];
  });
  return values.length === 1 && path.resolve(values[0]!).toLowerCase() === path.resolve(manifest).toLowerCase();
}

async function ensureNativeOwner(root: string, extensionId: string): Promise<void> {
  if (process.platform === 'win32') {
    const filename = path.join(root, 'installation.json');
    let exists = true;
    try {
      await fs.lstat(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
      else throw error;
    }
    if (!exists) {
      const stage = await fs.mkdtemp(path.join(path.dirname(root), '.newton-native-stage-'));
      const identity = await fs.lstat(stage);
      try {
        const { stdout } = await execute(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],
          { windowsHide: true },
        );
        const sid = stdout.trim();
        if (!/^S-1-[0-9-]+$/.test(sid)) throw new Error('native_owner_unknown');
        await execute('icacls.exe', [stage, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true });
        await fs.writeFile(path.join(stage, 'installation.json'), JSON.stringify({ version: 1, extensionId }) + '\n', { flag: 'wx', mode: 0o600 });
        await fs.rename(stage, root).catch(error => {
          if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        });
      } finally {
        await removeNativeOwnerStage(stage, identity, path.dirname(root), ['installation.json']);
      }
    }
    try {
      const stat = await fs.lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('native_owner_changed');
      await hashNativeFile(filename, 4096);
      const owner = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (owner?.version !== 1 || owner.extensionId !== extensionId) throw new Error('native_owner_changed');
    } catch {
      throw new Error('native_owner_changed');
    }
    return;
  }
  if (process.platform === 'linux') {
    const uid = process.getuid?.();
    if (typeof uid !== 'number') throw new Error('native_owner_unknown');
    const filename = path.join(root, 'installation.json');
    let exists = true;
    try {
      await ensureDirectory(root, 'native_owner_changed', { level: 'private', requireCurrentUser: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
      else throw error;
    }
    if (!exists) {
      const parent = path.dirname(root);
      await ensureDirectory(parent, 'native_directory_invalid', { level: 'private', requireCurrentUser: true });
      const stage = await fs.mkdtemp(path.join(parent, '.newton-native-stage-'));
      const identity = await fs.lstat(stage);
      const marker = path.join(stage, 'installation.json');
      try {
        await fs.chmod(stage, 0o700);
        await fs.writeFile(marker, JSON.stringify({ version: 1, extensionId }) + '\n', { flag: 'wx', mode: 0o600 });
        await fs.rename(stage, root).catch(error => {
          if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        });
      } finally {
        await removeNativeOwnerStage(stage, identity, parent, ['installation.json']);
      }
    }
    const owner = await fs.lstat(filename).catch(() => null);
    if (!owner || !owner.isFile() || owner.isSymbolicLink() || owner.nlink !== 1 || (owner.mode & 0o0022) !== 0 || owner.uid !== uid) {
      throw new Error('native_owner_changed');
    }
    await ensureDirectory(root, 'native_owner_changed', { level: 'private', requireCurrentUser: true });
    try {
      await hashNativeFile(filename, 4096);
      const payload = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (payload?.version !== 1 || payload.extensionId !== extensionId) throw new Error('native_owner_changed');
      return;
    } catch {
      throw new Error('native_owner_changed');
    }
  }
  throw new Error('native_install_arguments');
}

export async function publishNativeJson(root: string, name: 'launcher.json' | 'manifest.json', value: unknown): Promise<void> {
  const stage = path.join(root, `.${name}-${randomUUID()}.stage`);
  const destination = path.join(root, name);
  const text = JSON.stringify(value) + '\n';
  const alreadyPublished = async () => {
    try {
      await hashNativeFile(destination, 16384);
      return (await fs.readFile(destination, 'utf8')) === text;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  if (await alreadyPublished()) return;
  try {
    const file = await fs.open(stage, 'wx', 0o600);
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await fs.rename(stage, destination);
    } catch (error) {
      if (!['EPERM', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '') || !await alreadyPublished()) throw error;
    }
  } finally {
    await fs.unlink(stage).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function ensureLinuxConfigBase(homeDirectory: string, registrationPath?: string): Promise<void> {
  if (!registrationPath) return;
  const configDirectory = path.dirname(path.dirname(path.dirname(registrationPath)));
  await ensureDirectory(homeDirectory, 'native_install_arguments', { level: 'shared', requireCurrentUser: true });
  const expected = path.join(homeDirectory, '.config');
  if (path.resolve(configDirectory) === path.resolve(expected)) {
    await fs.mkdir(configDirectory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  }
  await ensureDirectory(configDirectory, 'native_install_arguments', { level: 'shared', requireCurrentUser: true });
}

type DirectoryLevel = 'private' | 'shared';
type DirectoryConstraints = {
  level?: DirectoryLevel;
  requireCurrentUser?: boolean;
};

async function ensureDirectory(
  directory: string,
  errorCode: string,
  options: DirectoryConstraints = {},
): Promise<string> {
  const resolved = path.resolve(directory);
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(errorCode);
  const canonical = await fs.realpath(resolved);
  if (canonical !== resolved) throw new Error(errorCode);
  if (process.platform==='linux' && options.level !== undefined) {
    const mask = options.level === 'private' ? 0o0077 : 0o0022;
    if ((stat.mode & mask) !== 0) throw new Error(errorCode);
  }
  if (process.platform==='linux' && options.requireCurrentUser && stat.uid !== process.getuid?.()) throw new Error(errorCode);
  return canonical;
}

async function ensureRootParent(root: string): Promise<string> {
  const parent = path.dirname(root);
  await ensureDirectory(parent, 'native_directory_invalid');
  return root;
}

async function removeNativeOwnerStage(stage: string, identity: Stats, expectedParent: string, files: readonly string[]): Promise<void> {
  const current = await fs.lstat(stage).catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!current) return;
  const resolvedStage = await fs.realpath(stage);
  const resolvedParent = await fs.realpath(expectedParent);
  const stageExpectedParent = path.resolve(expectedParent);
  if (resolvedStage !== path.resolve(stage) || resolvedParent !== stageExpectedParent) {
    throw new Error("native_stage_changed");
  }
  if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== identity.ino || current.dev !== identity.dev) {
    throw new Error("native_stage_changed");
  }
  if (path.dirname(resolvedStage) !== resolvedParent) throw new Error("native_stage_changed");
  for (const file of files) {
    await fs.unlink(path.join(stage, file)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  await fs.rmdir(stage);
}
