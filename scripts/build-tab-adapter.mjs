import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

export async function buildTabAdapter(destination, options = {}) {
  await fs.mkdir(destination, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(new URL('../apps/tab-adapter/manifest.json', import.meta.url), 'utf8'));
  if (options.key) manifest.key = options.key;
  await build({ entryPoints: [new URL('../apps/tab-adapter/src/worker.ts', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')],
    outfile: path.join(destination, 'worker.js'), bundle: true, platform: 'browser', format: 'esm', target: 'chrome125',
    logLevel: 'warning' });
  await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await fs.copyFile(new URL('../apps/tab-adapter/setup.html', import.meta.url), path.join(destination, 'setup.html'));
  return { digest: createHash('sha256').update(await fs.readFile(path.join(destination, 'worker.js'))).digest('hex') };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) console.log(await buildTabAdapter(path.resolve('apps/tab-adapter/dist')));
