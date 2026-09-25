import {replanWithDwells,validateDwell} from '../motion/dwell.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import type {bindRebuiltMotion} from './rebuilt-motion.ts';
import {copyPressureBoundaries} from '../motion/pressure-boundaries.ts';
import {copyPressureWindowChanges,type PressureWindowChange} from '../motion/pressure-advance-settings.ts';
import {copyEndMarkers} from '../motion/boundary-markers.ts';
import {type Move} from '../motion/lookahead.ts';
import {validateStopPath} from '../motion/path-stop.ts';
import {isPromise} from 'node:util/types';
import {MotionSourceCapacityError} from '../motion/planned-motion-source.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import {waitForMcuClocks} from '../timing/mcu-clock-barrier.ts';
type Generation=Awaited<ReturnType<typeof bindRebuiltMotion>>;
export interface StreamPause {readonly position:readonly number[];readonly sourceTime:number;}
const own=(moves:readonly Move[]):Move[]=>moves.map(m=>Object.assign(Object.create(Object.getPrototypeOf(m)),m,{pressureBoundaries:copyPressureBoundaries(m.pressureBoundaries),endMarkers:copyEndMarkers(m.endMarkers),limits:{...m.limits,extraAxes:m.limits.extraAxes?[...m.limits.extraAxes]:undefined},startPos:[...m.startPos],endPos:[...m.endPos],axesD:[...m.axesD],axesR:[...m.axesR],profile:m.profile?{...m.profile}:undefined}));
type PauseRequest=ReturnType<typeof Promise.withResolvers<StreamPause>>&{tail:Move[];phase:'requested'|'braking'|'paused'|'resuming';validate?:((move:Move)=>void);resumption?:ReturnType<typeof Promise.withResolvers<void>>;pressureOverrides?:Set<string>};
/** Exclusive, paced producer. Completion means a rolling prefix was accepted,
 * not physical completion. The owner still drains final lookahead and maintains
 * timely command input; an expired generation deadline stops all MCUs. */
export class RebuiltMotionStreamer {
 #g:Generation;#busy=false;#acceptPause=false;#start:number;#future:number;
 #windows:{future:number;past:number}[];
 #windowFrontier:number|undefined;
 #pressureBusy=false;
 #pause:PauseRequest|undefined;#wake:(()=>void)|undefined;#end:{position:readonly number[];velocity:number};
 readonly #lead=.2;readonly #high=.5;readonly #low=.3;readonly #minimum=.025;
 constructor(g:Generation){
  this.#g=g;this.#start=g.source.status.sourceTime;this.#future=Math.max(...g.motion.bindings.map(b=>b.stepper.scanWindow.future));this.#windows=g.motion.bindings.map(b=>({...b.stepper.scanWindow}));
  this.#end={position:g.source.status.position,velocity:0};
 }
 get status(){return {busy:this.#busy,pause:this.#pause?.phase??'none',sourceTime:this.#g.source.status.sourceTime,committedTime:this.#g.coordinator.status.committedTime};}
 /** The exclusive owner has submitted all lookahead through a resting tail.
  * Refresh cached convolution requirements only after the source accepts them. */
 async reconfigurePressureWindows(changes:readonly PressureWindowChange[],signal:AbortSignal,timeoutMs=30000):Promise<void>{
  if(this.#busy||this.#pause||this.#pressureBusy)throw new Error('Motion streamer busy');
  const owned=copyPressureWindowChanges(changes);this.#busy=true;
  try{
   this.#check(signal);await this.#g.source.reconfigurePressureWindows(owned,signal,timeoutMs);
   signal.throwIfAborted();this.#g.assertClockCalibration();
   const windows=this.#g.motion.bindings.map(b=>({...b.stepper.scanWindow}));
   this.#future=Math.max(...windows.map(w=>w.future));this.#windows=windows;
   this.#windowFrontier=this.#g.coordinator.status.generatedTime;
   this.#end={position:this.#g.source.status.position,velocity:0};
  }catch(error){try{await this.#g.drain.stop(error);}catch(stop){throw new AggregateError([error,stop],'Pressure window stream and stop failed');}throw error;}
  finally{this.#busy=false;}
 }
 /** Paused tuning supersedes older, still-owned parameter events for the
  * selected emitters. Geometry and unrelated endpoint events remain intact. */
 async reconfigurePausedPressureWindows(changes:readonly PressureWindowChange[],signal:AbortSignal,timeoutMs=30000):Promise<void>{
  if(this.#pressureBusy||this.#busy&&this.#pause?.phase!=='paused'||this.#pause&&this.#pause.phase!=='paused'||!this.#g.source.status.paused)throw new Error('Motion streamer is not available for paused pressure');
  const owned=copyPressureWindowChanges(changes);this.#pressureBusy=true;
  try{
   this.#check(signal);await this.#g.source.reconfigurePausedPressureWindows(owned,signal,timeoutMs,()=>{
    this.#windows=this.#g.motion.bindings.map(b=>({...b.stepper.scanWindow}));this.#future=Math.max(...this.#windows.map(w=>w.future));this.#windowFrontier=this.#g.coordinator.status.generatedTime;
   });this.#check(signal);
   if(this.#pause){this.#pause.pressureOverrides??=new Set();for(const c of owned)this.#pause.pressureOverrides.add(c.stepper);}
  }catch(error){try{await this.#g.drain.stop(error);}catch(stop){throw new AggregateError([error,stop],'Paused pressure update and stop failed');}throw error;}
  finally{this.#pressureBusy=false;}
 }
 /** Caller must transfer the remaining lookahead tail, ending at rest. The
  * active append stays pending until explicit resume and suffix submission. */
 requestPause(tail:readonly Move[]=[]):Promise<StreamPause>{
  try{
   if(!this.#busy||!this.#acceptPause)throw new Error('No active motion stream to pause');
   if(!Array.isArray(tail)||tail.length>100000)throw new RangeError('Invalid pause tail');
   if(this.#pause){if(this.#pause.validate)throw new Error('Motion stream is resuming');if(tail.length)throw new Error('Pause already owns its closing tail');return this.#pause.promise;}
   const saved=own(tail);validateStopPath(saved);
   if(saved.length){const first=saved[0];if(first.startPos.length!==this.#end.position.length||first.startPos.some((v,i)=>v!==this.#end.position[i])||Math.abs(first.profile!.startV-this.#end.velocity)>128*Number.EPSILON*Math.max(1,this.#end.velocity))throw new Error('Pause tail does not continue the active stream');}
   if((saved.at(-1)?.profile?.endV??this.#end.velocity)!==0)throw new Error('Pause requires the complete lookahead tail ending at rest');
   const request:PauseRequest={...Promise.withResolvers<StreamPause>(),tail:saved,phase:'requested'};void request.promise.catch(()=>{});this.#pause=request;return request.promise;
  }catch(error){return Promise.reject(error);}
 }
 /** Revalidate each retained segment synchronously (including live extrusion
  * permission). Validation may lower limits; replanning follows before sending. */
 resume(validate:(move:Move)=>void):Promise<void>{
  if(this.#pressureBusy)return Promise.reject(new Error('Paused pressure update is busy'));
  if(this.#pause?.phase!=='paused'||this.#pause.validate||typeof validate!=='function')throw new Error('Motion stream is not awaiting resume validation');
  const done=Promise.withResolvers<void>();void done.promise.catch(()=>{});this.#pause.resumption=done;this.#pause.validate=validate;this.#wake?.();return done.promise;
 }
 async #waitResume(signal:AbortSignal,ms:number):Promise<void>{
  await new Promise<void>((resolve,reject)=>{let timer:ReturnType<typeof setTimeout>;const finish=(error?:unknown)=>{clearTimeout(timer);signal.removeEventListener('abort',abort);this.#wake=undefined;error===undefined?resolve():reject(error);},abort=()=>finish(signal.reason);this.#wake=()=>finish();timer=setTimeout(()=>finish(),ms);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
 }
 #check(signal:AbortSignal){signal.throwIfAborted();this.#g.assertClockCalibration();for(const [i,b] of this.#g.motion.bindings.entries()){const w=b.stepper.scanWindow,saved=this.#windows[i];if(w.future!==saved.future||w.past!==saved.past)throw new Error('Streaming filter window changed');}}
 #clocks(){const now=serialClock.now();return this.#g.clockMembers.map(m=>({member:m,stepper:m.stepper,time:m.stepper.printTimeAtClock(m.session.clock.sync.getClock(now))}));}
 #leadCheck(){if(Math.max(...this.#clocks().map(c=>c.time))+this.#minimum>Math.max(this.#start,this.#g.coordinator.status.committedTime))throw new Error('Streaming motion lead exhausted');}
 /** Each I/O wait remains bounded by 30 seconds. A whole-transaction deadline
  * is optional because valid motion may itself last longer than 30 seconds. */
 async append(moves:readonly Move[],signal:AbortSignal,timeoutMs?:number):Promise<void>{
  if(this.#busy||this.#pressureBusy)throw new Error('Motion streamer busy');this.#busy=true;
  try{
   this.#check(signal);if(timeoutMs!==undefined&&(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000)||!Array.isArray(moves)||moves.length>100000)throw new RangeError('Invalid streaming batch or timeout');
   const deadline=timeoutMs===undefined?Infinity:performance.now()+timeoutMs,remaining=()=>{this.#check(signal);const value=Math.ceil(deadline-performance.now());if(value<=0)throw new Error('Motion streaming timed out');return Math.min(30000,value);};
   // Own the suffix before pacing can yield to a caller that mutates its batch.
   let owned=own(moves),offset=0;const source=this.#g.source;
   if(!owned.length&&(source.status.paused||!source.status.seeded))return;
   if(owned.length)this.#end={position:[...owned.at(-1)!.endPos],velocity:owned.at(-1)!.profile?.endV??NaN};
   const prepareStart=()=>{const initial=source.status;if(initial.paused||!initial.seeded){
    if(!owned.length)return;
    const padding=Math.max(.001,...this.#windows.flatMap(w=>[w.future,w.past]));
    const start=Math.max(initial.sourceTime+padding+.001,Math.max(...this.#clocks().map(c=>c.time))+this.#lead+padding);
    this.#start=start-this.#future;
    if(initial.paused)source.resumeAt(start);else source.startAt(start);
   }};prepareStart();
   source.validateBatch(owned);this.#acceptPause=true;await source.prepareIdle(signal,remaining());remaining();
   const pause=async():Promise<boolean>=>{
    const request=this.#pause;if(!request||request.phase!=='requested')return false;request.phase='braking';
    if(owned.length+request.tail.length>100000||source.status.bufferedMoves+owned.length-offset+request.tail.length>100000)throw new RangeError('Pause path capacity exceeded');
    owned=owned.concat(request.tail);source.validateBatch(owned.slice(offset));
    const cut=Math.max(this.#g.coordinator.status.generatedTime+this.#future+.01,Math.max(...this.#clocks().map(c=>c.time))+this.#lead+this.#future+.01,this.#start+this.#future+.01);
    while(offset<owned.length&&source.status.availableMoves){const offered=owned.slice(offset,offset+source.status.availableMoves),count=source.pressureAppendCapacity(offered);if(!count)break;source.append(offered.slice(0,count));offset+=count;}
    if(cut>=source.status.sourceTime&&offset<owned.length)throw new MotionSourceCapacityError('Pause capacity cannot cover the braking anchor');
    let retained:Move[]=[];
    if(cut<source.status.sourceTime){const stop=await source.brakeAt(cut,signal,remaining());retained=stop.remainder.concat(owned.slice(offset));}
    await flush(false);remaining();await source.drain([],signal,remaining());remaining();
    request.phase='paused';request.resolve(Object.freeze({position:Object.freeze([...source.status.position]),sourceTime:source.status.sourceTime}));
    while(!request.validate){await this.#waitResume(signal,Math.min(100,remaining()));remaining();}
    request.phase='resuming';
    if(request.pressureOverrides)for(const m of retained)m.pressureBoundaries=copyPressureBoundaries(m.pressureBoundaries?.filter(c=>!request.pressureOverrides!.has(c.stepper)));
    for(const m of retained){
     if(m.dwellSeconds!==undefined){validateDwell(m);continue;}
     const geometry=[...m.startPos,...m.endPos,...m.axesD,...m.axesR,m.distance,Number(m.isKinematic)],accel=m.accel,speed=m.maxCruiseV2;
     m.profile=undefined;m.maxStartV2=0;m.maxMcrStartV2=0;const result:unknown=request.validate(m);if(result!==undefined){if(isPromise(result))void result.catch(()=>{});throw new Error('Resume validation must complete synchronously');}
     const after=[...m.startPos,...m.endPos,...m.axesD,...m.axesR,m.distance,Number(m.isKinematic)];
     if(after.length!==geometry.length||after.some((v,i)=>v!==geometry[i])||m.accel>accel||m.maxCruiseV2>speed)throw new Error('Resume validation changed geometry or raised limits');
    }
    owned=replanWithDwells(own(retained));offset=0;
    validateStopPath(owned);if(owned.length&&owned[0].profile!.startV!==0)throw new Error('Resume path must start at rest');
    prepareStart();source.validateBatch(owned);if(owned.length)await source.prepareIdle(signal,remaining());remaining();
    this.#end={position:owned.length?[...owned.at(-1)!.endPos]:source.status.position,velocity:0};this.#pause=undefined;request.resumption?.resolve();return true;
   };
   const waitForRoom=async()=>{
    const clocks=this.#clocks(),target=this.#g.coordinator.status.committedTime-this.#low;
    // Estimate only when to request a sample; observed clocks prove progress.
    const waitMs=Math.max(0,(target-Math.min(...clocks.map(c=>c.time)))*1000);
    if(waitMs)try{await delay(Math.min(waitMs,remaining()),undefined,{signal});}catch(error){signal.throwIfAborted();throw error;}remaining();
    await waitForMcuClocks(clocks.map(c=>({clock:c.member.session.clock,tick:c.member.timeline?c.member.timeline.reserve(target):c.stepper.clockAt(target)})),signal,{timeoutSeconds:remaining()/1000,pollSeconds:.025});remaining();
   };
   const flush=async(allowPause=true)=>{
    while(true){
     if(allowPause&&await pause())return;
     if(source.status.sourceTime-this.#future-.001<=this.#g.coordinator.status.generatedTime)return;
     remaining();this.#leadCheck();const clocks=this.#clocks();
     const until=Math.min(source.status.sourceTime,Math.min(...clocks.map(c=>c.time))+this.#high+this.#future+.003);
     if(until<this.#g.coordinator.status.generatedTime){
      if(this.#windowFrontier!==this.#g.coordinator.status.generatedTime)throw new Error('Streaming clock horizon regressed');
      await waitForRoom();continue;
     }
     this.#windowFrontier=undefined;
     this.#g.maintainClocks(Math.max(this.#g.coordinator.status.generatedTime,until-this.#future-.001));remaining();
     await source.flushThrough(until,signal,remaining());remaining();this.#leadCheck();
     if(source.status.sourceTime-this.#future-.001<=this.#g.coordinator.status.generatedTime)continue;
     await waitForRoom();
    }
   };
   let flushEmpty=!owned.length;
   while(offset<owned.length||flushEmpty||this.#pause?.phase==='requested'){
    if(offset===owned.length){flushEmpty=false;await flush();continue;}
    this.#leadCheck();const available=source.status.availableMoves;
    if(!available){await flush();if(!source.status.availableMoves)throw new MotionSourceCapacityError('Streaming capacity cannot cover native filter tail');continue;}
    const offered=owned.slice(offset,offset+Math.min(available,owned.length-offset)),count=source.pressureAppendCapacity(offered);
    if(!count){const before=this.#g.coordinator.status.generatedTime,previous=owned;await flush();if(owned===previous&&this.#g.coordinator.status.generatedTime===before)throw new MotionSourceCapacityError('Pressure history cannot cover the solver lookahead window');continue;}
    source.append(offered.slice(0,count));offset+=count;await flush();
   }
  }catch(error){this.#acceptPause=false;this.#pause?.reject(error);this.#pause?.resumption?.reject(error);try{await this.#g.drain.stop(error);}catch(stop){throw new AggregateError([error,stop],'Motion stream and stop failed');}throw error;}
  finally{this.#acceptPause=false;this.#busy=false;this.#pause=undefined;this.#wake=undefined;}
 }
}
