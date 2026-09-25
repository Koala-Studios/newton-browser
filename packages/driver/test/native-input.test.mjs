import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeInput } from '../src/native-input.ts';
import { CommandContext } from '../src/command-context.ts';

test('cancellation after keydown releases only the attempted original-route key', async () => {
  const calls=[]; const context=new CommandContext(1000);
  const input=new NativeInput(context,{ route:()=> 'original',
    async send(_binding,method,params){calls.push({method,...params});context.cancel();},
    async release(route,method,params){calls.push({route,method,...params});},
  });
  try {
    await assert.rejects(input.chord({},['Control','a']),/cancelled/);
    await input.finish();
    assert.deepEqual(calls.map(call=>[call.type,call.key,call.route]),[['rawKeyDown','Control',undefined],['keyUp','Control','original']]);
    assert.equal(context.dispatch,'acknowledged');
  } finally{context.dispose();}
});

test('chords suppress printable characters under Control and release in reverse order', async()=>{
  const calls=[];const context=new CommandContext(1000);
  const input=new NativeInput(context,{route:()=> 'route',send:async(_b,_m,p)=>{calls.push(p);},release:async(_r,_m,p)=>{calls.push(p);}});
  try{
    await input.chord({},['Control','a']);await input.finish();
    assert.deepEqual(calls.map(call=>[call.type,call.key]),[['rawKeyDown','Control'],['rawKeyDown','a'],['keyUp','a'],['keyUp','Control']]);
    assert.ok(calls.every(call=>call.text===undefined));
    assert.equal(calls[1].modifiers,2);
    assert.equal(calls[2].modifiers,2);
    assert.equal(calls[3].modifiers,0);
  }finally{context.dispose();}
});

test('a focus guard changing after keydown prevents character dispatch and retains release', async()=>{
  const calls=[];const context=new CommandContext(1000);let guards=0;
  const input=new NativeInput(context,{route:()=> 'route',send:async(_b,_m,p)=>{calls.push(p);},release:async(_r,_m,p)=>{calls.push(p);}});
  try{
    await assert.rejects(input.chord({},['x'],async()=>{if(++guards===2)throw new Error('sensitive_target');}),/sensitive_target/);
    await input.finish();assert.deepEqual(calls.map(call=>call.type),['rawKeyDown','keyUp']);
  }finally{context.dispose();}
});

test('unsupported keys and invalid chords do not dispatch',async()=>{
  const context=new CommandContext(1000);let calls=0;
  const input=new NativeInput(context,{route:()=> 'route',send:async()=>{calls++;},release:async()=>{calls++;}});
  try{for(const keys of [['MadeUp'],['a','b'],['Control','Control','a']])await assert.rejects(input.chord({},keys),/invalid_arguments/);assert.equal(calls,0);}
  finally{context.dispose();}
});
