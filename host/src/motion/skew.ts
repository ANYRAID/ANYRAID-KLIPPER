// Skew transforms from klippy/extras/skew_correction.py. GPL-3.0-or-later.
export interface SkewFactors {xy:number;xz:number;yz:number;}
/** Immutable coefficients; operation order matches the original host. */
export class SkewCorrection {
 readonly factors:Readonly<SkewFactors>;
 constructor(factors:SkewFactors){
  if(![factors.xy,factors.xz,factors.yz].every(Number.isFinite))throw new RangeError('Invalid skew factors');
  this.factors=Object.freeze({xy:factors.xy,xz:factors.xz,yz:factors.yz});Object.freeze(this);
 }
 #transform(position:readonly number[],inverse:boolean):number[]{
  if(position.length!==4||!position.every(Number.isFinite))throw new RangeError('Invalid skew position');
  const [x,y,z,e]=position,{xy,xz,yz}=this.factors;
  const result=inverse?[x+y*xy+z*xz,y+z*yz,z,e]:[x-y*xy-z*(xz-xy*yz),y-z*yz,z,e];
  if(!result.every(Number.isFinite))throw new RangeError('Skew coordinate overflow');return result;
 }
 apply(position:readonly number[]){return this.#transform(position,false);}
 unapply(position:readonly number[]){return this.#transform(position,true);}
}
/** Diagonals AC/BD and side AD of the measurement parallelogram.
 * Normalize before squaring to avoid overflow/underflow. cot(acos(c)) avoids
 * subtracting nearly equal angles and gives exactly zero for a square. */
export function measuredSkew(ac:number,bd:number,ad:number):number{
 if(![ac,bd,ad].every(v=>Number.isFinite(v)&&v>0))throw new RangeError('Invalid skew measurement');
 const scale=Math.max(ac,bd,ad),a=ac/scale,b=bd/scale,d=ad/scale;
 const side=Math.sqrt(2*a*a+2*b*b-4*d*d)/2;
 const cosine=((a-b)*(a+b))/(4*side*d);
 if(!(side>0)||!Number.isFinite(cosine)||Math.abs(cosine)>=1)throw new RangeError('Degenerate skew measurement');
 const factor=cosine/Math.sqrt((1-cosine)*(1+cosine));
 if(!Number.isFinite(factor))throw new RangeError('Unrepresentable skew measurement');return factor;
}
