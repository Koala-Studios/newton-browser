import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionEngine } from '../src/session-engine.ts';
import { CommandContext } from '../src/command-context.ts';
import { PageDirectory } from '../src/page-directory.ts';

class Clock {
  time = 0; timers = new Set();
  now = () => this.time;
  schedule = (fn, ms) => { const timer = { fn, at: this.time + ms }; this.timers.add(timer); return () => this.timers.delete(timer); };
  advance(ms) { this.time += ms; for (const t of [...this.timers]) if (t.at <= this.time) { this.timers.delete(t); t.fn(); } }
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const request = (commandId, value = 'text') => ({ commandId, action: { kind: 'fill', target: { kind: 'ref', ref: 'e1' }, value } });
const page = { pageId: 'p1', frameId: 'f1', documentGeneration: 1 };
const executor = (act, close = async () => {}) => ({ bindPage: () => page, act, observe: async () => ({ state: 'none' }), close });

test('uncertain input cleanup closes the executor and cancels queued mutations', async () => {
  const { EngineError }=await import('@newton-browser/core');
  let actions=0,closed=0;
  const engine=new SessionEngine('cleanup',executor(async()=>{actions++;throw new EngineError('cleanup_uncertain');},async()=>{closed++;}));
  const first=engine.submit(request(1)); const second=engine.submit(request(2));
  assert.equal((await first).errorCode,'cleanup_uncertain');
  assert.equal((await second).dispatch,'not_started');
  await tick();assert.equal(actions,1);assert.equal(closed,1);
  assert.throws(()=>engine.submit(request(3)),/session_closed/);
});

test('sequences continue after input without an expectation and bind later steps to the same page current document', async () => {
  let generation = 1; const seen = [];
  const ex = executor(async (_context, admitted) => {
    seen.push(admitted.documentGeneration); generation++;
    return seen.length === 1 ? { state: 'not_requested' } : { state: 'met', kind: 'value' };
  });
  ex.bindPage = pageId => { assert.ok(pageId === undefined || pageId === 'p1'); return { ...page, documentGeneration: generation }; };
  const engine = new SessionEngine('sequence', ex);
  const result = await engine.submit({ commandId: 1, observe: 'none', action: { kind: 'sequence', steps: [
    { kind: 'click', target: { kind: 'ref', ref: 'e1' } },
    { kind: 'fill', target: { kind: 'selector', selector: '#next' }, value: 'done' },
  ] } });
  assert.deepEqual(seen, [1, 2]); assert.equal(result.steps.length, 2);
});

test('a failed local postcondition identifies the stopped sequence step', async () => {
  const engine = new SessionEngine('sequence', executor(async () => ({ state: 'not_met', kind: 'value' })));
  const result = await engine.submit({ commandId: 1, observe: 'none', action: { kind: 'sequence', steps: [request(1).action, request(2).action] } });
  assert.equal(result.steps.length, 1); assert.equal(result.stoppedAt, 0);
});

test('record deltas use document node identities, reset missing baselines, and never strand the read queue', async () => {
  let snapshot=0;
  const ex=executor(async()=>({state:'met',kind:'value'}));
  ex.observe=async()=>({state:'available',trust:'untrusted_page_content',scope:'page',snapshotId:`s${++snapshot}`,
    nodes:[{ref:`e${snapshot}`,recordId:'node1',role:'button',name:'Save',readonly:false,disabled:false}]});
  const engine=new SessionEngine('records',ex);
  const first=await engine.observe({mode:'records'});
  const next=await engine.observe({mode:'records',previousSnapshotId:first.snapshotId});
  assert.deepEqual(next.delta.added,[]);assert.deepEqual(next.delta.removed,[]);assert.deepEqual(next.delta.changed,[]);
  const reset=await engine.observe({mode:'records',previousSnapshotId:'missing'});
  assert.equal(reset.delta.reset,true);assert.equal(reset.records.length,1);
  assert.equal((await engine.observe()).state,'available');
});

test('duplicate joins; conflict and expired IDs cannot replay input', async () => {
  const clock = new Clock(); const held = deferred(); let inputs = 0;
  const engine = new SessionEngine('test', executor(async c => { await c.input(async () => { inputs++; await held.promise; }); return { state: 'met', kind: 'value' }; }), { clock });
  const first = engine.submit(request(1)); assert.equal(engine.submit(request(1)), first);
  assert.throws(() => engine.submit(request(1, 'different')), /command_id_conflict/);
  held.resolve(); const result = await first;
  assert.equal(result.dispatch, 'acknowledged'); assert.equal(inputs, 1); assert.ok(Object.isFrozen(result));
  clock.advance(600001); assert.throws(() => engine.submit(request(1)), /command_expired/);
  assert.equal(engine.nextCommandId, 2);
});

test('deadline during held input closes independently and never starts queued input', async () => {
  const clock = new Clock(); const held = deferred(); let inputs = 0; let closed = 0;
  const engine = new SessionEngine('test', executor(async c => {
    await c.input(async () => { inputs++; await held.promise; });
    await c.input(async () => { inputs++; }); return { state: 'met', kind: 'value' };
  }, async () => { closed++; }), { clock, reconciliationMs: 20 });
  const first = engine.submit({ ...request(1), timeoutMs: 10 }); const second = engine.submit(request(2));
  clock.advance(10); await tick(); assert.equal(engine.command(1).state, 'reconciling');
  clock.advance(20); await tick();
  const result = await first; assert.equal(result.reason, 'timed_out'); assert.equal(result.dispatch, 'attempted');
  assert.equal((await second).dispatch, 'not_started'); assert.equal(closed, 1);
  held.resolve(); await tick(); assert.equal(inputs, 1); assert.equal(result.dispatch, 'attempted');
});

test('stop invokes cleanup while an input has not settled', async () => {
  const held = deferred(); let closed = 0;
  const engine = new SessionEngine('test', executor(async c => { await c.input(() => held.promise); return { state: 'met', kind: 'value' }; }, async () => { closed++; held.resolve(); }));
  const result = engine.submit(request(1)); await engine.stop();
  assert.equal(closed, 1); assert.equal((await result).reason, 'cancelled');
  assert.throws(() => engine.submit(request(2)), /session_closed/);
});

test('optional observation failure preserves acknowledged input and verified value', async () => {
  const ex = executor(async c => { await c.input(async () => {}); return { state: 'met', kind: 'value' }; });
  ex.observe = async () => { throw new Error('page secret must not escape'); };
  const result = await new SessionEngine('test', ex).submit(request(1));
  assert.equal(result.reason, 'completed'); assert.equal(result.dispatch, 'acknowledged');
  assert.equal(result.postcondition.state, 'met'); assert.equal(result.observation.state, 'unavailable');
  assert.ok(!JSON.stringify(result).includes('page secret'));
});

test('deadline during optional read preserves verified action and leaves the next command usable',async()=>{
  const clock=new Clock(),held=deferred();let closed=0,actions=0;
  const ex=executor(async context=>{actions++;await context.input(async()=>{});return {state:'met',kind:'value'};},async()=>{closed++;});
  ex.observe=async context=>context.read(()=>held.promise);
  const engine=new SessionEngine('optional-deadline',ex,{clock});
  const pending=engine.submit({...request(1),timeoutMs:10});await tick();clock.advance(10);await tick();
  const result=await pending;
  assert.equal(result.reason,'completed');assert.equal(result.dispatch,'acknowledged');assert.equal(result.postcondition.state,'met');
  assert.deepEqual(result.observation,{state:'unavailable',errorCode:'timed_out'});assert.equal(closed,0);
  const next=await engine.submit({...request(2),observe:'none'});assert.equal(next.reason,'completed');assert.equal(actions,2);
  held.resolve({state:'none'});await tick();assert.equal(actions,2);assert.equal(closed,0);
});

test('queue capacity is checked before consuming IDs and queued page is bound', async () => {
  const held = deferred(); let selected = page; const pages = [];
  const ex = executor(async (c, p) => { pages.push(p.pageId); await c.read(() => held.promise); return { state: 'met', kind: 'value' }; });
  ex.bindPage = () => selected;
  const engine = new SessionEngine('test', ex); const results = [];
  for (let i = 1; i <= 32; i++) results.push(engine.submit(request(i)));
  assert.throws(() => engine.submit(request(33)), /queue_full/); assert.equal(engine.nextCommandId, 33);
  selected = { ...page, pageId: 'popup' }; held.resolve(); await Promise.all(results);
  assert.deepEqual(new Set(pages), new Set(['p1']));
});

test('context rejects post-cancel primitives and never upgrades an unknown input acknowledgement', async () => {
  const c = new CommandContext(1000);
  await assert.rejects(c.input(async () => { throw new Error('lost'); }));
  await c.input(async () => {}); assert.equal(c.dispatch, 'attempted');
  c.cancel(); await assert.rejects(c.input(async () => assert.fail('input after cancel')), /cancelled/); c.dispose();
});

test('queued timeout includes admission time and reports no input without waiting for the active command', async () => {
  const clock = new Clock(); const held = deferred();
  const engine = new SessionEngine('test', executor(async c => { await c.read(() => held.promise); return { state: 'met', kind: 'value' }; }), { clock });
  const active = engine.submit(request(1)); const queued = engine.submit({ ...request(2), timeoutMs: 5 });
  clock.advance(5); await tick(); const result = await queued;
  assert.equal(result.reason, 'timed_out'); assert.equal(result.dispatch, 'not_started');
  held.resolve(); await active;
});

test('per-step facts do not inherit previous acknowledgement or previous value verification', async () => {
  let step = 0;
  const engine = new SessionEngine('test', executor(async c => {
    if (step++) throw new Error('missing'); await c.input(async () => {}); return { state: 'met', kind: 'value' };
  }));
  const result = await engine.submit({ commandId: 1, action: { kind: 'sequence', steps: [request(1).action, request(1).action] } });
  assert.equal(result.dispatch, 'acknowledged'); assert.equal(result.steps[1].dispatch, 'not_started');
  assert.equal(result.postcondition.state, 'unknown'); assert.equal(result.stoppedAt, 1);
});

test('document and snapshot generations are independent; late OOPIF detach is harmless', () => {
  const d = new PageDirectory('epoch'); d.addPage('p1');
  d.registerRoute('a'); d.registerRoute('b');
  d.navigate('p1', { frameId: 'root', route: 'a', loaderId: 'l1' });
  let stamp = d.stamp(); let binding = d.binding(stamp, 7); let one = d.publish([binding]);
  d.navigate('p1', { frameId: 'root', route: 'b', loaderId: 'l1' }); d.detachRoute('a');
  assert.throws(() => d.resolve(one.refs[0], 'p1'), /stale_target/);
  stamp=d.stamp();binding=d.binding(stamp,7);one=d.publish([binding]);
  assert.equal(d.route(d.resolve(one.refs[0], 'p1')), 'b');
  d.navigate('p1', { frameId: 'root', route: 'a', loaderId: 'late' });
  assert.equal(d.route(binding),'b');
  const three = d.publish([binding]);
  assert.equal(three.refs[0], one.refs[0], 'the same live element keeps its ref');
  for (let index = 0; index < 6; index++) d.publish([]);
  const other = d.publish([d.binding(stamp, 8)]);
  assert.deepEqual(other.expiredSnapshots, [one.snapshotId]);
  assert.equal(d.route(d.resolve(one.refs[0], 'p1')), 'b', 'a ref lives while any retained snapshot lists it');
  assert.deepEqual(d.publish([]).expiredSnapshots, [three.snapshotId]); assert.throws(() => d.resolve(one.refs[0], 'p1'), /stale_target/);
  d.navigate('p1', { frameId: 'root', route: 'b', loaderId: 'l2' });
  assert.throws(() => d.resolve(other.refs[0], 'p1'), /stale_target/);
  assert.equal(d.stamp().documentGeneration, stamp.documentGeneration + 1);
});

test('reads share the queue but never consume public mutation IDs', async () => {
  const held = deferred(); const order = [];
  const ex = executor(async c => { order.push('fill'); await c.read(() => held.promise); return { state: 'met', kind: 'value' }; });
  ex.observe = async () => { order.push('read'); return { state: 'none' }; };
  const engine = new SessionEngine('test', ex);
  const action = engine.submit({ ...request(1), observe: 'none' }); const read = engine.observe();
  assert.deepEqual(order, ['fill']); assert.equal(engine.nextCommandId, 2);
  held.resolve(); await action; await read;
  assert.deepEqual(order, ['fill', 'read']); assert.equal(engine.nextCommandId, 2);
});

test('a lane read changes selection only after actions queued before it (page select, D12)', async () => {
  const order = [], gate = deferred();
  const engine = new SessionEngine('select', executor(async () => { order.push('act'); await gate.promise; return { state: 'met', kind: 'value' }; }));
  const action = engine.submit(request(1));
  const selected = engine.observe({ pageId: 'p1', beforeRead: () => order.push('select') });
  await tick();
  assert.deepEqual(order, ['act'], 'selection waits for the queued action');
  gate.resolve();
  await action; await selected;
  assert.deepEqual(order, ['act', 'select']);
  const { EngineError } = await import('@newton-browser/core');
  const failed = await engine.observe({ beforeRead: () => { throw new EngineError('unknown_page'); } });
  assert.deepEqual(failed, { state: 'unavailable', errorCode: 'unknown_page' });
  assert.equal((await engine.observe()).state, 'none', 'the lane keeps working');
});

test('a command that never settles restarts its page and keeps the session; without recovery the session is quarantined (D11)', async () => {
  const clock = new Clock();
  const hung = () => new Promise(() => {});
  const ex = executor(hung);
  let recovered = 0;
  ex.recover = async admitted => { recovered++; assert.equal(admitted.pageId, 'p1'); return { pageId: 'p2', url: 'https://example.com/app' }; };
  const engine = new SessionEngine('recover', ex, { clock, reconciliationMs: 250 });
  const receipt = engine.submit({ ...request(1), timeoutMs: 1000 });
  await tick(); clock.advance(1000); await tick(); clock.advance(250); await tick();
  const result = await receipt;
  assert.equal(recovered, 1);
  assert.deepEqual(result.pageRestarted, { pageId: 'p2', url: 'https://example.com/app' });
  assert.equal(result.reason, 'timed_out');
  assert.equal(engine.state, 'open');

  let closed = 0;
  const plain = new SessionEngine('plain', executor(hung, async () => { closed++; }), { clock, reconciliationMs: 250 });
  const stuck = plain.submit({ ...request(1), timeoutMs: 1000 });
  await tick(); clock.advance(1000); await tick(); clock.advance(250); await tick();
  assert.equal((await stuck).pageRestarted, undefined);
  assert.notEqual(plain.state, 'open');
  assert.equal(closed, 1);
});
