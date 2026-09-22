// Multi-endstop completion semantics from klippy/extras/homing.py.
// GPL-3.0-or-later. A completed notification is not homed-axis authority.
import {HomingTriggerGroup} from './trigger-group.ts';
import {observeRetirement} from '../motion/retired.ts';
export interface TriggerGroupOutcome {readonly group:number;readonly member:number;readonly reason:number;}
/** One owner for independent endstop groups (including groups on shared MCUs).
 * All groups must stop for normal completion; any failure fences all devices.
 * Register distinct trsync OIDs and nonoverlapping stepper ownership per group. */
export class HomingTriggerSet {
 #groups:readonly HomingTriggerGroup[];#results:(TriggerGroupOutcome|undefined)[];#remaining:number;
 #armed=false;#released=false;#fault:unknown;#failed=false;#timeout:number;
 #arming:Promise<void>|undefined;#stopping:Promise<void>|undefined;#cleanupPending=false;#cleanupErrors:unknown[]=[];
 #resolve!:(results:readonly TriggerGroupOutcome[])=>void;#reject!:(error:unknown)=>void;
 readonly completion:Promise<readonly TriggerGroupOutcome[]>;
 constructor(groups:readonly HomingTriggerGroup[],cleanupTimeoutMs=5000){
  if(!groups.length||groups.length>16||new Set(groups).size!==groups.length||groups.some(g=>!(g instanceof HomingTriggerGroup)||g.status.started||g.status.released)||groups.some((g,i)=>groups.slice(0,i).some(other=>g.conflictsWith(other)))||!Number.isFinite(cleanupTimeoutMs)||cleanupTimeoutMs<1||cleanupTimeoutMs>60000)throw new Error('Invalid homing trigger set');
  this.#groups=[...groups];this.#results=groups.map(()=>undefined);this.#remaining=groups.length;this.#timeout=cleanupTimeoutMs;
  this.completion=new Promise((resolve,reject)=>{this.#resolve=resolve;this.#reject=reject;});void this.completion.catch(()=>{});
  groups.forEach((g,group)=>{void g.completion.then(result=>{if(this.#released||this.#failed)return;this.#results[group]=Object.freeze({group,...result});this.#remaining--;this.#complete();},error=>{if(!this.#released)void this.stop(error).catch(()=>{});});});
  groups.forEach(g=>{void g.failure.catch(error=>{if(!this.#released)void this.stop(error).catch(()=>{});});});
 }
 get status(){return {armed:this.#armed,released:this.#released,remaining:this.#remaining,failed:this.#failed,fault:this.#fault,cleanupPending:this.#cleanupPending,cleanupErrors:[...this.#cleanupErrors]};}
 #assertHealthy(){if(this.#failed)throw this.#fault;for(const g of this.#groups){const fault=g.status.fault;if(fault!==undefined)throw fault;}}
 #complete(){if(this.#armed&&!this.#failed&&!this.#released&&this.#remaining===0)this.#resolve(Object.freeze(this.#results.map(r=>r!)));}
 arm(signal:AbortSignal):Promise<void>{return this.#arming??=this.#arm(signal);}
 async #arm(signal:AbortSignal){
  try{
   signal.throwIfAborted();if(this.#released||this.#failed||this.#groups.some(g=>g.status.started||g.status.released))throw new Error('Homing trigger set cannot arm');
   await observeRetirement(Promise.all(this.#groups.map(g=>g.arm(signal))),signal);
   signal.throwIfAborted();if(this.#released||this.#failed)throw this.#fault??new Error('Homing trigger set released');
   this.#assertHealthy();this.#armed=true;this.#complete();
  }catch(error){try{await this.stop(error);}catch(cleanup){throw new AggregateError([error,cleanup],'Homing trigger set arm and cleanup failed');}throw error;}
 }
 /** Wait for all independent endstops. Cancellation stops all groups, even
  * when some have already triggered successfully. */
 async wait(signal:AbortSignal):Promise<readonly TriggerGroupOutcome[]>{
  try{this.#assertHealthy();await observeRetirement(this.completion,signal);const result=await this.completion;signal.throwIfAborted();this.#assertHealthy();return result;}
  catch(error){try{await this.stop(error);}catch(cleanup){throw new AggregateError([error,cleanup],'Homing trigger wait and cleanup failed');}throw error;}
 }
 /** Detach only, after the motion owner has established its stop boundary. */
 release():void{
  if(this.#released)return;this.#released=true;this.#armed=false;this.#reject(new Error('Homing trigger set released'));
  const errors:unknown[]=[];for(const g of this.#groups)try{g.release();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Homing trigger release failures');
 }
 stop(cause:unknown=new Error('Homing trigger set stopped')):Promise<void>{
  if(this.#stopping)return this.#stopping;this.#failed=true;this.#fault=cause;this.#armed=false;this.#reject(cause);this.#cleanupPending=true;
  const cleanup=Promise.allSettled(this.#groups.map(g=>g.stop(cause))).then(results=>{this.#cleanupErrors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(this.#cleanupErrors.length)throw new AggregateError(this.#cleanupErrors,'Homing trigger set safety failures');}).finally(()=>{this.#cleanupPending=false;});
  const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new Error('Homing trigger set cleanup timed out')),this.#timeout);
  this.#stopping=observeRetirement(cleanup,deadline.signal).finally(()=>clearTimeout(timer));return this.#stopping;
 }
}
