import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineHost } from '../apps/mcp-server/src/browser-runtime/engine-host.ts';

// Audit D13: a start whose connection never resolves cannot block shutdown.
test('stopAll returns cleanup_uncertain instead of waiting forever on a hung start', async () => {
  const previous = EngineHost.START_STOP_BOUND_MS;
  EngineHost.START_STOP_BOUND_MS = 50;
  try {
    const host = new EngineHost(() => new Promise(() => {}));
    void host.start({ url: 'https://example.test/' }).catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 5));
    const started = performance.now();
    await assert.rejects(host.stopAll(), /cleanup_uncertain/);
    assert.ok(performance.now() - started < 1000);
  } finally { EngineHost.START_STOP_BOUND_MS = previous; }
});
