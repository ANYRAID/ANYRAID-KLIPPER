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
export type StepperKinematics = 'x'|'y'|'z'|'corexy+'|'corexy-'|'corexz+'|'corexz-'|'extruder'|{kind:'delta';armLength:number;towerX:number;towerY:number};
const solverModes={x:0,y:1,z:2,'corexy+':3,'corexy-':4,extruder:5,'corexz+':7,'corexz-':8} as const;
interface Native {configureCarriage(handle:object,parameters:Float64Array):void;pressureSchedulePrefix(handle:object,changes:Float64Array):number;reconfigurePressureAdvance(handle:object,advance:number,smoothTime:number,apply:boolean):void;setPressureAdvanceAtTail(handle:object,time:number,advance:number):Float64Array;cancelPressureAdvanceAfter(handle:object,time:number):Float64Array;coordinatePosition(handle:object,x:number,y:number,z:number):number;commandedPosition(handle:object):number;initializePosition(handle:object,clock:bigint,position:bigint):void;calibrateClock(handle:object,offset:number,frequency:number,apply:boolean):void;schedulePressureAdvance(handle:object,printTime:number,advance:number):void;configurePressureAdvance(handle:object,advance:number,smoothTime:number):void;configureShapers(handle:object,parameters:Float64Array):void;windows(handle:object):Float64Array;attachSolver(handle:object,queue:object,settings:Float64Array):void;generate(handle:object,until:number):number;create(settings:Float64Array,initialClock:bigint):object;append(handle:object,steps:Float64Array):void;flush(handle:object,time?:number):CompressedSteps;close(handle:object):void}
const native=createRequire(import.meta.url)(process.env.ANYRAID_STEPCOMPRESS_ADDON??'../../build/stepcompress.node') as Native;
export interface StepCompressorSettings {frequency:number;timeOffset:number;oid:number;maxError:number;queueStepTag:number;directionTag:number;invertDirection?:boolean;initialClock?:bigint}
export interface CarriageTransformSettings {xScale:number;xOffset:number;yScale:number;yOffset:number;}
export interface MotionFilterSettings {carriage?:CarriageTransformSettings;shapers?:Partial<Record<'x'|'y'|'z',Shaper>>;pressureAdvance?:{advance:number;smoothTime:number};}
/** Native compression only: caller must provide validated steps and schedule returned packets. */
export class StepCompressor {
  #handle:object;#closed=false;#offset:number;#frequency:number;
  #filters:MotionFilterSettings={};#pressureSettledAt:number|undefined;
  constructor(s:StepCompressorSettings){this.#offset=s.timeOffset;this.#frequency=s.frequency;this.#handle=native.create(new Float64Array([s.frequency,s.timeOffset,s.oid,s.maxError,s.queueStepTag,s.directionTag,s.invertDirection?1:0]),s.initialClock??0n);}
  /** Startup only: seed observed MCU position without resetting step clocks. */
  initializePosition(clock:bigint,position:bigint):void{native.initializePosition(this.#handle,clock,position);}
  /** Validate without mutating; used to update an MCU's whole stepper group. */
  validateClockCalibration(offset:number,frequency:number):void{native.calibrateClock(this.#handle,offset,frequency,false);}
  calibrateClock(offset:number,frequency:number):void{native.calibrateClock(this.#handle,offset,frequency,true);this.#offset=offset;this.#frequency=frequency;}
  /** Snapshot of the active host-to-MCU mapping; callers must reject drift
   * when preserving a homing generation across readback and reconstruction. */
  get calibration():Readonly<{offset:number;frequency:number}>{if(this.#closed)throw new Error('Step compressor is closed');return Object.freeze({offset:this.#offset,frequency:this.#frequency});}
  /** Same rounding as original C clock_from_time; usable by MoveQueueSink. */
  clockAt(printTime:number):bigint{const raw=(printTime-this.#offset)*this.#frequency,rounded=Math.floor(raw+.5);if(this.#closed||!Number.isFinite(printTime)||!Number.isSafeInteger(rounded)||raw<0)throw new RangeError('Invalid print-time clock');return BigInt(rounded);}
  /** Convert an observed MCU clock using this emitter's current calibration. */
  printTimeAtClock(clock:bigint):number{if(this.#closed||typeof clock!=='bigint'||clock<0n||clock>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Observed clock exceeds exact mapping range');const time=this.#offset+Number(clock)/this.#frequency;if(!Number.isFinite(time)||Math.abs(time)>=1e15)throw new RangeError('Invalid observed print time');return time;}
  /** @internal Queue capability supplied by TrapQueue.createStepper. */
  bindQueue(queue:object,mode:StepperKinematics,stepDistance:number,position:readonly number[]):void {
    const delta=typeof mode==='object';
    native.attachSolver(this.#handle,queue,new Float64Array([delta&&mode.kind==='delta'?6:solverModes[mode as keyof typeof solverModes],stepDistance,...position,...(delta?[mode.armLength,mode.towerX,mode.towerY]:[])]));
  }
  /** Immutable within a generation; configure before shaping or position seeding. */
  configureCarriage(transform:CarriageTransformSettings):void{
    const {xScale,xOffset,yScale,yOffset}=transform;
    native.configureCarriage(this.#handle,new Float64Array([xScale,xOffset,yScale,yOffset]));
    this.#filters.carriage={xScale,xOffset,yScale,yOffset};
  }
  /** Configure an E-only queue before generation. Zero advance disables smoothing. */
  configurePressureAdvance(advance:number,smoothTime=.04):void{native.configurePressureAdvance(this.#handle,advance,smoothTime);this.#filters.pressureAdvance={advance,smoothTime};this.#pressureSettledAt=undefined;}
  /** Preflight a generated stationary barrier without changing native state. */
  validatePressureAdvanceWindow(advance:number,smoothTime:number):void{native.reconfigurePressureAdvance(this.#handle,advance,smoothTime,false);}
  /** Runtime-only window switch at a proven stationary generation barrier.
   * Caller owns group serialization; this neither waits for MCU execution nor
   * resets the compressor, coordinates or motor counters. */
  reconfigurePressureAdvance(advance:number,smoothTime:number):void{native.reconfigurePressureAdvance(this.#handle,advance,smoothTime,true);this.#filters.pressureAdvance={advance,smoothTime};this.#pressureSettledAt=undefined;}
  /** Whether this emitter owns a nonzero pressure convolution window. This
   * describes filter capability, not the coefficient active at the MCU now. */
  get pressureAdvanceEnabled():boolean{if(this.#closed)throw new Error('Step compressor is closed');const p=this.#filters.pressureAdvance;return !!p&&p.advance>0&&p.smoothTime>0;}
  /** Largest sequential prefix fitting the retained native history, without
   * changing parameters or the last accepted time. Invalid suffixes still fail. */
  pressureSchedulePrefix(changes:readonly {time:number;advance:number}[]):number{
    if(!Array.isArray(changes)||changes.length>65536)throw new RangeError('Invalid pressure admission batch');
    const values=new Float64Array(changes.length*2);for(let i=0;i<changes.length;i++){values[i*2]=changes[i].time;values[i*2+1]=changes[i].advance;}return native.pressureSchedulePrefix(this.#handle,values);
  }
  /** Schedule a positive coefficient at a future source-phase boundary; smooth time stays fixed. */
  schedulePressureAdvance(printTime:number,advance:number):void{native.schedulePressureAdvance(this.#handle,printTime,advance);const prior=this.#filters.pressureAdvance!;if(advance!==prior.advance){this.#filters.pressureAdvance={advance,smoothTime:prior.smoothTime};this.#pressureSettledAt=printTime+prior.smoothTime*.5;}}
  /** Remove only updates strictly beyond an ungenerated source cutoff. The
   * caller must fence source admission and coordinate path replacement itself.
   * No queue, motor clock or generated pulse is reset by this operation. */
  cancelPressureAdvanceAfter(printTime:number):void{
    const [advance,activeTime]=native.cancelPressureAdvanceAfter(this.#handle,printTime),prior=this.#filters.pressureAdvance!;
    this.#filters.pressureAdvance={advance,smoothTime:prior.smoothTime};this.#pressureSettledAt=activeTime?activeTime+prior.smoothTime*.5:undefined;
  }
  /** Replace or append the newest ungenerated fixed-window endpoint. */
  setPressureAdvanceAtTail(printTime:number,advance:number):void{
    const [accepted,activeTime]=native.setPressureAdvanceAtTail(this.#handle,printTime,advance),prior=this.#filters.pressureAdvance!;
    this.#filters.pressureAdvance={advance:accepted,smoothTime:prior.smoothTime};this.#pressureSettledAt=activeTime?activeTime+prior.smoothTime*.5:undefined;
  }
  /** Snapshot only settled parameters. A new constant-position generation
   * cannot inherit a pending time-domain transition without its old path. */
  recoveryFilters():MotionFilterSettings{
    if(this.#closed)throw new Error('Step compressor is closed');
    if(this.#pressureSettledAt!==undefined&&this.generatedTime<this.#pressureSettledAt)throw new Error('Pressure advance transition must settle before recovery');
    return structuredClone(this.#filters);
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
    this.#filters.shapers=Object.fromEntries((['x','y','z'] as const).map((name,axis)=>{const n=packed[axis*21];return [name,{amplitudes:Array.from(packed.slice(axis*21+1,axis*21+1+n)),times:Array.from(packed.slice(axis*21+11,axis*21+11+n))}];}));
  }
  /** Read-only original native kinematic projection; does not change the
   * commanded coordinate, generation frontier, clock or physical counter. */
  coordinatePosition(x:number,y:number,z:number):number{return native.coordinatePosition(this.#handle,x,y,z);}
  /** Current native actuator coordinate; does not generate or flush steps. */
  get commandedPosition():number{return native.commandedPosition(this.#handle);}
  get generatedTime():number{return native.windows(this.#handle)[3];}
  get scanWindow():{future:number;past:number;safeFinalizeTime:number|null} {
    const [future,past,safeFinalizeTime]=native.windows(this.#handle);return {future,past,safeFinalizeTime:safeFinalizeTime<0?null:safeFinalizeTime};
  }
  /** Generate through a queued print-time boundary; returns commanded actuator position. */
  generate(until:number):number{return native.generate(this.#handle,until);}
  /** Packed triples: direction (0/1), printTime, relativeStepTime. Entire batch validates first. */
  append(steps:Float64Array):void{native.append(this.#handle,steps);}
  /** Commits all pending steps. Returns and releases native packet/history storage.
   * Persist history needed for homing before dropping this result. */
  /** Flush compression toward printTime, retaining the reversible future step.
   * Output may include commands beyond the boundary; MCU scheduling must gate them. */
  flushThrough(printTime:number):CompressedSteps{return native.flush(this.#handle,printTime);}
  flush():CompressedSteps{return native.flush(this.#handle);}
  dispose():void{if(!this.#closed){native.close(this.#handle);this.#closed=true;}}
  [Symbol.dispose]():void{this.dispose();}
}
