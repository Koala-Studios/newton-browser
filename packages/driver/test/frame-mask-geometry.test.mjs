import test from 'node:test';
import assert from 'node:assert/strict';
import {projectFrameMaskQuad} from '../src/frame-mask-geometry.ts';
const close=(actual,expected)=>actual.forEach((value,index)=>assert.ok(Math.abs(value-expected[index])<1e-8,`${value} != ${expected[index]}`));
test('frame masks map translation, rotation and nested scale',()=>{
  const child=[10,15,98,15,98,41,10,41];
  close(projectFrameMaskQuad(child,[300,330,500,330,500,430,300,430],200,100),[310,345,398,345,398,371,310,371]);
  const rotated=projectFrameMaskQuad(child,[300,0,300,200,200,200,200,0],200,100);
  close(rotated,[285,10,285,98,259,98,259,10]);
  close(projectFrameMaskQuad(rotated,[0,0,600,0,600,400,0,400],300,200),[570,20,570,196,518,196,518,20]);
});
test('perspective map uses projective coordinates rather than bilinear interpolation',()=>{
  // Independently specified map: x=(100+200u)/(1+u), y=200v/(1+u).
  const owner=[100,0,150,0,150,100,100,200];
  close(projectFrameMaskQuad([25,25,75,25,75,75,25,75],owner,100,100),[120,40,1000/7,200/7,1000/7,600/7,120,120]);
});
test('invalid, degenerate and horizon-crossing geometry is rejected',()=>{
  const square=[0,0,100,0,100,100,0,100];
  for(const owner of [[0,0,0,0,0,0,0,0],[0,0,100,100,100,0,0,100],[NaN,0,100,0,100,100,0,100]])assert.throws(()=>projectFrameMaskQuad(square,owner,100,100),/evidence_unavailable/);
  assert.throws(()=>projectFrameMaskQuad(square,square,0,100),/evidence_unavailable/);
  assert.throws(()=>projectFrameMaskQuad([-200,0,0,0,0,100,-200,100],[100,0,150,0,150,100,100,200],100,100),/evidence_unavailable/);
});
