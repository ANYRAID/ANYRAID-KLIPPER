import type {MotionBatch,MotionSink,MotionOutput} from './coordinator.ts';
import {MoveQueueScheduler,type ScheduledPacket} from './move-queue.ts';
export interface ScheduledTransport {
 /** Queue with minClock/reqClock constraints; do not transmit immediately. */
 send(packets:readonly ScheduledPacket[]):Promise<void>;
 /** Fence in-flight sends and cancel accepted motion before acknowledging stop. */
 stop(cause:unknown):Promise<void>;
}
export interface MCUQueueConfig {id:string;emitters:readonly string[];moveSlots:number;clockAt:(printTime:number)=>bigint;transport:ScheduledTransport}
/** Routes coordinator batches through an independent slot heap per MCU. */
export class MoveQueueSink implements MotionSink {
 #mcus:{config:MCUQueueConfig;scheduler:MoveQueueScheduler}[];#owners:Map<string,number>;#sequence=0;#until:number;
 #history:(outputs:readonly MotionOutput[])=>Promise<void>;#busy=false;#stopped=false;#stopPromise:Promise<void>|undefined;
 constructor(configs:readonly MCUQueueConfig[],retainHistory:(outputs:readonly MotionOutput[])=>Promise<void>,initialCommittedTime=0){
  if(!configs.length||configs.length>16||new Set(configs.map(c=>c.id)).size!==configs.length||!Number.isFinite(initialCommittedTime)||initialCommittedTime<0)throw new RangeError('Invalid MCU queue configuration');
  this.#owners=new Map();this.#mcus=configs.map((c,index)=>{for(const id of c.emitters){if(this.#owners.has(id))throw new Error('Emitter belongs to multiple MCUs');this.#owners.set(id,index);}return {config:{...c,emitters:[...c.emitters]},scheduler:new MoveQueueScheduler(c.emitters,c.moveSlots)};});
  this.#history=retainHistory;this.#until=initialCommittedTime;
 }
 stop(cause:unknown):Promise<void>{
  if(this.#stopPromise)return this.#stopPromise;this.#stopped=true;
  this.#stopPromise=Promise.allSettled(this.#mcus.map(m=>Promise.resolve().then(()=>m.config.transport.stop(cause)))).then(results=>{const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'MCU stop failures');});return this.#stopPromise;
 }
 async commit(batch:Readonly<MotionBatch>):Promise<void>{
  if(this.#stopped)throw new Error('MCU move sink is stopped');if(this.#busy)throw new Error('MCU move commit already active');this.#busy=true;
  try{
   if(batch.sequence!==this.#sequence||batch.from!==this.#until||!Number.isFinite(batch.until)||batch.until<=batch.from)throw new Error('Out-of-order motion batch');
   if(batch.outputs.length!==this.#owners.size||new Set(batch.outputs.map(o=>o.id)).size!==batch.outputs.length||batch.outputs.some(o=>!this.#owners.has(o.id)))throw new Error('Motion batch must contain every registered emitter exactly once');
   const clocks=this.#mcus.map(m=>m.config.clockAt(batch.until));
   for(let i=0;i<this.#mcus.length;i++)this.#mcus[i].scheduler.append(batch.outputs.filter(o=>this.#owners.get(o.id)===i));
   const packets=this.#mcus.map((m,i)=>m.scheduler.flush(clocks[i]));
   await this.#history(batch.outputs);if(this.#stopped)throw new Error('MCU move sink stopped during history retention');
   for(let i=0;i<this.#mcus.length;i++){if(this.#stopped)throw new Error('MCU move sink stopped during send');if(packets[i].length)await this.#mcus[i].config.transport.send(packets[i]);}
   if(this.#stopped)throw new Error('MCU move sink stopped during send');this.#sequence++;this.#until=batch.until;
  }catch(error){try{await this.stop(error);}catch(stopError){throw new AggregateError([error,stopError],'Move commit and stop failed');}throw error;}
  finally{this.#busy=false;}
 }
}
