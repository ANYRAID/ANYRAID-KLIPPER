import {createRequire} from 'node:module';
import type {Move} from './lookahead.ts';
interface NativeTrapQueue {
  create():object;
  append(handle:object,rows:Float64Array):void;
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
  /** Packed rows: time, accelT, cruiseT, decelT, xyz, xyzRatio, startV, cruiseV, accel. */
  appendRaw(rows:Float64Array):void {native.append(this.#handle,rows);}
  appendPlanned(moves:readonly Move[],startTime:number,extrusionAxis?:number):number {
    if(!Number.isFinite(startTime)||startTime<0) throw new RangeError('Invalid print time');
    if(moves.length>65536) throw new RangeError('Motion batch too large');
    const rows=new Float64Array(moves.length*13);let count=0,time=startTime;
    for(const move of moves) {
      const p=move.profile;
      if(!p) throw new Error('Move must be planned before queueing');
      if(extrusionAxis!==undefined&&(!Number.isInteger(extrusionAxis)||extrusionAxis<3||extrusionAxis>=move.axesR.length)) throw new RangeError('Invalid extrusion axis');
      if(extrusionAxis!==undefined ? move.axesD[extrusionAxis]!==0 : move.isKinematic) {
        const ratio=extrusionAxis===undefined?1:move.axesR[extrusionAxis];
        const xyz=extrusionAxis===undefined?move.startPos.slice(0,3):[move.startPos[extrusionAxis],0,0];
        const axes=extrusionAxis===undefined?move.axesR.slice(0,3):[1,ratio>0&&(move.axesD[0]!==0||move.axesD[1]!==0)?1:0,0];
        rows.set([time,p.accelT,p.cruiseT,p.decelT,...xyz,...axes,p.startV*ratio,p.cruiseV*ratio,move.accel*ratio],count*13);count++;
      }
      time=((time+p.accelT)+p.cruiseT)+p.decelT;
      if(!Number.isFinite(time)||time>=1e15) throw new RangeError('Print time overflow');
    }
    native.append(this.#handle,rows.subarray(0,count*13));return time;
  }
  /** Rows of 10 doubles in reverse chronology, matching pull_move in trapq.h. */
  extract(capacity:number,start:number,end:number):Float64Array {return native.extract(this.#handle,capacity,start,end);}
  finalize(time:number,clearHistoryTime:number):void {native.finalize(this.#handle,time,clearHistoryTime);}
  /** Reset the host queue only. Caller must first coordinate MCU stop/drain. */
  setPosition(time:number,x:number,y:number,z:number):void {native.setPosition(this.#handle,time,x,y,z);}
  dispose():void {if(!this.#closed) {native.close(this.#handle);this.#closed=true;}}
  [Symbol.dispose]():void {this.dispose();}
}
