import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineError } from '@newton-browser/core';
import { TargetResolver } from '../src/target-resolver.ts';
import { CommandContext } from '../src/command-context.ts';
import { PageDirectory } from '../src/page-directory.ts';
import { SessionEngine } from '../src/session-engine.ts';

const page = { pageId: 'p1', frameId: 'f1', documentGeneration: 1 };
// One frame whose accessibility tree holds these nodes. queryAXTree filters by role and, like Chromium, compares
// accessibleName to the name byte for byte.
function resolverOver(nodes, { pending = 0, withhold = false } = {}) {
  const queries = [];
  const directory = {
    resolve: () => { throw new EngineError('stale_target'); },
    binding: (frame, backendNodeId) => ({ ...frame, backendNodeId }),
    frames: () => [page], parent: () => undefined, route: () => 'route',
  };
  const resolver = new TargetResolver({ directory, pendingAttachments: () => 0, pendingFrames: () => pending, async send(_binding, method, params) {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'Accessibility.getPartialAXTree') return {};
    assert.equal(method, 'Accessibility.queryAXTree');
    queries.push({ role: params.role, ...(params.accessibleName === undefined ? {} : { accessibleName: params.accessibleName }) });
    if (withhold) return new Promise(() => {});
    return { nodes: nodes.filter(node => node.role.value === params.role && (params.accessibleName === undefined || node.name.value === params.accessibleName)) };
  } });
  return { resolver, queries };
}
const node = (id, role, name) => ({ nodeId: String(id), backendDOMNodeId: id, ignored: false, role: { value: role }, name: { value: name } });
const resolve = async (resolver, target, read) => {
  const context = new CommandContext(10_000);
  try { return await resolver.resolve(context, page, { exact: true, ...target }, read ? { count: 0 } : undefined); } finally { context.dispose(); }
};
const failure = promise => promise.then(() => assert.fail('resolved'), error => ({ code: error.code, detail: error.detail }));

test('a name copied from an observation finds a control whose label starts with a zero-width space', async () => {
  const { resolver, queries } = resolverOver([node(7, 'button', '​ Reject all'), node(8, 'button', 'Accept all')]);
  for (const name of ['Reject all', '​ Reject all', ' Reject all', '​Reject all']) {
    queries.length = 0;
    assert.equal((await resolve(resolver, { kind: 'semantic', role: 'button', name })).backendNodeId, 7, JSON.stringify(name));
  }
  // As written first, where Chromium compares in the renderer; then every button compared as names read.
  const { resolver: plain, queries: asked } = resolverOver([node(8, 'button', 'Accept all')]);
  assert.equal((await resolve(plain, { kind: 'semantic', role: 'button', name: 'Accept all' })).backendNodeId, 8);
  assert.deepEqual(asked, [{ role: 'button', accessibleName: 'Accept all' }, { role: 'DisclosureTriangle', accessibleName: 'Accept all' }], 'an exact name as written needs no full role list');
});

test('a dialog scope finds an alertdialog by part of a name that runs on into its description', async () => {
  const name = 'Create a new sandbox Sandboxes are isolated test environments for trying changes.';
  const { resolver, queries } = resolverOver([node(3, 'alertdialog', name), node(4, 'button', 'Create')]);
  const read = { count: 0 };
  const context = new CommandContext(10_000);
  try { assert.equal((await resolver.resolve(context, page, { kind: 'semantic', role: 'dialog', name: 'Create a new sandbox', exact: false }, read)).backendNodeId, 3); }
  finally { context.dispose(); }
  assert.equal(read.count, 1);
  assert.deepEqual(queries.map(query => query.role), ['dialog', 'alertdialog']);
  assert.equal((await resolve(resolver, { kind: 'semantic', role: 'dialog', name: 'create a NEW sandbox', exact: false }, true)).backendNodeId, 3, 'any part, ignoring case');
  const exact = await failure(resolve(resolver, { kind: 'semantic', role: 'dialog', name: 'Create a new sandbox' }, true));
  assert.equal(exact.code, 'not_found');
  assert.match(exact.detail, /^No dialog or alertdialog named "Create a new sandbox"\. 1 with that role: "Create a new sandbox Sandboxes are isolated test environments for trying change…"\. 1 contain it: pass exact false/u);
});

test('a target that finds nothing says what has its role, and when there is none', async () => {
  const { resolver } = resolverOver([node(7, 'button', 'Accept all'), node(8, 'button', ''), node(9, 'link', 'Privacy')]);
  const missing = await failure(resolve(resolver, { kind: 'semantic', role: 'button', name: 'Reject all' }));
  assert.deepEqual(missing, { code: 'not_found', detail: 'No button named "Reject all". 2 with that role: "Accept all", (no name).' });
  const none = await failure(resolve(resolver, { kind: 'semantic', role: 'dialog', name: 'Cookies', exact: false }));
  assert.equal(none.code, 'not_found');
  assert.match(none.detail, /^Nothing on the page has role dialog or alertdialog/u);
});

test('an action on a name two controls share is ambiguous and names them', async () => {
  const { resolver } = resolverOver([node(7, 'button', 'Delete'), node(8, 'button', '​Delete'), node(9, 'button', 'Keep')]);
  const twice = await failure(resolve(resolver, { kind: 'semantic', role: 'button', name: 'Delete ' }));
  assert.equal(twice.code, 'ambiguous');
  assert.match(twice.detail, /^2 elements with role button match "Delete": "Delete"/u);
  // Written exactly as one of them reads in the page, it is that one.
  assert.equal((await resolve(resolver, { kind: 'semantic', role: 'button', name: '​Delete' })).backendNodeId, 8);
});

test('a read takes a match while frames are still loading; an action says why it cannot', async () => {
  const { resolver } = resolverOver([node(3, 'alertdialog', 'Create a new sandbox')], { pending: 2 });
  assert.equal((await resolve(resolver, { kind: 'semantic', role: 'dialog', name: 'Create a new sandbox' }, true)).backendNodeId, 3);
  const action = await failure(resolve(resolver, { kind: 'semantic', role: 'dialog', name: 'Create a new sandbox' }));
  assert.equal(action.code, 'search_incomplete');
  assert.match(action.detail, /^2 frame\(s\) were still loading\. A second match could not be ruled out/u);
  const read = await failure(resolve(resolver, { kind: 'semantic', role: 'dialog', name: 'Billing settings' }, true));
  assert.equal(read.code, 'search_incomplete');
  assert.match(read.detail, /^2 frame\(s\) were still loading\. No dialog or alertdialog named "Billing settings"\. 1 with that role: "Create a new sandbox"\.$/u);
});

test('a page that does not answer the accessibility search is named in the detail', async () => {
  const { resolver } = resolverOver([], { withhold: true });
  const action = await failure(resolve(resolver, { kind: 'semantic', role: 'button', name: 'Save' }));
  assert.equal(action.code, 'search_incomplete');
  assert.match(action.detail, /^The page did not answer the accessibility search within 2\.5 s\./u);
  const read = await failure(resolve(resolver, { kind: 'semantic', role: 'button', name: 'Save', exact: false }, true));
  assert.equal(read.code, 'search_incomplete');
  assert.match(read.detail, /^The page did not answer the accessibility search within 2\.5 s\. Nothing on the page has role button/u);
});

test('a ref given with its snapshotId says why it is gone as stale_ref', () => {
  const directory = new PageDirectory('epoch');
  directory.registerRoute('route');
  directory.addPage('p1');
  directory.navigate('p1', { frameId: 'f1', route: 'route', loaderId: 'l1' });
  directory.addPage('p2');
  directory.navigate('p2', { frameId: 'f2', route: 'route', loaderId: 'l2' });
  const first = directory.publish([directory.binding(directory.stamp('p1'), 11)]);
  const other = directory.publish([directory.binding(directory.stamp('p2'), 12)]);
  const gone = (ref, pageId, snapshotId) => { try { directory.resolve(ref, pageId, snapshotId); } catch (error) { return { code: error.code, detail: error.detail }; } assert.fail('resolved'); };
  assert.equal(directory.resolve(first.refs[0], 'p1', first.snapshotId).backendNodeId, 11, 'a live ref acts with or without its snapshot');
  assert.equal(directory.resolve(first.refs[0], 'p1', other.snapshotId).backendNodeId, 11);
  assert.deepEqual(gone('e77', 'p1', 's99'), { code: 'stale_ref', detail: 'This session issued no snapshot s99; observe for current refs.' });
  assert.deepEqual(gone(other.refs[0], 'p1', other.snapshotId), { code: 'stale_ref', detail: `Ref ${other.refs[0]} is on another page (pageId p2); act with that pageId or observe this page.` });
  assert.deepEqual(gone('e77', 'p1', first.snapshotId), { code: 'stale_ref', detail: 'This session issued no ref e77; observe for current refs.' });
  directory.navigate('p1', { frameId: 'f1', route: 'route', loaderId: 'l3' });
  assert.deepEqual(gone(first.refs[0], 'p1', first.snapshotId), { code: 'stale_ref', detail: `The element ${first.refs[0]} named is gone: its page navigated or its frame went away. Observe again.` });
  assert.equal(gone(first.refs[0], 'p1').code, 'stale_target', 'without a snapshotId the code is unchanged');
  assert.match(gone(first.refs[0], 'p1').detail, /is gone: its page navigated/u);
  for (let index = 0; index < PageDirectory.SNAPSHOTS; index++) directory.publish([]);
  assert.deepEqual(gone(first.refs[0], 'p1', first.snapshotId), { code: 'stale_ref', detail: `Snapshot ${first.snapshotId} expired: refs stay valid for the last ${PageDirectory.SNAPSHOTS} observations. Observe again.` });
});

test('a rejected command says why on the receipt and on its step', async () => {
  const failures = [new EngineError('not_found', undefined, 'No button named "Reject all". 1 with that role: "Accept all".'), new EngineError('target_covered', undefined, 'div#consent "We use cookies"'), new EngineError('target_not_editable')];
  const executor = { bindPage: () => page, act: async () => { throw failures.shift(); }, observe: async () => ({ state: 'none' }), close: async () => {} };
  const engine = new SessionEngine('details', executor);
  const submit = commandId => engine.submit({ commandId, action: { kind: 'click', target: { kind: 'semantic', role: 'button', name: 'Reject all' } }, observe: 'none' });
  const found = await submit(1);
  assert.deepEqual([found.reason, found.dispatch, found.errorCode, found.detail, found.steps[0].detail],
    ['rejected', 'not_started', 'not_found', 'No button named "Reject all". 1 with that role: "Accept all".', 'No button named "Reject all". 1 with that role: "Accept all".']);
  const covered = await submit(2);
  assert.deepEqual([covered.errorCode, covered.steps[0].coveredBy, covered.detail], ['target_covered', 'div#consent "We use cookies"', 'Covered by div#consent "We use cookies"; dismiss or close it first.']);
  const plain = await submit(3);
  assert.equal(plain.errorCode, 'target_not_editable');
  assert.match(plain.detail, /disabled, hidden, out of reach/u, 'a failure site without its own detail gets what the code means');
  await engine.stop();
});

test('a 0x0 frame that keeps its 2 px border is not searched, so its stalled accessibility tree cannot block an action', async () => {
  // A tracking sandbox frame styled width/height 0 and visibility hidden: border box 4x4, content box empty. Chromium
  // never answers its accessibility query. A shown frame (content 100x50) is still searched.
  const child = { pageId: 'p1', frameId: 'sandbox', documentGeneration: 1 }, shown = { pageId: 'p1', frameId: 'shown', documentGeneration: 1 };
  const owners = { sandbox: 21, shown: 22 };
  const models = { 21: { width: 4, height: 4, content: [2, 17, 2, 17, 2, 17, 2, 17] }, 22: { width: 104, height: 54, content: [2, 2, 102, 2, 102, 52, 2, 52] } };
  const asked = [];
  const directory = {
    resolve: () => { throw new EngineError('stale_target'); },
    binding: (frame, backendNodeId) => ({ ...frame, backendNodeId }),
    frames: () => [page, child, shown], parent: frame => frame.frameId === 'f1' ? undefined : page,
    route: binding => binding.frameId === 'f1' ? 'route' : `${binding.frameId}-route`,
  };
  const resolver = new TargetResolver({ directory, pendingAttachments: () => 0, pendingFrames: () => 0, async send(binding, method, params) {
    if (method === 'DOM.getFrameOwner') return { backendNodeId: owners[params.frameId] };
    if (method === 'DOM.getBoxModel') return { model: models[params.backendNodeId] };
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'Accessibility.getPartialAXTree') return {};
    asked.push(binding.frameId);
    if (binding.frameId === 'sandbox') return new Promise(() => {});
    return { nodes: binding.frameId === 'f1' && params.role === 'heading' ? [node(5, 'heading', 'Is there a guarantee?')] : [] };
  } });
  const started = Date.now();
  assert.equal((await resolve(resolver, { kind: 'semantic', role: 'heading', name: 'Is there a guarantee?' })).backendNodeId, 5);
  assert.ok(Date.now() - started < 2000, 'resolved without waiting out the accessibility search limit');
  assert.ok(!asked.includes('sandbox'), 'the empty frame is never searched');
  assert.ok(asked.includes('shown'), 'a shown frame is still searched, so a second match there is still ruled out');
});

test('a selector that is not CSS says so instead of evidence_unavailable', async () => {
  const directory = { resolve: () => { throw new EngineError('stale_target'); }, binding: (frame, backendNodeId) => ({ ...frame, backendNodeId }),
    frames: () => [page], parent: () => undefined, route: () => 'route' };
  const resolver = new TargetResolver({ directory, pendingAttachments: () => 0, pendingFrames: () => 0, async send(_binding, method) {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    assert.equal(method, 'DOM.querySelectorAll');
    throw new Error('CDP command failed.: DOM Error while querying');
  } });
  const refused = await failure(resolve(resolver, { kind: 'selector', selector: 'h3:has-text("Guarantee")' }));
  assert.equal(refused.code, 'invalid_arguments');
  assert.match(refused.detail, /is not valid CSS/u);
});
