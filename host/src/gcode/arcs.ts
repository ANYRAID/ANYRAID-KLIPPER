// Arc interpolation port from klippy/extras/gcode_arcs.py; GPL-3.0-or-later.
// Original Copyright (C) 2019 Aleksej Vasiljkovic.
// Marlin algorithm Copyright (C) 2011 Camiel Gubbels / Erik van der Zalm.
import {GCodeError,type GCodeDispatch} from './dispatch.ts';
import type {GCodeMove,Parameters} from './move.ts';
import {parseConfigurationFloat} from '../moonraker/config-reader.ts';
export type ArcPlane=0|1|2;
export interface ArcPlan {points:Float64Array;segments:number;extrusion:boolean;feed:number|undefined;}
function value(params:Parameters,key:string,fallback?:number):number|undefined {
 if(!Object.hasOwn(params,key))return fallback;
 const raw=params[key];let n:number;try{n=typeof raw==='number'?raw:parseConfigurationFloat(raw);}catch{throw new GCodeError(`Invalid arc ${key}`);}
 if(!Number.isFinite(n))throw new GCodeError(`Invalid arc ${key}`);return n;
}
export function validateArcResolution(resolution:number):number {if(!Number.isFinite(resolution)||resolution<=0)throw new RangeError('Invalid arc resolution');return resolution;}
/** Fully validate and own geometry before admission; never silently coarsen an
 * over-budget arc. Coordinates remain G-code coordinates for the usual guards. */
export function planArc(current:readonly number[],absoluteExtrude:boolean,params:Parameters,clockwise:boolean,plane:ArcPlane=0,resolution=1):ArcPlan {
 validateArcResolution(resolution);if(current.length<4||!current.every(Number.isFinite)||![0,1,2].includes(plane))throw new GCodeError('Invalid arc origin or plane');
 const target=['X','Y','Z'].map((name,i)=>value(params,name,current[i])!);
 if(value(params,'R')!==undefined)throw new GCodeError('G2/G3 does not support R moves');
 const i=value(params,'I',0)!,j=value(params,'J',0)!,k=plane===0?0:value(params,'K',0)!,offset=plane===0?[i,j]:plane===1?[i,k]:[j,k],axes=plane===0?[0,1,2]:plane===1?[0,2,1]:[1,2,0],a=axes[0],b=axes[1],h=axes[2];
 if(!offset[0]&&!offset[1])throw new GCodeError('G2/G3 requires IJ, IK or JK parameters');
 const rp=-offset[0],rq=-offset[1],cp=current[a]-rp,cq=current[b]-rq,ta=target[a]-cp,tb=target[b]-cq,cross=rp*tb-rq*ta,dot=rp*ta+rq*tb;
 if(![cp,cq,ta,tb,cross,dot].every(Number.isFinite))throw new GCodeError('Arc geometry overflow');
 let angle=Math.atan2(cross,dot);if(angle<0)angle+=2*Math.PI;if(clockwise)angle-=2*Math.PI;
 if(angle===0&&current[a]===target[a]&&current[b]===target[b])angle=2*Math.PI;
 const linear=target[h]-current[h],flat=Math.hypot(rp,rq)*angle,length=linear?Math.hypot(flat,linear):Math.abs(flat),segments=Math.max(1,Math.floor(length/resolution));
 if(!Number.isFinite(length)||!Number.isSafeInteger(segments)||segments>100000)throw new GCodeError('Arc exceeds segment capacity');
 const e=value(params,'E'),feed=value(params,'F');if(feed!==undefined&&feed<=0)throw new GCodeError('Invalid arc F');
 let base=absoluteExtrude?current[3]:0;const perE=e===undefined?0:(e-base)/segments,perAngle=angle/segments,perLinear=linear/segments;
 if(!Number.isFinite(perE))throw new GCodeError('Arc extrusion overflow');
 const points=new Float64Array(segments*4);
 for(let n=1;n<=segments;n++){
  const p=(n-1)*4,theta=n*perAngle,cos=Math.cos(theta),sin=Math.sin(theta);
  points[p+a]=cp+(-offset[0]*cos+offset[1]*sin);points[p+b]=cq+(-offset[0]*sin-offset[1]*cos);points[p+h]=current[h]+n*perLinear;
  if(n===segments)for(let axis=0;axis<3;axis++)points[p+axis]=target[axis];
  points[p+3]=perE?base+perE:current[3];if(absoluteExtrude)base+=perE;
  for(let axis=0;axis<4;axis++)if(!Number.isFinite(points[p+axis]))throw new GCodeError('Arc coordinate overflow');
 }
 return {points,segments,extrusion:perE!==0,feed};
}
export function arcSegment(plan:ArcPlan,index:number):Parameters {const p=index*4,params:Record<string,number>={X:plan.points[p],Y:plan.points[p+1],Z:plan.points[p+2]};if(plan.extrusion)params.E=plan.points[p+3];if(plan.feed!==undefined)params.F=plan.feed;return params;}
/** Modal plane and coordinate owner stay within the serialized dispatcher.
 * Rolling flushes retain lookahead and hold an interrupted arc until resume. */
export class GCodeArcs {
 #plane:ArcPlane=0;readonly #resolution:number;
 constructor(resolution=1){this.#resolution=validateArcResolution(resolution);}
 get plane(){return this.#plane;}
 register(dispatch:GCodeDispatch,coordinates:GCodeMove,flush:(signal:AbortSignal)=>Promise<void>):void {
  for(const [command,plane] of [['G17',0],['G18',1],['G19',2]] as const)dispatch.register(command,()=>{this.#plane=plane;});
  for(const command of ['G2','G3'])dispatch.register(command,async c=>{
   const state=coordinates.state;if(!state.absoluteCoordinates)throw new GCodeError('G2/G3 does not support relative move mode');
   const plan=planArc(coordinates.gcodePosition,state.absoluteExtrude,c.params,command==='G2',this.#plane,this.#resolution);
   for(let n=0;n<plan.segments;n++){c.signal.throwIfAborted();coordinates.execute('G1',arcSegment(plan,n));if((n+1)%128===0)await flush(c.signal);}
   await flush(c.signal);
  },{checkpoint:true});
 }
}
