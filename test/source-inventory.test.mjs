import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceInventory } from '../scripts/source-inventory.mjs';

// The boundary check reads source, not local runtime residue (D18).
test('the boundary inventory covers tracked and new source, skips ignored residue and reports symlinked paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-'));
  try {
    const write = (relative, text = 'x') => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), text); };
    execFileSync('git', ['init', '-q'], { cwd: root });
    write('.gitignore', 'runs/\n');
    write('src/tracked.ts'); write('docs/notes.md');
    execFileSync('git', ['add', '.'], { cwd: root });
    write('src/new.ts');
    write('runs/residue/log.txt');
    write('dist-looking/src.ts');
    fs.mkdirSync(path.join(root, 'outside'));
    fs.writeFileSync(path.join(root, 'outside', 'linked.ts'), 'x');
    fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'link'));
    const { files, symlinks } = sourceInventory(root);
    const relative = files.map(file => path.relative(root, file).replaceAll('\\', '/'));
    for (const expected of ['.gitignore', 'src/tracked.ts', 'docs/notes.md', 'src/new.ts', 'dist-looking/src.ts']) assert.ok(relative.includes(expected), expected);
    assert.ok(!relative.some(name => name.startsWith('runs/')), 'ignored residue is not scanned');
    assert.deepEqual(symlinks, ['link']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
