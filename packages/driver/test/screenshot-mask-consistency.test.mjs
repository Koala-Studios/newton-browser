import assert from 'node:assert/strict';
import {deflateSync, inflateSync} from 'node:zlib';
import test from 'node:test';
import {PageExecutor} from '../src/page-executor.ts';
import {CommandContext} from '../src/command-context.ts';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fixture({spatialReads = [spatial()], discoveryReads = [{regions: [], incomplete: false}], bbox = {x: 0, y: 0, width: 1, height: 1}}) {
  const controller = new AbortController();
  const calls = [];
  const png = rgbaPng(4, 4, [200, 30, 40, 255]);
  let spatialIndex = 0;
  let discoveryIndex = 0;
  let discovery;
  const connection = {
    epoch: 'epoch',
    claimGeneration: 1,
    rootTargetId: 'root',
    signal: controller.signal,
    wire: {
      async send(method, params = {}, sessionId) {
        calls.push({method, params, sessionId});
        if (method === 'Page.getLayoutMetrics') return spatialReads[Math.min(spatialIndex++, spatialReads.length - 1)];
        if (method === 'Runtime.evaluate') return {result: {value: 1}};
        if (method === 'DOM.resolveNode') return {object: {objectId: 'document-object'}};
        if (method === 'DOM.performSearch') {
          discovery=discoveryReads[Math.min(discoveryIndex++,discoveryReads.length-1)];
          return {searchId:`search-${discoveryIndex}`,resultCount:discovery.incomplete?33:discovery.regions.length};
        }
        if (method === 'DOM.getSearchResults') return {nodeIds:discovery.regions.map((_,index)=>index+1)};
        if (method === 'Runtime.callFunctionOn') return {result:{value:true}};
        if (method === 'DOM.getBoxModel') {
          const {x,y,width,height}=discovery.regions[params.nodeId-1];
          return {model:{border:[x,y,x+width,y,x+width,y+height,x,y+height]}};
        }
        if (method === 'Page.captureScreenshot') return {data: png.toString('base64')};
        return {};
      },
      onEvent() { return () => {}; },
    },
  };
  const executor = new PageExecutor(connection);
  const directory = executor.directory;
  directory.addPage('root');
  directory.registerRoute('root-route');
  directory.navigate('root', {frameId: 'root-frame', route: 'root-route', loaderId: 'root'});
  const page = directory.stamp('root');
  const binding = directory.binding(page, 42);
  executor.resolver.resolve = async () => binding;
  executor.resolver.inspect = async () => ({bbox});
  executor.resolver.document = async () => binding;
  executor.readonlyWorlds.context = async () => 1;
  return {executor, connection, page, context: new CommandContext(10_000), calls, png};
}

function spatial(overrides = {}) {
  return {
    cssVisualViewport: {clientWidth: 4, clientHeight: 4, offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, scale: 1, ...overrides},
    cssLayoutViewport: {clientWidth: 4, clientHeight: 4, pageX: 0, pageY: 0},
  };
}

const zones = [{kind: 'selector', selector: '#explicit'}];

test('synchronously throwing capture start does not strand observation ownership',async()=>{
  const {executor,connection,page,context,calls}=fixture({}),send=connection.wire.send.bind(connection.wire);
  connection.wire.send=(method,params,route)=>{
    if(method==='Runtime.evaluate'&&params.expression==='document.visibilityState')return Promise.resolve({result:{value:'hidden'}});
    if(method==='Page.startScreencast')throw Error('synchronous-start-failure');
    return send(method,params,route);
  };
  try{
    await assert.rejects(executor.screenshot(context,page,1_000_000,{fullPage:true,clip:{x:0,y:0,width:4,height:4}}),/synchronous-start-failure/);
    assert.equal(executor.captureObservations.size,0);
    assert.equal(calls.filter(x=>x.method==='Page.stopScreencast').length,1);
  }finally{context.dispose();}
});

test('capture-observation failures stop acquisition or close the connection when release fails',async()=>{
  for(const failure of ['start','capture','stop']){
    const {executor,connection,page,context}=fixture({});let stops=0,closed=0;
    connection.close=async()=>{closed++;};
    const send=connection.wire.send.bind(connection.wire);
    connection.wire.send=async(method,params,route)=>{
      if(method==='Runtime.evaluate'&&params.expression==='document.visibilityState')return {result:{value:'hidden'}};
      if(method==='Page.stopScreencast'){stops++;if(failure==='stop')throw Error('stop-failed');}
      if(method==='Page.startScreencast'&&failure==='start')throw Error('start-failed');
      if(method==='Page.captureScreenshot'&&failure==='capture')throw Error('capture-failed');
      return send(method,params,route);
    };
    try{
      await assert.rejects(executor.screenshot(context,page,1_000_000,{fullPage:true,clip:{x:0,y:0,width:4,height:4}}),new RegExp(failure+'-failed'));
      assert.equal(stops,1);assert.equal(closed,failure==='stop'?1:0);
      assert.equal(executor.captureObservations.size,0);
    }finally{context.dispose();}
  }
});

test('hidden full-page observation is bounded and stopped on its original route',async()=>{
  const {executor,connection,page,context,calls}=fixture({});
  const send=connection.wire.send.bind(connection.wire);
  connection.wire.send=async(method,params,route)=>method==='Runtime.evaluate'&&params.expression==='document.visibilityState'?{result:{value:'hidden'}}:send(method,params,route);
  try{
    await executor.screenshot(context,page,1_000_000,{fullPage:true,clip:{x:0,y:0,width:4,height:4}});
    const start=calls.find(x=>x.method==='Page.startScreencast'),stop=calls.find(x=>x.method==='Page.stopScreencast');
    assert.deepEqual(start.params,{format:'png',maxWidth:1,maxHeight:1});
    assert.equal(start.sessionId,'root-route');assert.equal(stop.sessionId,start.sessionId);
    assert.equal(executor.captureObservations.size,0);
    assert.equal(calls.filter(x=>x.method==='Page.stopScreencast').length,1);
    assert.ok(!calls.some(x=>x.method==='Page.screencastFrameAck'));
  }finally{context.dispose();}
});

test('cancelled late capture-observation start is stopped before another capture may own it',async()=>{
  const {executor,connection,page,context,calls}=fixture({});
  let releaseStart,started,stopped;
  const startSeen=new Promise(resolve=>started=resolve),stopSeen=new Promise(resolve=>stopped=resolve);
  const startReply=new Promise(resolve=>releaseStart=resolve),send=connection.wire.send.bind(connection.wire);
  connection.wire.send=async(method,params,route)=>{
    if(method==='Runtime.evaluate'&&params.expression==='document.visibilityState')return {result:{value:'hidden'}};
    if(method==='Page.startScreencast'){started();return startReply;}
    const result=await send(method,params,route);if(method==='Page.stopScreencast')stopped();return result;
  };
  const next=new CommandContext(10000),options={fullPage:true,clip:{x:0,y:0,width:4,height:4}};
  try{
    const pending=executor.screenshot(context,page,1_000_000,options);
    await startSeen;context.cancel();await assert.rejects(pending,{code:'cancelled'});
    await assert.rejects(executor.screenshot(next,page,1_000_000,options),{code:'evidence_unavailable'});
    releaseStart({});await stopSeen;
    assert.equal(calls.filter(x=>x.method==='Page.captureScreenshot').length,0);
    assert.equal(calls.find(x=>x.method==='Page.stopScreencast').sessionId,'root-route');
  }finally{releaseStart({});context.dispose();next.dispose();}
});

test('full-page recapture does not cross cancellation, navigation or pending frame attachment',async()=>{
  for(const fault of ['cancel','navigate','pending']){
    const {executor,connection,page,context,calls}=fixture({spatialReads:[spatial(),spatial({pageX:1})]});
    const send=connection.wire.send.bind(connection.wire);
    connection.wire.send=async(...args)=>{
      const result=await send(...args);
      if(args[0]==='Page.captureScreenshot'){
        if(fault==='cancel')context.cancel();
        if(fault==='pending')executor.pendingFrames.add('attaching-frame');
        if(fault==='navigate')executor.directory.navigate('root',{frameId:'root-frame',route:'root-route',loaderId:'new-document'});
      }
      return result;
    };
    try{
      await assert.rejects(executor.screenshot(context,page,1_000_000,{fullPage:true,clip:{x:0,y:0,width:4,height:4}}),error=>['cancelled','stale_target'].includes(error.code));
      assert.equal(calls.filter(call=>call.method==='Page.captureScreenshot').length,1,fault);
      assert.equal(executor.captures.size,0,fault);
    }finally{context.dispose();}
  }
});

test('full-page spatial transition recaptures once with fresh masks and only one published ID',async()=>{
  const {executor,page,context,calls}=fixture({
    spatialReads:[spatial(),spatial({pageX:1}),spatial({pageX:1}),spatial({pageX:1})],
    discoveryReads:[{regions:[]},{regions:[]},{regions:[{x:2,y:2,width:1,height:1}]},{regions:[{x:2,y:2,width:1,height:1}]}],
  });
  try{
    const result=await executor.screenshot(context,page,1_000_000,{fullPage:true,clip:{x:0,y:0,width:4,height:4}});
    assert.equal(calls.filter(call=>call.method==='Page.captureScreenshot').length,2);
    assert.equal(executor.captures.size,1);assert.equal(result.provenance.captureId,'c1');
    const pixels=decodeRgba(Buffer.from(result.imageData,'base64'),4,4);
    assert.deepEqual([...pixel(pixels,3,2,4)],[0,0,0,255]);
  }finally{context.dispose();}
});

test('full-page repeated spatial movement refuses without publishing a capture',async()=>{
  const {executor,page,context,calls}=fixture({spatialReads:[spatial(),spatial({pageX:1}),spatial({pageX:1}),spatial({pageX:2})]});
  try{
    await assert.rejects(executor.screenshot(context,page,1_000_000,{fullPage:true,clip:{x:0,y:0,width:4,height:4}}),{code:'stale_target'});
    assert.equal(calls.filter(call=>call.method==='Page.captureScreenshot').length,2);
    assert.equal(executor.captures.size,0);
  }finally{context.dispose();}
});

test('discovered sensitive regions are merged with explicit zones and masked', async () => {
  const fixtureState = fixture({
    bbox: {x: 0, y: 0, width: 1, height: 1},
    discoveryReads: [
      {regions: [{x: 2, y: 2, width: 1, height: 1}], incomplete: false},
      {regions: [{x: 2, y: 2, width: 1, height: 1}], incomplete: false},
    ],
  });
  const {executor, page, context, calls} = fixtureState;
  try {
    const result = await executor.screenshot(context, page, 1_000_000, {sensitiveZones: zones});
    const pixels = decodeRgba(Buffer.from(result.imageData, 'base64'), 4, 4);
    assert.deepEqual([...pixel(pixels, 0, 0, 4)], [0, 0, 0, 255]);
    assert.deepEqual([...pixel(pixels, 2, 2, 4)], [0, 0, 0, 255]);
    assert.deepEqual([...pixel(pixels, 1, 1, 4)], [200, 30, 40, 255]);
    assert.equal(calls.filter(call => call.method === 'Page.captureScreenshot').length, 1);
    assert.equal(executor.captures.size, 1);
  } finally {
    context.dispose();
  }
});

test('sensitive-region search overflow refuses capture before Page.captureScreenshot', async () => {
  const fixtureState = fixture({discoveryReads: [{regions: [{x: 2, y: 2, width: 1, height: 1}], incomplete: true}]});
  const {executor, page, context, calls} = fixtureState;
  try {
    await assert.rejects(
      executor.screenshot(context, page, 1_000_000, {sensitiveZones: zones}),
      error => error?.code === 'work_limit',
    );
    assert.equal(calls.filter(call => call.method === 'Page.captureScreenshot').length, 0);
    assert.equal(executor.captures.size, 0);
  } finally {
    context.dispose();
  }
});

test('changed discovered geometry rejects the captured image and registers no capture', async () => {
  const fixtureState = fixture({
    discoveryReads: [
      {regions: [{x: 2, y: 2, width: 1, height: 1}], incomplete: false},
      {regions: [{x: 2.5, y: 2, width: 1, height: 1}], incomplete: false},
    ],
  });
  const {executor, page, context, calls} = fixtureState;
  try {
    await assert.rejects(
      executor.screenshot(context, page, 1_000_000, {sensitiveZones: zones}),
      error => error?.code === 'stale_target',
    );
    assert.equal(calls.filter(call => call.method === 'Page.captureScreenshot').length, 1);
    assert.equal(executor.captures.size, 0);
  } finally {
    context.dispose();
  }
});

test('changed viewport geometry rejects the captured image and registers no capture', async () => {
  const fixtureState = fixture({
    spatialReads: [spatial(), spatial({pageX: 1})],
    discoveryReads: [
      {regions: [{x: 2, y: 2, width: 1, height: 1}], incomplete: false},
      {regions: [{x: 2, y: 2, width: 1, height: 1}], incomplete: false},
    ],
  });
  const {executor, page, context, calls} = fixtureState;
  try {
    await assert.rejects(
      executor.screenshot(context, page, 1_000_000, {sensitiveZones: zones}),
      error => error?.code === 'stale_target',
    );
    assert.equal(calls.filter(call => call.method === 'Page.captureScreenshot').length, 1);
    assert.equal(executor.captures.size, 0);
  } finally {
    context.dispose();
  }
});

function pixel(pixels, x, y, width) {
  const offset = (y * width + x) * 4;
  return pixels.subarray(offset, offset + 4);
}

function rgbaPng(width, height, color) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const start = y * (width * 4 + 1); rows[start] = 0;
    for (let x = 0; x < width; x += 1) for (let channel = 0; channel < 4; channel += 1) rows[start + 1 + x * 4 + channel] = color[channel] ?? 0;
  }
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function decodeRgba(input, width, height) {
  let offset = 8;
  const idat = [];
  while (offset < input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(input.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const rows = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) rows.copy(pixels, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
  return pixels;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0); name.copy(output, 4); data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return output;
}

function crc32(input) {
  let value = 0xffffffff;
  for (const byte of input) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
