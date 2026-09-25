import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedProcessOutput, readProcessTable } from '../apps/mcp-server/src/browser-runtime/process-table.ts';

test('withheld helper EOF does not block timers and is cancelled within a bound', async () => {
  const controller = new AbortController(); let responsive = false;
  const helper = boundedProcessOutput(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal, timeoutMs: 2000 });
  setTimeout(() => { responsive = true; controller.abort(); }, 20);
  await assert.rejects(helper, /process_table_cancelled/); assert.equal(responsive, true);
});
test('oversized process output is unknown, never a truncated closure proof', async () => {
  await assert.rejects(boundedProcessOutput(process.execPath, ['-e', "process.stdout.write('x'.repeat(5*1024*1024))"]), /process_table_truncated/);
});
test('real fresh process scan produces bounded executable metadata without arguments for family proof', async () => {
  const table = await readProcessTable({ ownership: false });
  assert.ok(table.length); assert.ok(table.every(row => row.commandLine === null));
});
