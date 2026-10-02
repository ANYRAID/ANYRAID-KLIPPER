import {representableProfile,representableSplitProfile} from './representable-profile.ts';
import {StepCompressor} from './step-compressor.ts';
import type {StepCompressorSettings,StepperKinematics} from './step-compressor.ts';
import {createRequire} from 'node:module';
import type {Move} from './lookahead.ts';
interface NativeTrapQueue {
  create():object;
  append(handle:object,rows:Float64Array):void;
  replaceFuture(handle:object,time:number,rows:Float64Array):void;
  extract(handle:object,capacity:number,start:number,end:number):Float64Array;
  finalize(handle:object,time:number,history:number):void;
  setPosition(handle:object,time:number,x:number,y:number,z:number):void;
  close(handle:object):void;
}
const native=createRequire(import.meta.url)(process.env.ANYRAID_TRAPQ_ADDON??'../../build/trapq.node') as NativeTrapQueue;
/** Owns a C trapq. Explicit disposal is preferred; native GC finalization is a fallback. */
export class TrapQueue {
  #handle=native.create();
  #closed=false;
  #steppers=new WeakSet<StepCompressor>();
  /** Queue identity check for coordinated generation. */
  ownsStepper(stepper:StepCompressor):boolean{return this.#steppers.has(stepper);}
  createStepper(settings:StepCompressorSettings,mode:StepperKinematics,stepDistance:number,position:readonly [number,number,number]=[0,0,0]):StepCompressor {
    const stepper=new StepCompressor(settings);
    try {stepper.bindQueue(this.#handle,mode,stepDistance,position);this.#steppers.add(stepper);return stepper;}catch(error){stepper.dispose();throw error;}
  }
  /** Packed rows: time, accelT, cruiseT, decelT, xyz, xyzRatio, startV, cruiseV, accel. */
  appendRaw(rows:Float64Array):void {native.append(this.#handle,rows);}
  /** Privileged source rewrite after every attached solver's generated future
   * dependency. Validates the complete batch before mutation, retains history.
   * Caller owns coordinate continuity and synchronized changes to other queues. */
  replaceFutureRaw(time:number,rows:Float64Array):void {native.replaceFuture(this.#handle,time,rows);}
  appendPlanned(moves:readonly Move[],startTime:number,extrusionAxis?:number,coverIdle=false):number {
    return this.#writePlanned(moves,startTime,extrusionAxis,coverIdle,false);
  }
  /** Same privileged dependency and ownership rules as replaceFutureRaw. */
  replaceFuturePlanned(moves:readonly Move[],startTime:number,extrusionAxis?:number,coverIdle=false):number {
    return this.#writePlanned(moves,startTime,extrusionAxis,coverIdle,true);
  }
  #writePlanned(moves:readonly Move[],startTime:number,extrusionAxis:number|undefined,coverIdle:boolean,replace:boolean):number {
    if(typeof coverIdle!=='boolean')throw new TypeError('Invalid idle coverage option');
    if(!Number.isFinite(startTime)||startTime<0) throw new RangeError('Invalid print time');
    if(moves.length>65536) throw new RangeError('Motion batch too large');
    let rows=new Float64Array(moves.length*13),count=0,extraRows=0,time=startTime;
    let rowSources:Move[]|undefined;
    for(const [moveIndex,move] of moves.entries()) {
      const profile=move.profile;
      if(!profile) throw new Error('Move must be planned before queueing');
      const normalized=representableProfile(move,time),p=normalized??profile,accel=normalized?.accel??move.accel;
      const split=!normalized&&p.accelT>0&&time+p.accelT===time?representableSplitProfile(move,time):undefined;
      if(extrusionAxis!==undefined&&(!Number.isInteger(extrusionAxis)||extrusionAxis<3||extrusionAxis>=move.axesR.length)) throw new RangeError('Invalid extrusion axis');
      const active=extrusionAxis!==undefined?move.axesD[extrusionAxis]!==0:move.isKinematic;
      if(split&&(active||coverIdle)){
        // Grow only on the exceptional path; ordinary batches retain their
        // existing allocation. The native 65,536-row limit remains enforced.
        const required=moves.length+(++extraRows);if(required>65536)throw new RangeError('Motion batch too large');
        if(rows.length<required*13){const expanded=new Float64Array(Math.min(65536,Math.max(required,rows.length/13*2))*13);expanded.set(rows);rows=expanded;}
        rowSources??=moves.slice(0,moveIndex).filter(m=>coverIdle||(extrusionAxis===undefined?m.isKinematic:m.axesD[extrusionAxis]!==0));
      }
      const first=split?.head??p;
      if(active) {
        const ratio=extrusionAxis===undefined?1:move.axesR[extrusionAxis];
        const xyz=extrusionAxis===undefined?move.startPos.slice(0,3):[move.startPos[extrusionAxis],0,0];
        const axes=extrusionAxis===undefined?move.axesR.slice(0,3):[1,ratio>0&&(move.axesD[0]!==0||move.axesD[1]!==0)?1:0,0];
        rows.set([time,first.accelT,first.cruiseT,first.decelT,...xyz,...axes,first.startV*ratio,first.cruiseV*ratio,(split?.head.accel??accel)*ratio],count*13);count++;rowSources?.push(move);
      } else if(coverIdle) {
        // Preserve identical phase-time arithmetic while extending inactive
        // axes to the common source horizon without generating movement.
        const xyz=extrusionAxis===undefined?move.startPos.slice(0,3):[move.startPos[extrusionAxis],0,0];
        rows.set([time,first.accelT,first.cruiseT,first.decelT,...xyz,0,0,0,0,0,0],count*13);count++;rowSources?.push(move);
      }
      if(split&&(active||coverIdle)){
        const tail=split.tail,ratio=extrusionAxis===undefined?1:move.axesR[extrusionAxis];
        const xyz=extrusionAxis===undefined?split.tailPos.slice(0,3):[split.tailPos[extrusionAxis],0,0];
        const axes=active?(extrusionAxis===undefined?move.axesR.slice(0,3):[1,ratio>0&&(move.axesD[0]!==0||move.axesD[1]!==0)?1:0,0]):[0,0,0];
        rows.set([split.tailTime,tail.accelT,tail.cruiseT,tail.decelT,...xyz,...axes,active?tail.startV*ratio:0,active?tail.cruiseV*ratio:0,active?tail.accel*ratio:0],count*13);count++;rowSources!.push(move);
      }
      time=split?((split.tailTime+split.tail.accelT)+split.tail.cruiseT)+split.tail.decelT:((time+p.accelT)+p.cruiseT)+p.decelT;
      if(!Number.isFinite(time)||time>=1e15) throw new RangeError('Print time overflow');
    }
    const data=rows.subarray(0,count*13);
    try{if(replace)native.replaceFuture(this.#handle,startTime,data);else native.append(this.#handle,data);}
    catch(error){
      if(error instanceof RangeError&&error.message==='Motion duration below time resolution'){
        for(let offset=0;offset<data.length;offset+=13){let phaseTime=data[offset];for(let phase=1;phase<=3;phase++){const duration=data[offset+phase];if(duration>0&&phaseTime+duration<=phaseTime)throw new RangeError(`${error.message}: ${JSON.stringify({row:Array.from(data.subarray(offset,offset+13)),phase,extrusionAxis:extrusionAxis??null,replace,move:(()=>{const m=(rowSources??moves.filter(m=>coverIdle||(extrusionAxis===undefined?m.isKinematic:m.axesD[extrusionAxis]!==0)))[offset/13];return {start:m.startPos,end:m.endPos,ratio:m.axesR,distance:m.distance,accel:m.accel,profile:m.profile};})()})}`,{cause:error});phaseTime+=duration;}}
      }
      throw error;
    }
    return time;
  }
  /** Rows of 10 doubles in reverse chronology, matching pull_move in trapq.h. */
  extract(capacity:number,start:number,end:number):Float64Array {return native.extract(this.#handle,capacity,start,end);}
  finalize(time:number,clearHistoryTime:number):void {native.finalize(this.#handle,time,clearHistoryTime);}
  /** Reset the host queue only. Caller must first coordinate MCU stop/drain. */
  setPosition(time:number,x:number,y:number,z:number):void {native.setPosition(this.#handle,time,x,y,z);}
  dispose():void {if(!this.#closed) {native.close(this.#handle);this.#closed=true;}}
  [Symbol.dispose]():void {this.dispose();}
}
