import {EngineError} from '@newton-browser/core';

/** Map a child viewport quad through its iframe's content quad in the parent
 * CDP route. Perspective transforms require a projective map, not an offset.
 * Callers must use the child window's inner size, including scrollbar space.
 */
export function projectFrameMaskQuad(quad: readonly number[], owner: readonly number[], width: number, height: number): number[] {
  if(!validQuad(quad)||!validQuad(owner)||!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw new EngineError('evidence_unavailable');
  const [x0,y0,x1,y1,x2,y2,x3,y3]=owner as [number,number,number,number,number,number,number,number];
  const dx1=x1-x2,dx2=x3-x2,dx3=x0-x1+x2-x3;
  const dy1=y1-y2,dy2=y3-y2,dy3=y0-y1+y2-y3;
  let g=0,h=0;
  if(dx3!==0||dy3!==0){
    const determinant=dx1*dy2-dx2*dy1;
    if(!Number.isFinite(determinant)||Math.abs(determinant)<1e-9)throw new EngineError('evidence_unavailable');
    g=(dx3*dy2-dx2*dy3)/determinant;
    h=(dx1*dy3-dx3*dy1)/determinant;
  }
  const a=x1-x0+g*x1,b=x3-x0+h*x3,d=y1-y0+g*y1,e=y3-y0+h*y3;
  const result:number[]=[];
  let sign=0;
  for(let index=0;index<8;index+=2){
    const u=quad[index]!/width,v=quad[index+1]!/height,denominator=g*u+h*v+1;
    if(!Number.isFinite(denominator)||Math.abs(denominator)<1e-9||(sign&&Math.sign(denominator)!==sign))throw new EngineError('evidence_unavailable');
    sign=Math.sign(denominator);
    result.push((a*u+b*v+x0)/denominator,(d*u+e*v+y0)/denominator);
  }
  if(!validQuad(result))throw new EngineError('evidence_unavailable');
  return result;
}

function validQuad(quad:readonly number[]):boolean {
  if(quad.length!==8||!quad.every(Number.isFinite))return false;
  let sign=0;
  for(let index=0;index<4;index++){
    const next=(index+1)%4,after=(index+2)%4;
    const cross=(quad[next*2]!-quad[index*2]!)*(quad[after*2+1]!-quad[next*2+1]!)-(quad[next*2+1]!-quad[index*2+1]!)*(quad[after*2]!-quad[next*2]!);
    if(!Number.isFinite(cross)||Math.abs(cross)<1e-9||(sign&&Math.sign(cross)!==sign))return false;
    sign=Math.sign(cross);
  }
  return true;
}
