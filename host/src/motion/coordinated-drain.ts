import {readPrintClock,type PrintClockTimeline} from '../timing/print-clock-timeline.ts';
import {snapshotPrintClock} from '../timing/print-clock.ts';
import {performance} from 'node:perf_hooks';
import {MotionCoordinator} from './coordinator.ts';
import {MoveQueueSink} from './move-queue-sink.ts';
import {MCUGroup} from '../runtime/mcu-group.ts';
import type {TrapQueue} from './trap-queue.ts';
import type {Move} from './lookahead.ts';
/** Explicit devices without motion queues; clock passage is still required. */
export interface AuxiliaryMCUClock {id:string;timeline?:PrintClockTimeline;calibration:Readonly<{offset:number;frequency:number}>}
/** Producer must remain fenced through completion and use sourceUntil for the
 * next source segment. Routes must be built from this group's motion queues.
 * Drain completion confirms firmware-time passage, never mechanical position.
 * Streaming advance only commits the safe prefix; it does not await execution. */
export class CoordinatedMotionDrain {
 readonly #coordinator:MotionCoordinator;readonly #sink:MoveQueueSink;readonly #group:MCUGroup;#clockSources:ReturnType<MoveQueueSink['clockSources']>;#maxWindow:number;#busy=false;
 #auxiliary:readonly {id:string;timeline?:PrintClockTimeline;clock:ReturnType<typeof snapshotPrintClock>}[];
 constructor(coordinator:MotionCoordinator,sink:MoveQueueSink,group:MCUGroup,maxGenerationWindow=.25,auxiliary:readonly AuxiliaryMCUClock[]=[]){
  if(!Number.isFinite(maxGenerationWindow)||maxGenerationWindow<.01||maxGenerationWindow>1)throw new RangeError('Invalid generation window');this.#maxWindow=maxGenerationWindow;if(!coordinator.usesSink(sink))throw new Error('Motion drain sink does not belong to coordinator');this.#clockSources=sink.clockSources();this.#coordinator=coordinator;this.#sink=sink;this.#group=group;
  this.#auxiliary=auxiliary.map(a=>({id:a.id,timeline:a.timeline,clock:readPrintClock(a.calibration,a.timeline)}));
  const ids=[...this.#clockSources.map(c=>c.id),...this.#auxiliary.map(c=>c.id)],devices=group.status.devices;
  if(new Set(ids).size!==ids.length||ids.length!==devices.length||ids.some(id=>!devices.some(d=>d.id===id)))throw new Error('Motion and auxiliary clocks must cover every MCU exactly once');
  for(const a of this.#auxiliary)group.session(a.id).configuration;
 }
 #historyCutoff():number{this.#group.assertActive();const clocks:Record<string,bigint>=Object.create(null);for(const route of this.#clockSources){const clock=this.#group.session(route.id).clock;clock.assertActive();const tick=clock.sync.lastClock;for(const id of route.emitters)clocks[id]=tick;}return this.#coordinator.historyCutoff(clocks);}
 get generatedTime():number{return this.#coordinator.status.generatedTime;}
 get committedTime():number{return this.#coordinator.status.committedTime;}
 get finalizedSourceTime():number{return this.#coordinator.finalizedSourceTime;}
 usesQueues(queues:readonly TrapQueue[]):boolean{return this.#coordinator.usesQueues(queues);}
 async stop(cause:unknown):Promise<void>{const results=await Promise.allSettled([this.#coordinator.shutdown(cause),this.#group.stop(cause)]);const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'Motion source stop failed');}
 async replaceFuture(time:number,moves:readonly Move[],routes:readonly {queue:TrapQueue;extrusionAxis?:number}[],position:readonly number[],signal:AbortSignal,timeoutMs=30000,beforeReplace?:(signal:AbortSignal)=>Promise<void>):Promise<number>{
  return this.#operate(signal,timeoutMs,async({run,check,combined})=>{if(beforeReplace){await run(beforeReplace(combined));check();}const end=await run(this.#coordinator.replaceFuture(time,moves,routes,position));check();return end;});
 }
 async advanceIdleSource(sourceUntil:number,signal:AbortSignal,timeoutMs=30000):Promise<boolean>{
  return this.#operate(signal,timeoutMs,async({run,check})=>{const advanced=await run(this.#coordinator.advanceIdleSource(sourceUntil,Math.min(this.#historyCutoff(),this.#coordinator.status.generatedTime)));check();return advanced;});
 }
 async advanceSource(sourceUntil:number,signal:AbortSignal,timeoutMs=30000,clearHistoryTime=0,afterCommit?:(horizon:number,signal:AbortSignal)=>Promise<void>):Promise<boolean>{
  return this.#operate(signal,timeoutMs,async({run,check,combined})=>{const advanced=await run(this.#coordinator.advanceSource(sourceUntil,clearHistoryTime,this.#maxWindow,()=>Math.min(this.#historyCutoff(),clearHistoryTime>0?clearHistoryTime:Infinity)));check();if(afterCommit){await run(afterCommit(this.committedTime,combined));check();}return advanced;});
 }
 async drain(lastMoveTime:number,positions:ReadonlyMap<TrapQueue,readonly [number,number,number]>,signal:AbortSignal,timeoutMs=30000,afterCommit?:(horizon:number,signal:AbortSignal)=>Promise<void>){
  return this.#operate(signal,timeoutMs,async({run,check,combined,deadline})=>{
   const result=await run(this.#coordinator.drain(lastMoveTime,positions,this.#maxWindow,()=>this.#historyCutoff()));check();
   if(afterCommit){await run(afterCommit(result.generatedUntil,combined));check();}
   const targets=Object.freeze({...this.#sink.motionClockTargets(result.clocks),...Object.fromEntries(this.#auxiliary.map(a=>[a.id,a.timeline?a.timeline.reserve(result.generatedUntil):a.clock.clockAt(result.generatedUntil)]))});
   await run(this.#group.waitForMotionClocks(targets,combined,Math.max(1,Math.ceil(deadline-performance.now()))));check();
   return Object.freeze({...result,targets});
  });
 }
 async #operate<T>(signal:AbortSignal,timeoutMs:number,work:(context:{run:<R>(work:Promise<R>)=>Promise<R>;check:()=>void;combined:AbortSignal;deadline:number})=>Promise<T>):Promise<T>{
  if(this.#busy)throw new Error('Motion drain already active');signal.throwIfAborted();this.#group.assertActive();
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000)throw new RangeError('Invalid motion drain timeout');
  this.#busy=true;const deadline=performance.now()+timeoutMs,local=new AbortController(),combined=AbortSignal.any([signal,local.signal]);let stopped:Promise<void>|undefined;
  const stop=(cause:unknown)=>stopped??=Promise.allSettled([this.#coordinator.shutdown(cause),this.#group.stop(cause)]).then(results=>{const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'Motion drain stop failed');});
  const abort=()=>{void stop(combined.reason).catch(()=>{});};combined.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>local.abort(new Error('Motion drain timed out')),timeoutMs);
  const check=()=>{if(performance.now()>=deadline&&!combined.aborted)local.abort(new Error('Motion drain timed out'));combined.throwIfAborted();};
  const run=async<T>(work:Promise<T>):Promise<T>=>{let abort=()=>{};const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(combined.reason);combined.addEventListener('abort',abort,{once:true});if(combined.aborted)abort();});try{return await Promise.race([work,cancelled]);}finally{combined.removeEventListener('abort',abort);}};
  try{return await work({run,check,combined,deadline});
  }catch(error){try{await stop(error);}catch(stopError){throw new AggregateError([error,stopError],'Motion drain and stop failed');}throw error;}
  finally{clearTimeout(timer);combined.removeEventListener('abort',abort);this.#busy=false;}
 }
}
