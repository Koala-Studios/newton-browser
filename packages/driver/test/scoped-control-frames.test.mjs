import test from 'node:test';
import assert from 'node:assert/strict';
import {PageExecutor} from '../src/page-executor.ts';
import {CommandContext} from '../src/command-context.ts';

function axNode(nodeId, backendDOMNodeId, role, name, extra = {}) {
  return {nodeId, backendDOMNodeId, role: {value: role}, name: {value: name}, properties: [], ...extra};
}

function fixture({children, included}) {
  const controller = new AbortController();
  const calls = [];
  const documentFrames = [];
  const backendByFrame = new Map(children.map((frameId, index) => [frameId, 300 + index]));
  const rootScope = [
    axNode('root-web', 1, 'RootWebArea', 'Root', {childIds: ['scope', 'outside-control']}),
    axNode('scope', 100, 'group', 'Scope', {parentId: 'root-web', childIds: ['root-control']}),
    axNode('root-control', 101, 'button', 'Root control', {parentId: 'scope'}),
    axNode('outside-control', 102, 'button', 'Outside control', {parentId: 'root-web'}),
  ];
  const childAX = (frameId) => {
    const backend = backendByFrame.get(frameId);
    return [
      axNode(`${frameId}-web`, backend + 1000, 'RootWebArea', frameId, {childIds: [`${frameId}-control`]}),
      axNode(`${frameId}-control`, backend, 'button', `${frameId} control`, {parentId: `${frameId}-web`}),
    ];
  };
  const connection = {
    epoch: 'epoch',
    claimGeneration: 1,
    rootTargetId: 'root',
    signal: controller.signal,
    wire: {
      async send(method, params = {}, sessionId) {
        calls.push({method, params, sessionId});
        if (method === 'Accessibility.getPartialAXTree') return {nodes: rootScope};
        if (method === 'Accessibility.getFullAXTree') return {nodes: childAX(params.frameId)};
        if (method === 'Accessibility.queryAXTree') return {nodes: []};
        return {};
      },
      onEvent() { return () => {}; },
    },
  };
  const executor = new PageExecutor(connection);
  const directory = executor.directory;
  directory.addPage('root');
  directory.registerRoute('root-route');
  directory.navigate('root', {frameId: 'root-frame', route: 'root-route', loaderId: 'root'});
  for (const frameId of children) {
    const route = `${frameId}-route`;
    directory.registerRoute(route);
    directory.navigate('root', {frameId, parentId: frameId==='nested'?'inside':'root-frame', route, loaderId: frameId});
  }
  const page = directory.stamp('root');
  const scopeBinding = directory.binding(page, 100);
  const scopeRef = directory.publish([scopeBinding]).refs[0];
  executor.resolver.document = async (_context, frame) => {
    documentFrames.push(frame.frameId);
    return directory.binding(frame, 200);
  };
  executor.frameWithinScope = async (_context, _container, frame) => included.has(frame.frameId);
  return {
    executor,
    directory,
    page,
    scope: {kind: 'ref', ref: scopeRef},
    context: new CommandContext(10_000),
    calls,
    documentFrames,
  };
}

test('scoped control refs retain child frame identity and exclude outside siblings', async () => {
  const fixtureState = fixture({children: ['inside', 'outside', 'nested'], included: new Set(['inside', 'nested'])});
  const {executor, page, scope, context, calls, documentFrames} = fixtureState;
  try {
    const observation = await executor.observe(context, page, 1_000_000, false, scope);
    const childNode = observation.nodes.find(node => node.name === 'inside control');
    const nestedNode = observation.nodes.find(node => node.name === 'nested control');
    const rootNode = observation.nodes.find(node => node.name === 'Root control');
    assert.ok(childNode?.ref);
    assert.ok(nestedNode?.ref);
    assert.ok(rootNode?.ref);
    assert.equal(observation.nodes.some(node => node.name === 'Outside control'), false);
    assert.deepEqual(documentFrames, ['inside', 'nested']);

    const childBinding = await executor.resolver.resolve(context, page, {kind: 'ref', ref: childNode.ref});
    const nestedBinding = await executor.resolver.resolve(context, page, {kind: 'ref', ref: nestedNode.ref});
    const rootBinding = await executor.resolver.resolve(context, page, {kind: 'ref', ref: rootNode.ref});
    assert.deepEqual({frameId: childBinding.frameId, backendNodeId: childBinding.backendNodeId}, {frameId: 'inside', backendNodeId: 300});
    assert.deepEqual({frameId: nestedBinding.frameId, backendNodeId: nestedBinding.backendNodeId}, {frameId: 'nested', backendNodeId: 302});
    assert.deepEqual({frameId: rootBinding.frameId, backendNodeId: rootBinding.backendNodeId}, {frameId: 'root-frame', backendNodeId: 101});

    const partial = calls.filter(call => call.method === 'Accessibility.getPartialAXTree');
    const full = calls.filter(call => call.method === 'Accessibility.getFullAXTree');
    assert.deepEqual(partial.map(call => ({sessionId: call.sessionId, backendNodeId: call.params.backendNodeId})), [{sessionId: 'root-route', backendNodeId: 100}]);
    assert.deepEqual(full.map(call => call.sessionId), ['inside-route', 'nested-route']);
    assert.ok(full.every(call => !Object.hasOwn(call.params, 'backendNodeId')));
    assert.equal(calls.some(call => call.method === 'Accessibility.queryAXTree'), false);
    assert.equal(calls.some(call => call.sessionId === 'outside-route'), false);
  } finally {
    context.dispose();
  }
});

test('scoped controls bound the included child frame set at sixteen', async () => {
  const children = Array.from({length: 17}, (_value, index) => `child-${index + 1}`);
  const fixtureState = fixture({children, included: new Set(children)});
  const {executor, page, scope, context, calls, documentFrames} = fixtureState;
  try {
    const observation = await executor.observe(context, page, 1_000_000, false, scope);
    const childControls = observation.nodes.filter(node => /^(child-\d+) control$/u.test(node.name));
    assert.equal(observation.state, 'incomplete');
    assert.equal(childControls.length, 16);
    assert.deepEqual(documentFrames, children.slice(0, 16));
    assert.deepEqual(
      calls.filter(call => call.method === 'Accessibility.getFullAXTree').map(call => call.sessionId),
      children.slice(0, 16).map(frameId => `${frameId}-route`),
    );
    assert.equal(calls.some(call => call.sessionId === 'child-17-route'), false);
  } finally {
    context.dispose();
  }
});
