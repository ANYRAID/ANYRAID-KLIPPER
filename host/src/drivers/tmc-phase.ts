// TMC phase arithmetic from klippy/extras/tmc.py. GPL-3.0-or-later.
export interface TmcPhaseSample {readonly offset:number;readonly phases:number;readonly phase:number;}
/** MCU position is logical (direction inversion already applied), not the raw
 * signed firmware count. Use only a paired sample taken at a confirmed stop.
 * Phase period divides 2^32, so signed counter wrap leaves offset unchanged. */
export function tmcPhaseOffset(counter:number,microsteps:number,inverted:boolean,mcuPosition:bigint):Readonly<TmcPhaseSample>{
 if(!Number.isInteger(counter)||counter<0||counter>1023||!Number.isInteger(microsteps)||microsteps<1||microsteps>256||(microsteps&(microsteps-1))!==0||typeof inverted!=='boolean'||typeof mcuPosition!=='bigint')throw new RangeError('Invalid TMC phase sample');
 const phases=microsteps*4,driverPhase=inverted?counter:1023-counter;
 // All inputs and the half-up rounding numerator are exact small integers.
 const phase=Math.floor((driverPhase*phases+512)/1024)%phases,period=BigInt(phases);
 const offset=Number(((BigInt(phase)-mcuPosition)%period+period)%period);
 return Object.freeze({offset,phases,phase});
}
/** One hardware generation. No background I/O and no motion authorization.
 * Synchronization must be supplied by the stopped-motion owner, never by an
 * HTTP status query. A failed/retired sample must not expose a stale offset. */
export class TmcPhaseState {
 #microsteps:number;#inverted:boolean;#sample:Readonly<TmcPhaseSample>|null=null;#changes=0;#retired=false;
 constructor(microsteps:number,inverted:boolean){tmcPhaseOffset(0,microsteps,inverted,0n);this.#microsteps=microsteps;this.#inverted=inverted;}
 get sample(){return this.#retired?null:this.#sample;}
 get changes(){return this.#changes;}
 synchronize(counter:number,mcuPosition:bigint){
  if(this.#retired)throw new Error('TMC phase owner retired');
  let next:Readonly<TmcPhaseSample>;
  try{next=tmcPhaseOffset(counter,this.#microsteps,this.#inverted,mcuPosition);}catch(error){this.#sample=null;throw error;}
  if(this.#sample&&this.#sample.offset!==next.offset)this.#changes++;
  this.#sample=next;return next;
 }
 invalidate(){this.#sample=null;}
 retire(){this.#sample=null;this.#retired=true;}
}
