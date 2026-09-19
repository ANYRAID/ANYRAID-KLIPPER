import {createRequire} from 'node:module';
export interface StepPacket {data:Buffer;minClock:bigint;reqClock:bigint}
export interface CompressedSteps {
  messages:StepPacket[];
  /** Reverse chronology: firstClock,lastClock,startPosition,signedCount,interval,add. */
  history:BigInt64Array;
  position:bigint;
}
interface Native {create(settings:Float64Array,initialClock:bigint):object;append(handle:object,steps:Float64Array):void;flush(handle:object):CompressedSteps;close(handle:object):void}
const native=createRequire(import.meta.url)(process.env.ANYRAID_STEPCOMPRESS_ADDON??'../../build/stepcompress.node') as Native;
export interface StepCompressorSettings {frequency:number;timeOffset:number;oid:number;maxError:number;queueStepTag:number;directionTag:number;invertDirection?:boolean;initialClock?:bigint}
/** Native compression only: caller must provide validated steps and schedule returned packets. */
export class StepCompressor {
  #handle:object;#closed=false;
  constructor(s:StepCompressorSettings){this.#handle=native.create(new Float64Array([s.frequency,s.timeOffset,s.oid,s.maxError,s.queueStepTag,s.directionTag,s.invertDirection?1:0]),s.initialClock??0n);}
  /** Packed triples: direction (0/1), printTime, relativeStepTime. Entire batch validates first. */
  append(steps:Float64Array):void{native.append(this.#handle,steps);}
  /** Commits all pending steps. Returns and releases native packet/history storage.
   * Persist history needed for homing before dropping this result. */
  flush():CompressedSteps{return native.flush(this.#handle);}
  dispose():void{if(!this.#closed){native.close(this.#handle);this.#closed=true;}}
  [Symbol.dispose]():void{this.dispose();}
}
