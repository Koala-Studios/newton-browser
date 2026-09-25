import assert from 'node:assert/strict';
import {deflateSync, inflateSync} from 'node:zlib';
import test from 'node:test';
import {PageExecutor} from '../src/page-executor.ts';
import {CommandContext} from '../src/command-context.ts';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fixture({spatial, bbox, png}) {
  const controller = new AbortController();
  const calls = [];
  const connection = {
    epoch: 'epoch',
    claimGeneration: 1,
    rootTargetId: 'root',
    signal: controller.signal,
    wire: {
      async send(method, params = {}, sessionId) {
        calls.push({method, params, sessionId});
        if (method === 'Page.getLayoutMetrics') return spatial;
        if (method === 'Runtime.evaluate') return {result: {value: 1}};
        if (method === 'Page.captureScreenshot') return {data: png.toString('base64')};
        if (method === 'DOM.performSearch') return {searchId:'empty',resultCount:0};
        if (method === 'DOM.resolveNode') return {object:{objectId:'document'}};
        if (method === 'Runtime.callFunctionOn') return {result:{value:{regions:[],incomplete:false}}};
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
  executor.resolver.document=async()=>binding;
  executor.readonlyWorlds.context=async()=>1;
  return {executor, page, context: new CommandContext(10_000), calls, png};
}

const spatial = {
  cssVisualViewport: {clientWidth: 6, clientHeight: 6, offsetX: 2, offsetY: 3, pageX: 12, pageY: 23, scale: 1},
  cssLayoutViewport: {clientWidth: 6, clientHeight: 6, pageX: 12, pageY: 23},
};

test('screenshot masks the correct pixels after nonzero scroll and default clip origin', async () => {
  const png = rgbaPng(6, 6, [255, 20, 10, 255]);
  const fixtureState = fixture({spatial, png, bbox: {x: 3, y: 4, width: 2, height: 2}});
  const {executor, page, context, calls} = fixtureState;
  try {
    const result = await executor.screenshot(context, page, 1_000_000, {
      sensitiveZones: [{kind: 'selector', selector: '#secret'}],
    });
    const capture = calls.find(call => call.method === 'Page.captureScreenshot');
    assert.deepEqual(capture.params.clip, {x: 12, y: 23, width: 6, height: 6, scale: 1});
    assert.deepEqual(result.provenance.clip, {x: 12, y: 23, width: 6, height: 6});
    assertMaskedRect(result.imageData, 6, 6, 1, 1, 2, 2);
  } finally {
    context.dispose();
  }
});

test('screenshot applies viewport-to-document conversion inside an explicit clip', async () => {
  const png = rgbaPng(4, 4, [40, 80, 120, 255]);
  const fixtureState = fixture({spatial, png, bbox: {x: 1, y: 1, width: 2, height: 2}});
  const {executor, page, context, calls} = fixtureState;
  try {
    const result = await executor.screenshot(context, page, 1_000_000, {
      clip: {x: 10, y: 20, width: 4, height: 4},
      sensitiveZones: [{kind: 'selector', selector: '#secret'}],
    });
    const capture = calls.find(call => call.method === 'Page.captureScreenshot');
    assert.deepEqual(capture.params.clip, {x: 10, y: 20, width: 4, height: 4, scale: 1});
    assertMaskedRect(result.imageData, 4, 4, 1, 1, 2, 2);
  } finally {
    context.dispose();
  }
});

test('screenshot leaves a region outside the clip unchanged', async () => {
  const png = rgbaPng(4, 4, [40, 80, 120, 255]);
  const fixtureState = fixture({spatial, png, bbox: {x: 100, y: 100, width: 2, height: 2}});
  const {executor, page, context} = fixtureState;
  try {
    const result = await executor.screenshot(context, page, 1_000_000, {
      clip: {x: 10, y: 20, width: 4, height: 4},
      sensitiveZones: [{kind: 'selector', selector: '#outside'}],
    });
    assert.deepEqual(decodeRgba(Buffer.from(result.imageData,'base64'),4,4),decodeRgba(png,4,4));
    assert.equal(result.provenance.maskDisposition,'mask_not_applicable');
  } finally {
    context.dispose();
  }
});

function assertMaskedRect(base64, width, height, left, top, rectWidth, rectHeight) {
  const pixels = decodeRgba(Buffer.from(base64, 'base64'), width, height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    const inside = x >= left && x < left + rectWidth && y >= top && y < top + rectHeight;
    const expected = inside ? [0, 0, 0, 255] : [255, 20, 10, 255];
    if (width === 4) expected.splice(0, 4, ...(inside ? [0, 0, 0, 255] : [40, 80, 120, 255]));
    assert.deepEqual([...pixels.subarray(offset, offset + 4)], expected);
  }
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
  name.copy(output, 4); output.writeUInt32BE(data.length, 0); data.copy(output, 8);
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
