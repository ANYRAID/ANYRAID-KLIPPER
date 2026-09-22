import {SerialSession} from '../protocol/serial-session.ts';
import {serialClock,type NativeTriggerDispatch} from '../protocol/serial-queue.ts';
import {trsyncFormats,type TriggerPlan} from '../inputs/trsync.ts';
import type {EndstopProtocol,EndstopSampling} from '../inputs/endstop.ts';
import type {HomingMember} from './stop-confirmation.ts';
import {observeRetirement} from '../motion/retired.ts';
import {encodeFrame} from '../protocol/codec.ts';
/** Owns subscriptions and original C fastreader dispatch for one armed move.
 * Does not generate motion, infer homed axes or replace stop/readback recovery. */
export class HomingTriggerGroup {
 #members:readonly HomingMember[];#plans:readonly TriggerPlan[];#primary:number;#endstopOid:number;#sampling:EndstopSampling;
 #native:NativeTriggerDispatch;#unsubscribe:(()=>void)[]=[];#released=false;#armed=false;#started=false;#timeout:number;
 #arming:Promise<void>|undefined;#fault:unknown;#cleanup:Promise<void>|undefined;#cleanupPending=false;#cleanupErrors:unknown[]=[];
 #resolve!:(value:{member:number;reason:number})=>void;#reject!:(error:unknown)=>void;#rejectFailure!:(error:unknown)=>void;
 /** Remains able to reject after completion, until release detaches observers. */
 readonly failure:Promise<never>;
 /** First nonfault stop notification; this is not proof of a global endstop
  * hit. Recovery readback determines the authoritative primary stop reason. */
 readonly completion:Promise<Readonly<{member:number;reason:number}>>;
 constructor(members:readonly HomingMember[],primary:number,endstop:EndstopProtocol,sampling:EndstopSampling,startClocks:readonly bigint[],expireTimeout:number,timeoutMs=5000){
  if(!members.length||members.length>16||new Set(members.map(m=>m.session)).size!==members.length||!Number.isInteger(primary)||primary<0||primary>=members.length||startClocks.length!==members.length||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>60000||sampling.reqClock!==startClocks[primary]||typeof sampling.restTicks!=='bigint'||sampling.restTicks<=0n||sampling.restTicks>0x7fffffffn)throw new Error('Invalid homing trigger group');
  this.#members=members.map(m=>({...m,steppers:m.steppers.map(s=>({...s}))}));
  for(const m of this.#members){m.session.assertCommandQueue(m.queue);m.trigger.assertDictionary(m.session.dictionary);}
  endstop.assertDictionary(members[primary].session.dictionary);
  if(members[primary].trigger.oid===endstop.oid||members[primary].steppers.some(s=>s.oid===endstop.oid))throw new Error('Conflicting homing OIDs');
  const commands=members[primary].session.dictionary.parseFrame(encodeFrame(0,sampling.payload)),p=commands[0]?.parameters;
  if(commands.length!==1||commands[0].name!=='endstop_home'||p.oid!==endstop.oid||p.clock!==Number(BigInt.asUintN(32,sampling.reqClock))||p.rest_ticks!==Number(sampling.restTicks)||p.trsync_oid!==members[primary].trigger.oid||p.trigger_reason!==1||typeof p.sample_ticks!=='number'||p.sample_ticks<1||p.sample_ticks>0x7fffffff||typeof p.sample_count!=='number'||p.sample_count<1||p.sample_count>255||p.sample_ticks*(p.sample_count-1)>0x7fffffff||p.pin_value!==0&&p.pin_value!==1)throw new Error('Invalid homing sampling packet');
  this.#plans=this.#members.map((m,i)=>m.trigger.start(startClocks[i],m.steppers.map(s=>s.oid),expireTimeout,i/members.length));
  this.#primary=primary;this.#endstopOid=endstop.oid;this.#sampling={...sampling,payload:sampling.payload.slice()};this.#timeout=timeoutMs;
  this.#assertFuture();
  this.#native=SerialSession.createTriggerDispatch(this.#members.map((m,i)=>({session:m.session,queue:m.queue,protocol:m.trigger,plan:this.#plans[i]})));
  this.completion=new Promise((resolve,reject)=>{this.#resolve=resolve;this.#reject=reject;});void this.completion.catch(()=>{});
  this.failure=new Promise((_,reject)=>{this.#rejectFailure=reject;});void this.failure.catch(()=>{});
 }
 get status(){return {started:this.#started,armed:this.#armed,released:this.#released,fault:this.#fault,cleanupPending:this.#cleanupPending,cleanupErrors:[...this.#cleanupErrors]};}
 conflictsWith(other:HomingTriggerGroup):boolean{
  const objects=(g:HomingTriggerGroup)=>g.#members.map((m,i)=>({session:m.session,oids:[m.trigger.oid,...m.steppers.map(s=>s.oid),...i===g.#primary?[g.#endstopOid]:[]]}));
  return objects(this).some(m=>objects(other).some(n=>m.session===n.session&&m.oids.some(oid=>n.oids.includes(oid))));
 }
 #assertFuture(){for(let i=0;i<this.#members.length;i++){const m=this.#members[i];m.session.assertActive();if(this.#plans[i].startClock<=m.session.clock.sync.getClock(serialClock.now()))throw new Error('Homing arm start clock has expired');}}
 /** Start plans are ACKed on their respective FIFO before the native fastreader
  * is started. Endstop sampling is enabled only after every member is ready. */
 arm(signal:AbortSignal):Promise<void>{return this.#arming??=this.#arm(signal);}
 async #arm(signal:AbortSignal){
  this.#started=true;const controller=new AbortController(),abort=()=>controller.abort(signal.reason??new Error('Homing arm cancelled'));
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();const timer=setTimeout(()=>controller.abort(new Error('Homing arm timed out')),this.#timeout),s=controller.signal;
  try{
   s.throwIfAborted();if(this.#released)throw new Error('Homing trigger group already released');this.#assertFuture();
   for(const [member,m] of this.#members.entries())this.#unsubscribe.push(m.session.subscribeResponse(trsyncFormats.state,m.trigger.oid,{receive:reply=>{
    try{const state=m.trigger.decode(reply.message);if(!state||state.canTrigger)return;if(state.failure||!this.#armed)throw new Error('MCU trigger stopped before successful arming');this.#resolve(Object.freeze({member,reason:state.reason}));}
    catch(error){void this.#fail(error).catch(()=>{});}
   },closed:error=>{void this.#fail(error).catch(()=>{});}}));
   await observeRetirement(Promise.all(this.#members.map(async(m,i)=>{for(const packet of this.#plans[i].packets){s.throwIfAborted();if(this.#released)throw this.#fault??new Error('Homing trigger released');await m.queue.send(packet.data,packet.min,packet.req,s);}})),s);
   s.throwIfAborted();this.#assertFuture();if(this.#released)throw this.#fault??new Error('Homing trigger released');
   this.#native.start();this.#armed=true;
   await this.#members[this.#primary].queue.send(this.#sampling.payload,0n,this.#sampling.reqClock,s);
   s.throwIfAborted();this.#assertFuture();if(this.#released)throw this.#fault??new Error('Homing trigger released');
  }catch(error){const deadline=new AbortController(),cleanupTimer=setTimeout(()=>deadline.abort(new Error('Homing arm cleanup timed out')),this.#timeout);try{await observeRetirement(this.#fail(error),deadline.signal);}catch(cleanup){throw new AggregateError([error,cleanup],'Homing arm and cleanup failed');}finally{clearTimeout(cleanupTimer);}throw error;}
  finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
 }
 /** Detach only. Use as HomingRecovery.release after disabling sampling.
  * This is not a device stop; unrecovered motion still requires a safety path. */
 release():void{if(this.#released)return;this.#released=true;this.#armed=false;for(const unsubscribe of this.#unsubscribe.splice(0))unsubscribe();this.#native.close();this.#reject(new Error('Homing trigger group released'));}
 /** Safety failure/cancellation, unlike release(): stop every owned session. */
 stop(cause:unknown=new Error('Homing trigger group stopped')):Promise<void>{return this.#fail(cause);}
 #fail(error:unknown):Promise<void>{
  if(this.#cleanup)return this.#cleanup;this.#fault=error;this.#rejectFailure(error);this.#reject(error);let releaseError:unknown;try{this.release();}catch(e){releaseError=e;}
  this.#cleanupPending=true;
  this.#cleanup=Promise.allSettled(this.#members.map(m=>m.session.stop(error))).then(results=>{this.#cleanupErrors=[...(releaseError===undefined?[]:[releaseError]),...results.filter(r=>r.status==='rejected').map(r=>r.reason)];if(this.#cleanupErrors.length)throw new AggregateError(this.#cleanupErrors,'Homing trigger safety stop failed');}).finally(()=>{this.#cleanupPending=false;});return this.#cleanup;
 }
}
