import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {nativeSocketEndpoint} from '../apps/mcp-server/src/native-endpoint.ts';

test('native endpoints fit the platform socket limit regardless of configuration depth',async()=>{
  const epoch=randomUUID(),endpoint=await nativeSocketEndpoint(epoch);
  if(process.platform==='win32'){assert.equal(endpoint,`\\\\.\\pipe\\newton-browser-${epoch}`);return;}
  assert.ok(Buffer.byteLength(endpoint)<(process.platform==='darwin'?104:108),endpoint);
  const directory=fs.lstatSync(path.dirname(endpoint));
  assert.equal(directory.uid,process.getuid());assert.equal(directory.mode&0o077,0);
  assert.equal(await nativeSocketEndpoint(epoch),endpoint);
  assert.notEqual(await nativeSocketEndpoint(randomUUID()),endpoint);
});

test('native endpoints refuse non-UUID epochs before touching the filesystem',async()=>{
  for(const epoch of ['','../x','socket','A'.repeat(36),`${randomUUID()}/x`])await assert.rejects(nativeSocketEndpoint(epoch),/native_advertisement_invalid/);
});
