import assert from 'node:assert/strict';
import test from 'node:test';
import {parseEngineCommand} from '../src/command-contract.ts';
import {ENGINE_COMMAND_SCHEMA} from '../src/command-json-schema.ts';

const refTarget = {kind: 'ref', ref: 'e1'};
const selectorTarget = {kind: 'selector', selector: '#save'};

test('factored command schema keeps enclosing target and waitFor constraints with strict branch placeholders', () => {
  const action = ENGINE_COMMAND_SCHEMA.properties.action;
  const sequence = action.oneOf.find(branch => branch.properties?.kind?.const === 'sequence');
  assert.ok(sequence);
  assert.deepEqual(Object.keys(action.properties).sort(), ['target', 'waitFor']);
  assert.deepEqual(Object.keys(sequence.properties.steps.items.properties).sort(), ['target', 'waitFor']);
  assert.equal(action.oneOf.length, 18);
  assert.equal(sequence.properties.steps.items.oneOf.length, 17);

  for (const branch of [...action.oneOf.filter(branch => branch !== sequence), ...sequence.properties.steps.items.oneOf]) {
    assert.equal(branch.additionalProperties, false);
    if (Object.hasOwn(branch.properties, 'target')) assert.deepEqual(branch.properties.target, {});
    if (Object.hasOwn(branch.properties, 'waitFor')) assert.deepEqual(branch.properties.waitFor, {});
  }
  assert.equal(action.properties.target.oneOf.length, 3);
  assert.equal(action.properties.waitFor.allOf.length, 7);
});

test('factored command schema reconstructs the expanded target and waitFor branches', () => {
  const expanded = expandFactoredSchema(ENGINE_COMMAND_SCHEMA);
  const action = expanded.properties.action;
  const sequence = action.oneOf.find(branch => branch.properties?.kind?.const === 'sequence');
  assert.ok(sequence);
  assert.equal(action.properties, undefined);
  assert.equal(sequence.properties.steps.items.properties, undefined);
  assert.equal(countEmptyPlaceholders(expanded), 0);
  assert.equal(countPropertySchema(expanded, 'target'), 20);
  assert.equal(countPropertySchema(expanded, 'waitFor'), 8);

  const primitiveKinds = action.oneOf.filter(branch => branch !== sequence).map(branch => branch.properties.kind.const ?? branch.properties.kind.enum);
  assert.deepEqual(primitiveKinds, [
    'fill', 'type', 'clear', 'edit', 'click', 'hover', ['click_at', 'move'], 'select', 'press', 'scroll',
    'navigate', ['back', 'forward', 'reload'], 'wait_for', 'dialog_accept', 'dialog_dismiss', 'resize', 'set_files',
  ]);
  assert.equal(sequence.properties.steps.items.oneOf.every(branch => branch.additionalProperties === false), true);
});

test('valid and adversarial command corpus agrees with the strict runtime contract', () => {
  const valid = [
    {commandId: 1, action: {kind: 'fill', target: refTarget, value: 'typed'}},
    {commandId: 2, action: {kind: 'click', target: selectorTarget, waitFor: {url: 'https://example.org'}}},
    {commandId: 3, action: {kind: 'sequence', steps: [
      {kind: 'click', target: refTarget},
      {kind: 'wait_for', waitFor: {role: 'button', name: 'Save', state: 'visible'}},
    ]}},
    {commandId: 4, action: {kind: 'wait_for', waitFor: {value: 'ready', state: 'value', selector: '#status'}}},
  ];
  const invalid = [
    {commandId: 5, action: {kind: 'fill', target: {kind: 'ref', ref: 'e1', selector: '#mixed'}, value: 'x'}},
    {commandId: 6, action: {kind: 'wait_for', waitFor: {timeoutMs: 100}}},
    {commandId: 7, action: {kind: 'wait_for', waitFor: {value: 'ready'}}},
    {commandId: 8, action: {kind: 'navigate', url: 'https://example.org', target: refTarget}},
    {commandId: 9, action: {kind: 'click', target: refTarget, value: 'forbidden'}},
    {commandId: 10, action: {kind: 'sequence', steps: [{kind: 'click', target: refTarget, selector: '#forbidden'}]}},
    {commandId: 11, action: {kind: 'click', target: refTarget, waitFor: {ref: 'e1', selector: '#mixed'}}},
    {commandId: 12, action: {kind: 'click'}},
    {commandId: 13},
    {action: {kind: 'click', target: refTarget}},
  ];
  for (const command of valid) assert.doesNotThrow(() => parseEngineCommand(command), JSON.stringify(command));
  for (const command of invalid) assert.throws(() => parseEngineCommand(command), /invalid_arguments|unsupported field/u, JSON.stringify(command));
});

test('every primitive kind and enum alias parses standalone and inside a sequence', () => {
  const cases = [
    () => ({kind: 'fill', target: refTarget, value: 'x'}),
    () => ({kind: 'type', target: refTarget, value: 'x'}),
    () => ({kind: 'clear', target: refTarget}),
    () => ({kind:'edit',target:refTarget,match:'original',replacement:'new',prefix:'before ',suffix:' after',occurrence:1}),
    () => ({kind: 'click', target: refTarget}),
    () => ({kind: 'hover', target: refTarget}),
    () => ({kind: 'click_at', captureId: 'c1', x: 1, y: 2}),
    () => ({kind: 'move', captureId: 'c1', x: 1, y: 2}),
    () => ({kind: 'select', target: refTarget, value: 'one'}),
    () => ({kind: 'press', keys: ['Enter']}),
    () => ({kind: 'scroll', x: 0, y: 100}),
    () => ({kind: 'navigate', url: 'https://example.org'}),
    () => ({kind: 'back'}),
    () => ({kind: 'forward'}),
    () => ({kind: 'reload'}),
    () => ({kind: 'wait_for', waitFor: {url: 'https://example.org'}}),
    () => ({kind: 'dialog_accept', dialogId: 'dialog1'}),
    () => ({kind: 'dialog_dismiss', dialogId: 'dialog1'}),
    () => ({kind: 'resize', width: 640, height: 480}),
    () => ({kind: 'set_files', target: refTarget, files: ['C:\\fixture.png']}),
  ];
  assert.equal(cases.length, 20);
  for (const [index, makeAction] of cases.entries()) {
    assert.doesNotThrow(() => parseEngineCommand({commandId: 100 + index, action: makeAction()}));
    assert.doesNotThrow(() => parseEngineCommand({commandId: 200 + index, action: {kind: 'sequence', steps: [makeAction()]}}));
  }
});

test('hoisted-field boundaries reject malformed types and forbidden sequence placement', () => {
  const malformedTargets = [null, 'e1', ['e1']];
  for (const target of malformedTargets) {
    assert.throws(() => parseEngineCommand({commandId: 300, action: {kind: 'fill', target, value: 'x'}}), /invalid_arguments|unsupported field/u);
  }
  for (const waitFor of [null, 'done', ['done'], {timeoutMs: 100}, {role: 'button'}, {value: 'ready'}]) {
    assert.throws(() => parseEngineCommand({commandId: 301, action: {kind: 'wait_for', waitFor}}), /invalid_arguments|unsupported field/u);
  }
  assert.doesNotThrow(() => parseEngineCommand({commandId: 302, action: {kind: 'click', target: {kind: 'semantic', role: 'button', name: 'Save', exact: false}}}));
  for (const target of [
    {kind: 'semantic', name: 'Save'},
    {kind: 'semantic', role: 'button'},
    {kind: 'semantic', role: 'button', name: 'Save', exact: 'yes'},
  ]) assert.throws(() => parseEngineCommand({commandId: 303, action: {kind: 'click', target}}), /invalid_arguments|unsupported field/u);
  for (const action of [
    {kind: 'sequence', target: refTarget, steps: [{kind: 'click', target: refTarget}]},
    {kind: 'sequence', waitFor: {url: 'https://example.org'}, steps: [{kind: 'click', target: refTarget}]},
    {kind: 'sequence', steps: [{kind: 'sequence', steps: [{kind: 'click', target: refTarget}]}]},
    {kind: 'fill', target: refTarget, value: 'x', waitFor: {url: 'https://example.org'}},
  ]) assert.throws(() => parseEngineCommand({commandId: 304, action}), /invalid_arguments|unsupported field/u);
});

function expandFactoredSchema(schema) {
  const expanded = structuredClone(schema);
  const action = expanded.properties.action;
  const target = structuredClone(action.properties.target);
  const waitFor = structuredClone(action.properties.waitFor);
  const expandBranch = branch => {
    const properties = branch.properties ?? {};
    if (Object.hasOwn(properties, 'target') && Object.keys(properties.target).length === 0) properties.target = structuredClone(target);
    if (Object.hasOwn(properties, 'waitFor') && Object.keys(properties.waitFor).length === 0) properties.waitFor = structuredClone(waitFor);
    const steps = properties.steps;
    if (steps?.items?.oneOf) {
      for (const item of steps.items.oneOf) expandBranch(item);
      delete steps.items.properties;
    }
  };
  for (const branch of action.oneOf) expandBranch(branch);
  delete action.properties;
  return expanded;
}

function countEmptyPlaceholders(value) {
  if (!value || typeof value !== 'object') return 0;
  const own = Object.keys(value).length === 0 ? 1 : 0;
  return own + Object.values(value).reduce((count, child) => count + countEmptyPlaceholders(child), 0);
}

function countPropertySchema(value, propertyName) {
  if (!value || typeof value !== 'object') return 0;
  const own = value.properties?.[propertyName] ? 1 : 0;
  return own + Object.values(value).reduce((count, child) => count + countPropertySchema(child, propertyName), 0);
}
