import {validateShaper} from './shaper.ts';
import type {Shaper} from './shaper.ts';
import {createRequire} from 'node:module';
export interface StepPacket {data:Buffer;minClock:bigint;reqClock:bigint}
export interface CompressedSteps {
  messages:StepPacket[];
  /** Reverse chronology: firstClock,lastClock,startPosition,signedCount,interval,add. */
  history:BigInt64Array;
  position:bigint;
}
export type StepperKinematics = 'x'|'y'|'z'|'corexy+'|'corexy-';
interface Native {configureShapers(handle:object,parameters:Float64Array):void;windows(handle:object):Float64Array;attachSolver(handle:object,queue:object,settings:Float64Array):void;generate(handle:object,until:number):number;create(settings:Float64Array,initialClock:bigint):object;append(handle:object,steps:Float64Array):void;flush(handle:object):CompressedSteps;close(handle:object):void}
const native=createRequire(import.meta.url)(process.env.ANYRAID_STEPCOMPRESS_ADDON??'../../build/stepcompress.node') as Native;
export interface StepCompressorSettings {frequency:number;timeOffset:number;oid:number;maxError:number;queueStepTag:number;directionTag:number;invertDirection?:boolean;initialClock?:bigint}
/** Native compression only: caller must provide validated steps and schedule returned packets. */
export class StepCompressor {
  #handle:object;#closed=false;
  constructor(s:StepCompressorSettings){this.#handle=native.create(new Float64Array([s.frequency,s.timeOffset,s.oid,s.maxError,s.queueStepTag,s.directionTag,s.invertDirection?1:0]),s.initialClock??0n);}
  /** @internal Queue capability supplied by TrapQueue.createStepper. */
  bindQueue(queue:object,mode:StepperKinematics,stepDistance:number,position:readonly number[]):void {
    native.attachSolver(this.#handle,queue,new Float64Array([['x','y','z','corexy+','corexy-'].indexOf(mode),stepDistance,...position]));
  }
  /** Atomically replace XYZ shapers before any generation; omitted axes are disabled. */
  configureShapers(shapers:Partial<Record<'x'|'y'|'z',Shaper>>):void {
    if(Object.keys(shapers).some(k=>!['x','y','z'].includes(k)))throw new RangeError('Unknown shaper axis');
    const packed=new Float64Array(63);
    for(const [axis,name] of (['x','y','z'] as const).entries()) {
      const shaper=shapers[name]??{amplitudes:[],times:[]};validateShaper(shaper);
      packed[axis*21]=shaper.times.length;packed.set(shaper.amplitudes,axis*21+1);packed.set(shaper.times,axis*21+11);
    }
    native.configureShapers(this.#handle,packed);
  }
  get scanWindow():{future:number;past:number;safeFinalizeTime:number|null} {
    const [future,past,safeFinalizeTime]=native.windows(this.#handle);return {future,past,safeFinalizeTime:safeFinalizeTime<0?null:safeFinalizeTime};
  }
  /** Generate through a queued print-time boundary; returns commanded actuator position. */
  generate(until:number):number{return native.generate(this.#handle,until);}
  /** Packed triples: direction (0/1), printTime, relativeStepTime. Entire batch validates first. */
  append(steps:Float64Array):void{native.append(this.#handle,steps);}
  /** Commits all pending steps. Returns and releases native packet/history storage.
   * Persist history needed for homing before dropping this result. */
  flush():CompressedSteps{return native.flush(this.#handle);}
  dispose():void{if(!this.#closed){native.close(this.#handle);this.#closed=true;}}
  [Symbol.dispose]():void{this.dispose();}
}
