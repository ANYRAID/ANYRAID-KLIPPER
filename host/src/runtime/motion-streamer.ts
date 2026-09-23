import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import type {bindRebuiltMotion} from './rebuilt-motion.ts';
import type {Move} from '../motion/lookahead.ts';
import {MotionSourceCapacityError} from '../motion/planned-motion-source.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import {waitForMcuClocks} from '../timing/mcu-clock-barrier.ts';
type Generation=Awaited<ReturnType<typeof bindRebuiltMotion>>;
/** Exclusive, paced producer. Completion means a rolling prefix was accepted,
 * not physical completion. The owner still drains final lookahead and maintains
 * timely command input; an expired generation deadline stops all MCUs. */
export class RebuiltMotionStreamer {
 #g:Generation;#busy=false;#start:number;#future:number;
 #mapping:{offset:number;frequency:number}[];#windows:{future:number;past:number}[];
 readonly #lead=.2;readonly #high=.5;readonly #low=.3;readonly #minimum=.025;
 constructor(g:Generation){
  this.#g=g;this.#start=g.source.status.sourceTime;this.#future=Math.max(...g.motion.bindings.map(b=>b.stepper.scanWindow.future));this.#mapping=g.motion.bindings.map(b=>({...b.stepper.calibration}));this.#windows=g.motion.bindings.map(b=>({...b.stepper.scanWindow}));
 }
 get status(){return {busy:this.#busy,sourceTime:this.#g.source.status.sourceTime,committedTime:this.#g.coordinator.status.committedTime};}
 #check(signal:AbortSignal){signal.throwIfAborted();this.#g.group.assertActive();for(const [i,b] of this.#g.motion.bindings.entries()){const c=b.stepper.calibration,old=this.#mapping[i];if(c.offset!==old.offset||c.frequency!==old.frequency)throw new Error('Streaming clock calibration changed');const w=b.stepper.scanWindow,saved=this.#windows[i];if(w.future!==saved.future||w.past!==saved.past)throw new Error('Streaming filter window changed');}}
 #clocks(){const now=serialClock.now();return this.#g.members.map((m,i)=>{const b=this.#g.motion.bindings.find(b=>b.member===i)!;return {member:m,stepper:b.stepper,time:b.stepper.printTimeAtClock(m.session.clock.sync.getClock(now))};});}
 #leadCheck(){if(Math.max(...this.#clocks().map(c=>c.time))+this.#minimum>Math.max(this.#start,this.#g.coordinator.status.committedTime))throw new Error('Streaming motion lead exhausted');}
 /** Each I/O wait remains bounded by 30 seconds. A whole-transaction deadline
  * is optional because valid motion may itself last longer than 30 seconds. */
 async append(moves:readonly Move[],signal:AbortSignal,timeoutMs?:number):Promise<void>{
  if(this.#busy)throw new Error('Motion streamer busy');this.#busy=true;
  try{
   this.#check(signal);if(timeoutMs!==undefined&&(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000)||!Array.isArray(moves)||moves.length>100000)throw new RangeError('Invalid streaming batch or timeout');
   const deadline=timeoutMs===undefined?Infinity:performance.now()+timeoutMs,remaining=()=>{this.#check(signal);const value=Math.ceil(deadline-performance.now());if(value<=0)throw new Error('Motion streaming timed out');return Math.min(30000,value);};
   // Own the suffix before pacing can yield to a caller that mutates its batch.
   const owned=moves.map(m=>Object.assign(Object.create(Object.getPrototypeOf(m)),m,{startPos:[...m.startPos],endPos:[...m.endPos],axesD:[...m.axesD],axesR:[...m.axesR],profile:m.profile?{...m.profile}:undefined})) as Move[];
   const source=this.#g.source,initial=source.status;
   if(initial.paused||!initial.seeded){
    if(!owned.length)return;
    const padding=Math.max(.001,...this.#windows.flatMap(w=>[w.future,w.past]));
    const start=Math.max(initial.sourceTime+padding+.001,Math.max(...this.#clocks().map(c=>c.time))+this.#lead+padding);
    this.#start=start-this.#future;
    if(initial.paused)source.resumeAt(start);else source.startAt(start);
   }
   source.validateBatch(owned);await source.prepareIdle(signal,remaining());remaining();
   const flush=async()=>{
    while(source.status.sourceTime-this.#future-.001>this.#g.coordinator.status.generatedTime){
     remaining();this.#leadCheck();const clocks=this.#clocks();
     const until=Math.min(source.status.sourceTime,Math.min(...clocks.map(c=>c.time))+this.#high+this.#future+.003);
     if(until<this.#g.coordinator.status.generatedTime)throw new Error('Streaming clock horizon regressed');
     await source.flushThrough(until,signal,remaining());remaining();this.#leadCheck();
     if(source.status.sourceTime-this.#future-.001<=this.#g.coordinator.status.generatedTime)return;
     const target=this.#g.coordinator.status.committedTime-this.#low;
     // Estimate only when to ask for a sample, never completion. Sleeping until
     // the target is due avoids repeated query traffic while it is in the future.
     const waitMs=Math.max(0,(target-Math.min(...this.#clocks().map(c=>c.time)))*1000);
     if(waitMs)try{await delay(Math.min(waitMs,remaining()),undefined,{signal});}catch(error){signal.throwIfAborted();throw error;}remaining();
     await waitForMcuClocks(clocks.map(c=>({clock:c.member.session.clock,tick:c.stepper.clockAt(target)})),signal,{timeoutSeconds:remaining()/1000,pollSeconds:.025});remaining();
    }
   };
   let offset=0;
   while(offset<owned.length){
    this.#leadCheck();const available=source.status.availableMoves;
    if(!available){await flush();if(!source.status.availableMoves)throw new MotionSourceCapacityError('Streaming capacity cannot cover native filter tail');continue;}
    const count=Math.min(available,owned.length-offset);source.append(owned.slice(offset,offset+count));offset+=count;await flush();
   }
   if(!owned.length)await flush();
  }catch(error){try{await this.#g.drain.stop(error);}catch(stop){throw new AggregateError([error,stop],'Motion stream and stop failed');}throw error;}
  finally{this.#busy=false;}
 }
}
