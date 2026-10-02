/** Probe sampling policy derived from klippy/extras/probe.py (GPL-3.0-or-later).
 * Motion ownership and failure stopping belong to the calling native owner. */
export interface ProbeSamples {samples:number;retractDistance:number;liftSpeed:number;tolerance:number;retries:number;result:'average'|'median';}
export async function collectProbeSamples(options:ProbeSamples,seek:()=>Promise<{trigger:readonly number[];halt:readonly number[]}>,retract:(position:readonly number[],speed:number)=>Promise<void>,signal:AbortSignal){
 const o={...options};
 if(!Number.isInteger(o.samples)||o.samples<1||o.samples>1000||!Number.isInteger(o.retries)||o.retries<0||o.retries>100||!Number.isFinite(o.tolerance)||o.tolerance<0||![o.retractDistance,o.liftSpeed].every(v=>Number.isFinite(v)&&v>0)||!['average','median'].includes(o.result))throw new RangeError('Invalid probe sampling policy');
 let positions:readonly number[][]=[];let retries=0,attempts=0,axes:number|undefined;
 while(positions.length<o.samples){
  signal.throwIfAborted();const hit=await seek();signal.throwIfAborted();attempts++;
  if(hit.trigger.length<4||axes!==undefined&&hit.trigger.length!==axes||hit.halt.length!==hit.trigger.length||![...hit.trigger,...hit.halt].every(Number.isFinite))throw new Error('Invalid probe coordinates');
  axes=hit.trigger.length;positions=[...positions,[...hit.trigger]];
  const zs=positions.map(p=>p[2]);if(Math.max(...zs)-Math.min(...zs)>o.tolerance){
   if(retries>=o.retries)throw new Error('Probe samples exceed tolerance');retries++;positions=[];
  }
  if(positions.length<o.samples){const target=[...hit.halt];target[2]+=o.retractDistance;if(!Number.isFinite(target[2])||target[2]<=hit.halt[2])throw new RangeError('Unrepresentable probe retract');await retract(target,o.liftSpeed);}
 }
 const sorted=[...positions].sort((a,b)=>a[2]-b[2]),mid=Math.floor(sorted.length/2),selected=o.result==='average'?positions:sorted.length%2?[sorted[mid]]:sorted.slice(mid-1,mid+1);
 const position=selected[0].map((_,axis)=>{const origin=selected[0][axis];let sum=0,correction=0;for(const p of selected){const y=(p[axis]-origin)/selected.length-correction,t=sum+y;correction=(t-sum)-y;sum=t;}const result=origin+sum;if(!Number.isFinite(result))throw new RangeError('Probe result overflow');return result;});
 signal.throwIfAborted();return Object.freeze({position:Object.freeze(position),samples:Object.freeze(positions.map(p=>Object.freeze([...p]))),retries,attempts});
}
