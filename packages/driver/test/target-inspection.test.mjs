import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { TargetResolver } from '../src/target-resolver.ts';
import { CommandContext } from '../src/command-context.ts';

test('verification preserves exact ordinary field values and refuses incomplete facts', async () => {
  const facts={sensitive:false,editable:true,connected:true,disabled:false,readonly:false,visible:true,focused:true,value:'support@example.com'};
  const resolver=new TargetResolver({directory:{},pendingAttachments:()=>0,pendingFrames:()=>0,async send(_b,method){return method==='DOM.resolveNode'?{object:{objectId:'o'}}:method==='Runtime.callFunctionOn'?{result:{value:facts}}:{};}});
  const context=new CommandContext(1000);
  try {
    assert.equal((await resolver.inspect(context,{})).value,facts.value);
    delete facts.visible;
    await assert.rejects(resolver.inspect(context,{}),/evidence_unavailable/);
  }finally{context.dispose();}
});

for (const allowSensitive of [false, true]) test(`sensitive inspection never accesses value, including masking mode ${allowSensitive}`, async () => {
  let valueReads = 0;
  const element = {
    tagName: 'INPUT', isConnected: true, isContentEditable: false, disabled: false, readOnly: false,
    getAttribute: name => name === 'type' ? 'password' : '',
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 20 }),
    get value() { valueReads++; return 'synthetic-do-not-inspect'; },
    get selectionStart() { throw new Error('sensitive selection accessed'); },
    get selectionEnd() { throw new Error('sensitive selection accessed'); },
  };
  element.ownerDocument = { activeElement: element };
  const resolver = new TargetResolver({ directory: {}, pendingAttachments: () => 0, pendingFrames: () => 0,
    async send(_binding, method, params) {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'test-object' } };
      if (method === 'Runtime.releaseObject') return {};
      assert.equal(method, 'Runtime.callFunctionOn');
      const inspect = vm.runInNewContext(`(${params.functionDeclaration})`, { getComputedStyle: () => ({ visibility: 'visible' }) });
      return { result: { value: inspect.call(element) } };
    },
  });
  const context = new CommandContext(1000);
  try {
    if (allowSensitive) {
      const facts = await resolver.inspect(context, {}, { editable: false, allowSensitive: true });
      assert.equal(facts.sensitive, true); assert.equal(facts.value, undefined);
    } else await assert.rejects(resolver.inspect(context, {}), /sensitive_target/);
    assert.equal(valueReads, 0, 'suppressing a returned value must not read it first');
  } finally { context.dispose(); }
});

test('a fixed box is in view even inside a clipped ancestor that does not contain it', async () => {
  const styles = new Map();
  const node = (name, rect, style, parent = null) => {
    const element = { tagName: name, isConnected: true, isContentEditable: false, disabled: false, readOnly: false, parentElement: parent,
      getAttribute: () => '', getBoundingClientRect: () => rect };
    styles.set(element, { visibility: 'visible', position: 'static', overflowX: 'visible', overflowY: 'visible', transform: 'none',
      perspective: 'none', filter: 'none', contain: 'none', willChange: 'auto', ...style });
    return element;
  };
  const view = { innerWidth: 390, innerHeight: 844 };
  const inspectWith = async element => {
    element.ownerDocument = { defaultView: view, activeElement: null };
    const resolver = new TargetResolver({ directory: {}, pendingAttachments: () => 0, pendingFrames: () => 0,
      async send(_binding, method, params) {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'o' } };
        if (method === 'Runtime.releaseObject') return {};
        const inspect = vm.runInNewContext(`(${params.functionDeclaration})`, { getComputedStyle: item => styles.get(item) });
        return { result: { value: inspect.call(element, true) } };
      } });
    const context = new CommandContext(1000);
    try { return (await resolver.inspect(context, {}, { editable: false, pointer: true })).pointerInView; } finally { context.dispose(); }
  };
  const body = node('BODY', { left: 0, top: 0, width: 390, height: 844 }, {});
  const wrapper = node('DIV', { left: 0, top: 0, width: 390, height: 0 }, { overflowX: 'hidden', overflowY: 'hidden' }, body);
  const close = node('BUTTON', { left: 340, top: 20, width: 30, height: 30 }, { position: 'fixed' }, wrapper);
  assert.equal(await inspectWith(close), true, 'the zero-height wrapper does not contain a fixed popup');
  const inline = node('BUTTON', { left: 340, top: 20, width: 30, height: 30 }, {}, wrapper);
  assert.equal(await inspectWith(inline), false, 'an ordinary child is clipped by the same wrapper');
  const transformed = node('DIV', { left: 0, top: 0, width: 390, height: 0 }, { overflowX: 'hidden', overflowY: 'hidden', transform: 'matrix(1, 0, 0, 1, 0, 0)' }, body);
  const contained = node('BUTTON', { left: 340, top: 20, width: 30, height: 30 }, { position: 'fixed' }, transformed);
  assert.equal(await inspectWith(contained), false, 'a transformed ancestor contains and clips a fixed box');
});
