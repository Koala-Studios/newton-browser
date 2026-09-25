import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temporaryRoot } from '../../scripts/prototypes/support.mjs';
import { createBrowserEngine } from '../../apps/mcp-server/src/embedding.ts';

// A browser that fails to start names the launch phase instead of reading as missing evidence (D9).
test('a browser that exits at launch reports browser_launch_failed with its phase', async () => {
  const temp = temporaryRoot('launch-errors');
  const executable = path.join(temp.root, 'broken-browser');
  fs.writeFileSync(executable, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  const engine = createBrowserEngine({ configDirectory: path.join(temp.root, 'config'), browserExecutable: executable, loginSource: 'access',
    env: { ...process.env, NEWTON_BROWSER_BROWSER: 'chrome' } });
  try {
    const result = await engine.start({ url: 'https://example.com/', timeoutMs: 5000 });
    assert.equal(result.isError, true);
    const body = JSON.parse(result.content.at(-1).text);
    assert.equal(body.errorCode, 'browser_launch_failed', JSON.stringify(body));
    assert.match(body.phase ?? '', /^(process_spawn|pipe_acquisition|protocol_readiness)$/u, JSON.stringify(body));
  } finally { await engine.close(); temp.remove(); }
});
