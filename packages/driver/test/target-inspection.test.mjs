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
