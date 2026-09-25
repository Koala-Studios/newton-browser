import test from 'node:test';
import assert from 'node:assert/strict';
import {PageExecutor} from '../src/page-executor.ts';

function fixture(frames) {
  const executor = new PageExecutor({
    epoch: 'epoch',
    claimGeneration: 1,
    rootTargetId: 'root',
    signal: new AbortController().signal,
    wire: {send: async () => ({}), onEvent: () => () => {}},
  });
  const directory = executor.directory;
  directory.addPage('root');
  directory.registerRoute('route');
  for (const [frameId, parentId] of frames) {
    directory.navigate('root', {frameId, parentId, route: 'route', loaderId: frameId});
  }
  const page = directory.stamp('root');
  const root = directory.binding(page, 5);
  executor.resolver.resolve = async () => root;
  executor.resolver.document = async (_context, frame) => directory.binding(frame, 6);
  executor.frameWithinScope = async () => true;
  return {executor, directory, page, context: {checkpoint() {}}};
}

const scope = {kind: 'selector', selector: '#scope'};
const marker = '\n[Embedded frame]\n';

test('scoped document shares the character budget across root and child frames', async () => {
  const {executor, page, context} = fixture([
    ['root-frame', undefined],
    ['inside', 'root-frame'],
    ['second', 'root-frame'],
  ]);
  const calls = [];
  executor.readBoundText = async (_context, binding, maxChars, maxNodes, useThis) => {
    calls.push({frameId: binding.frameId, maxChars, maxNodes, useThis});
    if (binding.frameId === 'root-frame') {
      return {text: 'r'.repeat(262144 - marker.length - 1), truncated: false, visited: 1};
    }
    return {text: 'c'.repeat(maxChars), truncated: false, visited: 1};
  };

  const observation = await executor.readDocument(context, page, 1_000_000, undefined, scope);

  assert.deepEqual(calls.map(call => call.frameId), ['root-frame', 'inside']);
  assert.equal(calls[1].maxChars, 1);
  assert.equal(calls[1].maxNodes, 49999);
  assert.equal(calls[1].useThis, false);
  assert.equal(observation.incompleteReason, 'work_limit');
});

test('scoped document shares the node budget across root and child frames', async () => {
  const {executor, page, context} = fixture([
    ['root-frame', undefined],
    ['inside', 'root-frame'],
    ['second', 'root-frame'],
  ]);
  const calls = [];
  executor.readBoundText = async (_context, binding, maxChars, maxNodes, useThis) => {
    calls.push({frameId: binding.frameId, maxChars, maxNodes, useThis});
    if (binding.frameId === 'root-frame') return {text: 'Root', truncated: false, visited: 49999};
    return {text: binding.frameId, truncated: false, visited: maxNodes};
  };

  const observation = await executor.readDocument(context, page, 1_000_000, undefined, scope);

  assert.deepEqual(calls.map(call => call.frameId), ['root-frame', 'inside']);
  assert.equal(calls[1].maxNodes, 1);
  assert.equal(calls[1].maxChars, 262144 - 'Root'.length - marker.length);
  assert.equal(calls[1].useThis, false);
  assert.equal(observation.incompleteReason, 'work_limit');
});

test('scoped document caps participating child frames at sixteen', async () => {
  const childIds = Array.from({length: 17}, (_value, index) => `child-${String(index + 1).padStart(2, '0')}`);
  const {executor, page, context} = fixture([
    ['root-frame', undefined],
    ...childIds.map(frameId => [frameId, 'root-frame']),
  ]);
  const reads = [];
  executor.readBoundText = async (_context, binding) => {
    reads.push(binding.frameId);
    return {text: binding.frameId, truncated: false, visited: 1};
  };

  const observation = await executor.readDocument(context, page, 1_000_000, undefined, scope);

  assert.deepEqual(reads, ['root-frame', ...childIds.slice(0, 16)]);
  assert.match(observation.text, /child-16/);
  assert.doesNotMatch(observation.text, /child-17/);
  assert.equal(observation.incompleteReason, 'work_limit');
});

test('scoped document reaches sixteen nested descendants with deepest-first frame registration', async () => {
  const depth = 16;
  const frames = [['root-frame', undefined]];
  for (let index = depth; index >= 1; index--) {
    frames.push([`deep-${index}`, index === 1 ? 'root-frame' : `deep-${index - 1}`]);
  }
  const {executor, page, context} = fixture(frames);
  const reads = [];
  executor.readBoundText = async (_context, binding) => {
    reads.push(binding.frameId);
    return {text: binding.frameId, truncated: false, visited: 1};
  };

  const observation = await executor.readDocument(context, page, 1_000_000, undefined, scope);

  assert.deepEqual(reads, ['root-frame', ...Array.from({length: depth}, (_value, index) => `deep-${index + 1}`)]);
  assert.equal(observation.incompleteReason, undefined);
  assert.equal(observation.complete, true);
});

test('scoped document continuation expires after a participating child is removed', async () => {
  const {executor, directory, page, context} = fixture([
    ['root-frame', undefined],
    ['inside', 'root-frame'],
  ]);
  executor.readBoundText = async (_context, binding) => ({
    text: binding.frameId === 'root-frame' ? 'Root' : 'inside '.repeat(2_000),
    truncated: false,
    visited: 1,
  });

  const first = await executor.readDocument(context, page, 2048, undefined, scope);
  assert.ok(first.cursor);
  directory.detachFrame('root', 'inside', 'route');

  await assert.rejects(
    executor.readDocument(context, page, 2048, first.cursor),
    /cursor_expired/,
  );
});

test('scoped document continuation expires after a participating child navigates', async () => {
  const {executor, directory, page, context} = fixture([
    ['root-frame', undefined],
    ['inside', 'root-frame'],
  ]);
  executor.readBoundText = async (_context, binding) => ({
    text: binding.frameId === 'root-frame' ? 'Root' : 'inside '.repeat(2_000),
    truncated: false,
    visited: 1,
  });

  const first = await executor.readDocument(context, page, 2048, undefined, scope);
  assert.ok(first.cursor);
  directory.navigate('root', {frameId: 'inside', parentId: 'root-frame', route: 'route', loaderId: 'next'});

  await assert.rejects(
    executor.readDocument(context, page, 2048, first.cursor),
    /cursor_expired/,
  );
});
