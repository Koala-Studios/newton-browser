// Stable Windows native executable entry. No npm installation or working-tree path at launch.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const root = path.resolve(path.dirname(process.execPath), '..', '..');
assertDirectory(root);
const runtime = process.platform === 'win32' ? 'node.exe' : process.platform === 'linux' ? 'node' : null;
if (runtime === null) throw new Error('native_installation_invalid');

const configuration = readRecord(path.join(root, 'launcher.json'));
if (!/^[a-f0-9]{64}$/.test(configuration?.digest)) throw new Error('native_installation_invalid');
const build = path.join(root, 'builds', configuration.digest);
assertDirectory(build);

const entry = path.join(build, 'native-host.js');
const digest = hashFile(entry, 4 * 1024 * 1024);
if (digest !== configuration.digest) throw new Error('native_installation_changed');

const record = readRecord(path.join(build, 'build.json'));
if (
  record?.version !== 1
  || record.entryDigest !== digest
  || record.runtimeDigest !== hashFile(path.join(build, runtime), 4 * 1024 * 1024)
) {
  throw new Error('native_installation_changed');
}

const env = { ...process.env, NEWTON_NATIVE_DIRECTORY: path.join(root, 'connections') };
delete env.NODE_OPTIONS;
delete env.NODE_PATH;

const child = spawn(path.join(build, runtime), [entry], { stdio: 'inherit', windowsHide: true, env });
child.on('error', () => {
  process.exitCode = 1;
});
child.on('exit', code => {
  process.exitCode = code ?? 1;
});

function assertDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
    throw new Error('native_installation_changed');
  }
}

function readRecord(filename) {
  hashFile(filename, 4096);
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function hashFile(filename, cap = 256 * 1024 * 1024) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > cap) {
    throw new Error('native_installation_changed');
  }
  const fd = fs.openSync(filename, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  const hash = crypto.createHash('sha256');
  let total = 0;
  try {
    while (true) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) break;
      total += bytes;
      if (total > cap) throw new Error('native_installation_changed');
      hash.update(buffer.subarray(0, bytes));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}
