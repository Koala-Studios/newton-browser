import test from 'node:test';
import assert from 'node:assert/strict';
import { nameMatches, readableName, rolesFor } from '../src/accessible-name.ts';
import { ENGINE_ERRORS, engineErrorDetail, parseEngineCommand, parseEngineTarget } from '../src/command-contract.ts';

test('names read without invisible characters and with one space between words', () => {
  assert.equal(readableName('​ Reject all'), 'Reject all');
  assert.equal(readableName('Accept  all\n cookies﻿'), 'Accept all cookies');
  assert.equal(readableName('Sign­in ⁠now‎'), 'Signin now');
  // Joiners stay in a shown name: emoji sequences and some scripts need them.
  assert.equal(readableName('Family \u{1F468}‍\u{1F469}'), 'Family \u{1F468}‍\u{1F469}');
});

test('a requested name matches as it reads: exact is equality, otherwise any part ignoring case', () => {
  for (const wanted of ['Reject all', '​ Reject all', ' Reject all', '​Reject all', 'Reject  all']) {
    assert.equal(nameMatches('​ Reject all', wanted, true), true, JSON.stringify(wanted));
  }
  assert.equal(nameMatches('​ Reject all', 'Reject', true), false);
  assert.equal(nameMatches('​ Reject all', 'reject all', true), false, 'exact keeps case');
  const dialog = 'Create a new sandbox Sandboxes are isolated test environments.';
  assert.equal(nameMatches(dialog, 'Create a new sandbox', false), true);
  assert.equal(nameMatches(dialog, 'create A NEW​ sandbox', false), true);
  assert.equal(nameMatches(dialog, 'Delete a sandbox', false), false);
  assert.equal(nameMatches('Café', 'Café', true), true, 'composed and decomposed accents are one name');
  assert.equal(nameMatches('Family \u{1F468}‍\u{1F469}', 'Family \u{1F468}\u{1F469}', true), true);
});

test('a role finds its ARIA subclass roles and nothing broader', () => {
  assert.deepEqual(rolesFor('dialog'), ['dialog', 'alertdialog']);
  assert.deepEqual(rolesFor('textbox'), ['textbox', 'searchbox']);
  assert.deepEqual(rolesFor('alertdialog'), ['alertdialog']);
  assert.deepEqual(rolesFor('button'), ['button']);
  assert.deepEqual(rolesFor('constructor'), ['constructor']);
});

test('a ref target carries the snapshotId observe gave with it', () => {
  assert.deepEqual(parseEngineTarget({ kind: 'ref', ref: 'e4', snapshotId: 's7' }), { kind: 'ref', ref: 'e4', snapshotId: 's7' });
  assert.deepEqual(parseEngineTarget({ kind: 'ref', ref: 'e4' }), { kind: 'ref', ref: 'e4' });
  const command = parseEngineCommand({ commandId: 1, action: { kind: 'click', target: { kind: 'ref', ref: 'e4', snapshotId: 's7' } } });
  assert.equal(command.action.target.snapshotId, 's7');
  for (const snapshotId of ['', 7, 's'.repeat(121), null]) assert.throws(() => parseEngineTarget({ kind: 'ref', ref: 'e4', snapshotId }), /invalid_arguments/);
  assert.throws(() => parseEngineTarget({ kind: 'selector', selector: '#a', snapshotId: 's1' }), /invalid_arguments/, 'only refs come from a snapshot');
});

test('every error code has a detail saying what it means', () => {
  for (const code of ENGINE_ERRORS) assert.match(engineErrorDetail(code), /^[A-Z].{10,200}\.$/u, code);
});
