import test from 'node:test';
import assert from 'node:assert/strict';
import { readAXControls } from '../src/control-reader.ts';

const role = (value) => ({ value });
const name = (value) => ({ value });
const property = (propertyName, value) => ({ name: propertyName, value: { value } });
const node = (nodeId, backendDOMNodeId, roleName, label, extra = {}) => ({ nodeId, backendDOMNodeId, role: role(roleName), name: name(label), ...extra });

function control(result, backendDOMNodeId) {
  return result.controls.find((entry) => entry.backendNodeId === backendDOMNodeId)?.view;
}

test('duplicate row controls keep distinct context and scoped traversal', () => {
  const raw = [
    node('root', 1, 'RootWebArea', 'Root', { childIds: ['row-a', 'row-b', 'scope', 'outside'] }),
    node('row-a', 10, 'row', 'Row A', { parentId: 'root', childIds: ['button-a'] }),
    node('row-b', 11, 'row', 'Row B', { parentId: 'root', childIds: ['button-b'] }),
    node('button-a', 101, 'button', 'Delete', { parentId: 'row-a' }),
    node('button-b', 102, 'button', 'Delete', { parentId: 'row-b' }),
    node('scope', 20, 'group', 'Scoped group', { parentId: 'root', childIds: ['inside', 'nested'] }),
    node('inside', 201, 'button', 'Inside', { parentId: 'scope' }),
    node('nested', 21, 'group', 'Nested group', { parentId: 'scope', childIds: ['nested-button'] }),
    node('nested-button', 202, 'button', 'Nested', { parentId: 'nested' }),
    node('outside', 203, 'button', 'Outside', { parentId: 'root' }),
  ];
  const all = readAXControls(raw);
  assert.equal(control(all, 101).context[0].name, 'Row A');
  assert.equal(control(all, 102).context[0].name, 'Row B');
  const scoped = readAXControls(raw, 20);
  assert.equal(scoped.foundScope, true);
  assert.deepEqual(scoped.controls.map((entry) => entry.backendNodeId), [201, 202]);
  assert.equal(scoped.controls.some((entry) => entry.backendNodeId === 203), false);
  const emptyScope = readAXControls([...raw, node('empty', 30, 'group', 'Empty', { parentId: 'root' })], 30);
  assert.deepEqual(emptyScope.controls, []);
  assert.equal(emptyScope.foundScope, true);
  const missingScope = readAXControls(raw, 999);
  assert.deepEqual(missingScope.controls, []);
  assert.equal(missingScope.foundScope, false);
});

test('cyclic ancestry and oversized labels/context terminate as incomplete', () => {
  const cyclic = [
    node('a', 10, 'group', 'A', { parentId: 'b' }),
    node('b', 11, 'row', 'B', { parentId: 'a' }),
    node('button', 100, 'button', 'Cyclic button', { parentId: 'a' }),
  ];
  const cycleResult = readAXControls(cyclic);
  assert.equal(cycleResult.incomplete, true);
  assert.ok(control(cycleResult, 100));

  const deep = [
    node('c1', 201, 'group', 'One', { parentId: 'c2' }),
    node('c2', 202, 'row', 'Two', { parentId: 'c3' }),
    node('c3', 203, 'form', 'Three', { parentId: 'c4' }),
    node('c4', 204, 'dialog', 'Four', { parentId: 'button' }),
    node('button', 205, 'button', 'x'.repeat(300), { parentId: 'c1' }),
  ];
  const deepResult = readAXControls(deep);
  assert.equal(deepResult.incomplete, true);
  assert.equal(control(deepResult, 205).name.length, 256);
  assert.equal(control(deepResult, 205).context.length, 3);
});

test('descriptions, error relationships, and sensitive values are handled safely', () => {
  let valueRead = false;
  const sensitive = node('sensitive', 301, 'textbox', 'Secret field', { properties: [] });
  Object.defineProperty(sensitive, 'value', { get() { valueRead = true; throw new Error('sensitive AX value read'); } });
  const raw = [
    node('root', 1, 'RootWebArea', 'Root', { childIds: ['field', 'error', 'sensitive'] }),
    node('field', 302, 'textbox', 'Email', {
      parentId: 'root',
      description: name('Use your work email'),
      properties: [
        { name: 'invalid', value: { value: true } },
        { name: 'errormessage', value: { relatedNodes: [{ backendDOMNodeId: 303 }, { backendDOMNodeId: 303 }, { text: 'fallback error' }] } },
      ],
    }),
    node('error', 303, 'alert', 'Email is invalid', { parentId: 'root' }),
    sensitive,
  ];
  const result = readAXControls(raw);
  const field = control(result, 302);
  assert.equal(valueRead, false);
  assert.equal(field.description, 'Use your work email');
  assert.equal(field.invalid, true);
  assert.deepEqual(field.validation, ['Email is invalid', 'fallback error']);
  assert.ok(control(result, 301));
});

test('string tristate checked values remain useful', () => {
  const result = readAXControls([
    node('true', 401, 'checkbox', 'True', { properties: [property('checked', 'true')] }),
    node('false', 402, 'checkbox', 'False', { properties: [property('checked', 'false')] }),
    node('mixed', 403, 'checkbox', 'Mixed', { properties: [property('checked', 'mixed')] }),
  ]);
  assert.deepEqual([control(result, 401).checked, control(result, 402).checked, control(result, 403).checked], [true, false, 'mixed']);
});
