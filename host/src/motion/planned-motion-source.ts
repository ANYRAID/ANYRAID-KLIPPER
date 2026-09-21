import type {Move} from './lookahead.ts';
import type {TrapQueue} from './trap-queue.ts';
import {CoordinatedMotionDrain} from './coordinated-drain.ts';
export interface PlannedQueue {queue:TrapQueue;extrusionAxis?:number}
/** Exclusive source writer for coordinated XYZ and extra-axis trap queues.
 * Inputs must already have passed kinematic/extrusion admission and lookahead.
 * The owner must schedule print time ahead of every participating MCU; this
 * class does not infer a safe print time from host wall time. */
export class PlannedMotionSource {
 readonly #routes:readonly PlannedQueue[];readonly #drain:CoordinatedMotionDrain;
 #position:number[];#time:number;#busy=false;#paused=false;#failed=false;#fault:unknown;
 constructor(routes:readonly PlannedQueue[],drain:CoordinatedMotionDrain,startTime:number,position:readonly number[]){
  if(!Number.isFinite(startTime)||startTime<0||startTime>=1e15||!Array.isArray(position)||position.length<4||!position.every(Number.isFinite)||!drain.usesQueues(routes.map(r=>r.queue)))throw new RangeError('Invalid planned source ownership or baseline');
  const axes=new Set<number>();let xyz=0;
  for(const r of routes){if(r.extrusionAxis===undefined)xyz++;else if(!Number.isInteger(r.extrusionAxis)||r.extrusionAxis<3||r.extrusionAxis>=position.length||axes.has(r.extrusionAxis))throw new RangeError('Invalid planned source extrusion route');else axes.add(r.extrusionAxis);}
  if(xyz!==1||axes.size!==position.length-3)throw new RangeError('Planned source requires XYZ and every extra axis');
  this.#routes=routes.map(r=>({...r}));this.#drain=drain;this.#time=startTime;this.#position=[...position];
 }
 get status(){return {sourceTime:this.#time,position:[...this.#position],busy:this.#busy,paused:this.#paused,failed:this.#failed,fault:this.#fault};}
 #check():void{if(this.#failed)throw new Error('Planned motion source failed',{cause:this.#fault});if(this.#busy)throw new Error('Planned motion source busy');}
 async #stop(error:unknown):Promise<void>{this.#failed=true;this.#fault??=error;try{await this.#drain.stop(error);}catch(stop){this.#fault=new AggregateError([error,stop],'Planned source and stop failed');} }
 #append(moves:readonly Move[]):void{
  if(!Array.isArray(moves)||moves.length>65536)throw new RangeError('Invalid planned source batch');
  if(this.#paused&&moves.length)throw new Error('Resume planned motion with a fresh print time first');
  let position=this.#position,time=this.#time;
  // Validate the entire batch before any queue mutation. Input objects are used
  // synchronously, so callers cannot mutate them between queue appends.
  for(const m of moves as readonly Move[]){const p=m.profile;if(!p||m.startPos.length!==position.length||m.endPos.length!==position.length||m.startPos.some((v,i)=>v!==position[i])||!m.endPos.every(Number.isFinite)||![p.accelT,p.cruiseT,p.decelT,p.startV,p.cruiseV,p.endV,m.accel].every(v=>Number.isFinite(v)&&v>=0)||p.cruiseV===0||m.accel===0)throw new RangeError('Invalid or discontinuous planned motion');time=((time+p.accelT)+p.cruiseT)+p.decelT;if(!Number.isFinite(time)||time>=1e15)throw new RangeError('Planned source time overflow');position=m.endPos;}
  for(const r of this.#routes){const end=r.queue.appendPlanned(moves,this.#time,r.extrusionAxis);if(end!==time)throw new Error('Planned queue timelines differ');}
  this.#position=[...position];this.#time=time;
 }
 /** Append earlier lookahead flushes without losing the final drain endpoint. */
 append(moves:readonly Move[]):void{this.#check();try{this.#append(moves);}catch(error){void this.#stop(error);throw error;}}
 /** Call after a successful drain, before producing subsequent motion. The
  * supplied time must include the scheduler's current MCU lead requirement. */
 resumeAt(printTime:number):void{this.#check();if(!this.#paused||!Number.isFinite(printTime)||printTime<this.#time||printTime>=1e15)throw new RangeError('Invalid planned source resume time');this.#time=printTime;this.#paused=false;}
 async drain(moves:readonly Move[],signal:AbortSignal,timeoutMs=30000):Promise<void>{
  this.#check();signal.throwIfAborted();this.#busy=true;
  try{
   this.#append(moves);
   const positions=new Map<TrapQueue,readonly [number,number,number]>(this.#routes.map(r=>[r.queue,r.extrusionAxis===undefined?[this.#position[0],this.#position[1],this.#position[2]]:[this.#position[r.extrusionAxis],0,0]]));
   const result=await this.#drain.drain(this.#time,positions,signal,timeoutMs);signal.throwIfAborted();this.#time=result.sourceUntil;this.#paused=true;
  }catch(error){await this.#stop(error);throw this.#fault;}
  finally{this.#busy=false;}
 }
}
