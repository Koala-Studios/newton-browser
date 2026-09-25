import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {nativeRegistrationMatches} from '../apps/mcp-server/src/native-install.ts';

test('native unregister requires one exact manifest path, never a substring or another value',()=>{
  const manifest=path.resolve('owned-native','manifest.json');
  const output=value=>`HKEY_CURRENT_USER\\fixture\r\n    (Default)    REG_SZ    ${value}\r\n`;
  assert.equal(nativeRegistrationMatches(output(manifest),manifest),true);
  assert.equal(nativeRegistrationMatches(output(manifest+'.other'),manifest),false);
  assert.equal(nativeRegistrationMatches(output(path.resolve('other-native','manifest.json')),manifest),false);
  assert.equal(nativeRegistrationMatches(output(manifest)+output(manifest),manifest),false);
  assert.equal(nativeRegistrationMatches(`unrelated text ${manifest}`,manifest),false);
});
