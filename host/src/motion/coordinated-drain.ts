import {performance} from 'node:perf_hooks';
import {MotionCoordinator} from './coordinator.ts';
import {MoveQueueSink} from './move-queue-sink.ts';
import {MCUGroup} from '../runtime/mcu-group.ts';
import type {TrapQueue} from './trap-queue.ts';
/** Producer must remain fenced through completion and use sourceUntil for the
 * next source segment. Routes must be built from this group's motion queues.
 * Drain completion confirms firmware-time passage, never mechanical position.
 * Streaming advance only commits the safe prefix; it does not await execution. */
export class CoordinatedMotionDrain {
 readonly #coordinator:MotionCoordinator;readonly #sink:MoveQueueSink;readonly #group:MCUGroup;#clockSources:ReturnType<MoveQueueSink['clockSources']>;#maxWindow:number;#busy=false;
 constructor(coordinator:MotionCoordinator,sink:MoveQueueSink,group:MCUGroup,maxGenerationWindow=.25){if(!Number.isFinite(maxGenerationWindow)||maxGenerationWindow<.01||maxGenerationWindow>1)throw new RangeError('Invalid generation window');this.#maxWindow=maxGenerationWindow;if(!coordinator.usesSink(sink))throw new Error('Motion drain sink does not belong to coordinator');this.#clockSources=sink.clockSources();this.#coordinator=coordinator;this.#sink=sink;this.#group=group;}
 #historyCutoff():number{this.#group.assertActive();const clocks:Record<string,bigint>=Object.create(null);for(const route of this.#clockSources){const clock=this.#group.session(route.id).clock;clock.assertActive();const tick=clock.sync.lastClock;for(const id of route.emitters)clocks[id]=tick;}return this.#coordinator.historyCutoff(clocks);}
 get generatedTime():number{return this.#coordinator.status.generatedTime;}
 get finalizedSourceTime():number{return this.#coordinator.finalizedSourceTime;}
 usesQueues(queues:readonly TrapQueue[]):boolean{return this.#coordinator.usesQueues(queues);}
 async stop(cause:unknown):Promise<void>{const results=await Promise.allSettled([this.#coordinator.shutdown(cause),this.#group.stop(cause)]);const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'Motion source stop failed');}
 async advanceIdleSource(sourceUntil:number,signal:AbortSignal,timeoutMs=30000):Promise<boolean>{
  return this.#operate(signal,timeoutMs,async({run,check})=>{const advanced=await run(this.#coordinator.advanceIdleSource(sourceUntil,Math.min(this.#historyCutoff(),this.#coordinator.status.generatedTime)));check();return advanced;});
 }
 async advanceSource(sourceUntil:number,signal:AbortSignal,timeoutMs=30000,clearHistoryTime=0):Promise<boolean>{
  return this.#operate(signal,timeoutMs,async({run,check})=>{const advanced=await run(this.#coordinator.advanceSource(sourceUntil,clearHistoryTime,this.#maxWindow,()=>Math.min(this.#historyCutoff(),clearHistoryTime>0?clearHistoryTime:Infinity)));check();return advanced;});
 }
 async drain(lastMoveTime:number,positions:ReadonlyMap<TrapQueue,readonly [number,number,number]>,signal:AbortSignal,timeoutMs=30000){
  return this.#operate(signal,timeoutMs,async({run,check,combined,deadline})=>{
   const result=await run(this.#coordinator.drain(lastMoveTime,positions,this.#maxWindow,()=>this.#historyCutoff()));check();
   const targets=this.#sink.motionClockTargets(result.clocks);
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
