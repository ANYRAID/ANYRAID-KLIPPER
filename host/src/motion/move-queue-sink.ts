import type {MotionBatch,MotionSink,MotionOutput} from './coordinator.ts';
import {MotionRetiredError,observeRetirement} from './retired.ts';
import {MoveQueueScheduler,type ScheduledPacket} from './move-queue.ts';
export interface ScheduledTransport {
 /** Queue with minClock/reqClock constraints; do not transmit immediately. */
 send(packets:readonly ScheduledPacket[]):Promise<void>;
 /** Fence in-flight sends and cancel accepted motion before acknowledging stop. */
 stop(cause:unknown):Promise<void>;
 /** Synchronously fence sends; resolve after delivery of accepted prefixes. */
 retire?(signal:AbortSignal):Promise<void>;
}
export interface MCUQueueConfig {id:string;emitters:readonly string[];moveSlots:number;clockAt:(printTime:number)=>bigint;transport:ScheduledTransport}
/** Routes coordinator batches through an independent slot heap per MCU. */
export class MoveQueueSink implements MotionSink {
 #mcus:{config:MCUQueueConfig;scheduler:MoveQueueScheduler}[];#owners:Map<string,number>;#sequence=0;#until:number;#clocks:bigint[]|undefined;
 #history:(outputs:readonly MotionOutput[])=>Promise<void>;#busy=false;#stopped=false;#stopPromise:Promise<void>|undefined;
 #retired=false;#retirement:Promise<void>|undefined;#settled=Promise.resolve();#settle:(()=>void)|undefined;#commitFault:unknown;
 constructor(configs:readonly MCUQueueConfig[],retainHistory:(outputs:readonly MotionOutput[])=>Promise<void>,initialCommittedTime=0){
  if(!configs.length||configs.length>16||new Set(configs.map(c=>c.id)).size!==configs.length||!Number.isFinite(initialCommittedTime)||initialCommittedTime<0)throw new RangeError('Invalid MCU queue configuration');
  this.#owners=new Map();this.#mcus=configs.map((c,index)=>{for(const id of c.emitters){if(this.#owners.has(id))throw new Error('Emitter belongs to multiple MCUs');this.#owners.set(id,index);}return {config:{...c,emitters:[...c.emitters]},scheduler:new MoveQueueScheduler(c.emitters,c.moveSlots)};});
  this.#history=retainHistory;this.#until=initialCommittedTime;
 }
 clockSources():readonly {readonly id:string;readonly emitters:readonly string[]}[]{return Object.freeze(this.#mcus.map(m=>Object.freeze({id:m.config.id,emitters:Object.freeze([...m.config.emitters])})));}
 /** Map every emitter boundary using the actual sink routing. Only valid once
  * all scheduled packets have been handed to transport. Caller must fence new
  * producers and still wait for ACKs and sampled MCU clocks. */
 motionClockTargets(emitters:Readonly<Record<string,bigint>>):Readonly<Record<string,bigint>>{
  if(this.#busy||this.#stopped||this.#retired||!this.#clocks||this.#mcus.some(m=>m.scheduler.pending))throw new Error('Motion sink has no drained boundary');
  const entries=Object.entries(emitters);if(entries.length!==this.#owners.size||entries.some(([id,tick])=>!this.#owners.has(id)||typeof tick!=='bigint'||tick<0n||tick>=0x7fffffffffffffffn))throw new RangeError('Clock boundary must cover every emitter');
  const clocks=[...this.#clocks];for(const [id,tick] of entries){const i=this.#owners.get(id)!;if(tick>clocks[i])clocks[i]=tick;}
  return Object.freeze(Object.fromEntries(this.#mcus.map((m,i)=>[m.config.id,clocks[i]])));
 }
 stop(cause:unknown):Promise<void>{
  if(this.#stopPromise)return this.#stopPromise;this.#stopped=true;
  this.#stopPromise=Promise.allSettled(this.#mcus.map(m=>Promise.resolve().then(()=>m.config.transport.stop(cause)))).then(results=>{const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'MCU stop failures');});return this.#stopPromise;
 }
 /** Fence every member before awaiting any one; success also waits for the
  * active history/commit callback. The owner must confirm physical stop and
  * retirement before resetting clocks or emitting replacement motion; this
  * delivery fence alone does not stop motors. Faults stop the entire group. */
 retire(signal:AbortSignal):Promise<void>{
  if(this.#retirement)return this.#retirement;
  if(this.#stopped||this.#mcus.some(m=>typeof m.config.transport.retire!=='function'))return Promise.reject(new Error('Motion sink cannot retire'));
  this.#retired=true;
  const waits=this.#mcus.map(m=>{try{return m.config.transport.retire!(signal);}catch(error){return Promise.reject(error);}});
  this.#retirement=(async()=>{
   try{
    await observeRetirement(Promise.all(waits),signal);await observeRetirement(this.#settled,signal);
    if(this.#commitFault!==undefined)throw this.#commitFault;
    if(this.#stopped)throw new Error('Motion sink stopped during retirement');
   }catch(error){try{await this.stop(error);}catch(stopError){throw new AggregateError([error,stopError],'Motion retirement and stop failed');}throw error;}
  })();return this.#retirement;
 }
 #assertSending(){if(this.#stopped)throw new Error('MCU move sink stopped during send');if(this.#retired)throw new MotionRetiredError();}
 async commit(batch:Readonly<MotionBatch>):Promise<void>{
  this.#assertSending();if(this.#busy)throw new Error('MCU move commit already active');this.#busy=true;this.#commitFault=undefined;this.#settled=new Promise(resolve=>{this.#settle=resolve;});
  try{
   if(batch.sequence!==this.#sequence||batch.from!==this.#until||!Number.isFinite(batch.until)||batch.until<=batch.from)throw new Error('Out-of-order motion batch');
   if(batch.outputs.length!==this.#owners.size||new Set(batch.outputs.map(o=>o.id)).size!==batch.outputs.length||batch.outputs.some(o=>!this.#owners.has(o.id)))throw new Error('Motion batch must contain every registered emitter exactly once');
   const clocks=this.#mcus.map(m=>m.config.clockAt(batch.until));
   for(let i=0;i<this.#mcus.length;i++)this.#mcus[i].scheduler.append(batch.outputs.filter(o=>this.#owners.get(o.id)===i));
   const packets=this.#mcus.map((m,i)=>m.scheduler.flush(clocks[i]));
   await this.#history(batch.outputs);this.#assertSending();
   for(let i=0;i<this.#mcus.length;i++){this.#assertSending();if(packets[i].length)await this.#mcus[i].config.transport.send(packets[i]);}
   this.#assertSending();this.#sequence++;this.#until=batch.until;this.#clocks=clocks;
  }catch(error){if(error instanceof MotionRetiredError&&this.#retired&&!this.#stopped)throw error;this.#commitFault=error;try{await this.stop(error);}catch(stopError){this.#commitFault=new AggregateError([error,stopError],'Move commit and stop failed');throw this.#commitFault;}throw error;}
  finally{this.#busy=false;this.#settle?.();this.#settle=undefined;}
 }
}
