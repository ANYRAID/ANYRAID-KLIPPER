import {ScheduledCoolingFan} from './fan.ts';
import {StopNotice} from '../runtime/stop-notice.ts';
interface Request {value:number;time?:number;queued:boolean;submittedThrough?:number;}
const owners=new WeakSet<ScheduledCoolingFan>();
/** Bounded ownership between motion endpoint ids and one dedicated part fan.
 * The caller owns timestamp/MCU-clock provenance and fences motion admission
 * before replacement. Clock passage is not electrical or RPM feedback. */
export class FanBoundaryTimeline {
 #fan:ScheduledCoolingFan;#entries=new Map<number,Request>();#next=1;#capacity:number;
 #horizon=0;#clock=0;#retired=0;#resolvedId=0;#resolvedTime=0;#busy=false;#settling=false;
 #stop:Promise<void>|undefined;#fault:unknown;#abort=new AbortController();#notice=new StopNotice();#off:()=>void;
 constructor(fan:ScheduledCoolingFan,capacity=Math.min(1024,fan.capacity)){
  if(owners.has(fan)||fan.status.phase!=='ready'||!Number.isInteger(capacity)||capacity<1||capacity>fan.capacity)throw new Error('Invalid fan timeline ownership');
  this.#fan=fan;this.#capacity=capacity;this.#off=fan.subscribeStop(cause=>{void this.stop(cause).catch(()=>{});});owners.add(fan);
 }
 get status(){return {pending:this.#entries.size,busy:this.#busy||this.#settling,stopped:this.#stop!==undefined,fault:this.#fault,horizon:this.#horizon,clockThrough:this.#clock,nextTime:this.#fan.status.nextTime};}
 subscribeStop(listener:(cause:unknown)=>void):()=>void{return this.#notice.subscribe(listener);}
 #active(){if(this.#stop)throw new Error('Fan timeline stopped',{cause:this.#fault});}
 register(value:number):number{
  this.#active();if(this.#busy||this.#settling)throw new Error('Fan timeline busy');
  if(!Number.isFinite(value)||value<0||this.#entries.size>=this.#capacity||!Number.isSafeInteger(this.#next))throw new RangeError('Invalid fan request or capacity');
  const id=this.#next++;this.#entries.set(id,{value,queued:false});return id;
 }
 #resolve(boundaries:readonly {id:number;time:number}[]){
  if(!Array.isArray(boundaries)||boundaries.length>65536)throw new RangeError('Invalid fan boundary batch');
  const seen=new Set<number>(),unresolved=[...this.#entries].filter(([,r])=>r.time===undefined),staged:{request:Request;id:number;time:number}[]=[];let index=0,lastId=this.#resolvedId,lastTime=this.#resolvedTime;
  for(const {id,time} of boundaries){
   if(!Number.isSafeInteger(id)||id<1||!Number.isFinite(time)||time<0||seen.has(id))throw new RangeError('Invalid fan boundary');seen.add(id);
   const request=this.#entries.get(id);
   if(!request){if(id<=this.#retired&&time<=this.#clock)continue;throw new Error('Unknown fan boundary');}
   if(request.time!==undefined){if(request.time!==time)throw new Error('Fan boundary changed without reset');continue;}
   if(unresolved[index]?.[0]!==id||id<=lastId||time<Math.max(lastTime,this.#horizon,this.#clock))throw new Error('Fan boundary order or time regressed');
   staged.push({request,id,time});index++;lastId=id;lastTime=time;
  }
  for(const {request,time} of staged)request.time=time;this.#resolvedId=lastId;this.#resolvedTime=lastTime;
 }
 deliver(boundaries:readonly {id:number;time:number}[],horizon:number,signal:AbortSignal):Promise<void>{
  if(this.#settling)return Promise.reject(new Error('Fan timeline busy'));
  return this.#deliver(boundaries,horizon,signal);
 }
 async #deliver(boundaries:readonly {id:number;time:number}[],horizon:number,signal:AbortSignal):Promise<void>{
  this.#active();if(this.#busy)throw new Error('Fan timeline busy');signal.throwIfAborted();this.#busy=true;
  const local=AbortSignal.any([signal,this.#abort.signal]);
  try{
   if(!Number.isFinite(horizon)||horizon<Math.max(this.#horizon,this.#clock))throw new RangeError('Invalid fan delivery horizon');this.#resolve(boundaries);
   for(const request of this.#entries.values())if(!request.queued&&request.time!==undefined&&request.time<=horizon){if(request.time<this.#clock)throw new Error('Fan boundary is already late');this.#fan.enqueue(request.time,request.value);request.queued=true;}
   if(this.#fan.status.nextTime!==null&&this.#fan.status.nextTime<this.#clock)throw new Error('Fan scheduled update is already late');
   await this.#fan.flush(horizon,local);local.throwIfAborted();this.#active();this.#horizon=horizon;
   // A kick or minimum scheduling delay may defer a nominal endpoint request.
   // Only an empty fan queue establishes a conservative submitted-through fence.
   if(this.#fan.status.pending===0)for(const request of this.#entries.values())if(request.queued&&request.submittedThrough===undefined)request.submittedThrough=horizon;
  }catch(error){try{await this.stop(error);}catch(stopError){throw new AggregateError([error,stopError],'Fan delivery and stop failed');}throw error;}
  finally{this.#busy=false;}
 }
 /** Motion admission must stay fenced. Flush delayed kick/interval updates,
  * preserving unresolved requests for a later resumed path. Returns an ACKed
  * horizon; the owner must still await this output MCU's sampled clock. */
 async settleScheduled(signal:AbortSignal):Promise<number>{
  this.#active();if(this.#busy||this.#settling)throw new Error('Fan timeline busy');signal.throwIfAborted();
  if([...this.#entries.values()].some(r=>r.time!==undefined&&!r.queued))throw new Error('Deliver all resolved fan boundaries before settlement');
  this.#settling=true;
  try{
   let remaining=this.#capacity*2+1;
   while(this.#fan.status.nextTime!==null){if(remaining--===0)throw new Error('Fan tail settlement did not converge');await this.#deliver([],this.#fan.status.nextTime,signal);}
   signal.throwIfAborted();this.#active();return this.#horizon;
  }catch(error){try{await this.stop(error);}catch(stopError){throw new AggregateError([error,stopError],'Fan settlement and stop failed');}throw error;}
  finally{this.#settling=false;}
 }
 /** Supply an observed clock from this fan's MCU, after transport ACK. */
 retireThrough(time:number):void{
  this.#active();if(this.#busy||this.#settling||!Number.isFinite(time)||time<this.#clock)throw new Error('Invalid fan clock retirement');
  this.#clock=time;for(const [id,r] of this.#entries){if(r.submittedThrough===undefined||r.submittedThrough>time)break;this.#entries.delete(id);this.#retired=id;}
 }
 /** Motion may replan only beyond the output submission horizon. Preserve
  * the committed prefix and pending kick repeats; forget unsent suffix times. */
 invalidateAfter(time:number):void{
  this.#active();if(this.#busy||this.#settling||!Number.isFinite(time)||time<=Math.max(this.#horizon,this.#clock))throw new Error('Fan replan overlaps submitted horizon');
  for(const r of this.#entries.values())if(r.time!==undefined&&r.time>time&&r.queued)throw new Error('Fan replan overlaps queued request');
  this.#resolvedId=0;this.#resolvedTime=this.#horizon;
  for(const [id,r] of this.#entries){if(r.time!==undefined&&r.time>time)r.time=undefined;else if(r.time!==undefined){this.#resolvedId=id;this.#resolvedTime=Math.max(this.#resolvedTime,r.time);}}
 }
 /** Caller supplies the full retained marker set after motion ownership has
  * been fenced. Output remains zero until fresh boundary times are delivered;
  * this method does not infer a pause/parking cooling policy or resume motion. */
 async replace(retained:readonly number[],signal:AbortSignal):Promise<void>{
  this.#active();if(this.#busy||this.#settling)throw new Error('Fan timeline busy');signal.throwIfAborted();
  if(!Array.isArray(retained)||retained.length>this.#capacity||new Set(retained).size!==retained.length||Array.from(retained).some((id,i)=>!this.#entries.has(id)||i>0&&id<=retained[i-1]))throw new Error('Invalid retained fan boundaries');
  const keep=new Set(retained);this.#busy=true;const local=AbortSignal.any([signal,this.#abort.signal]);
  try{
   await this.#fan.off(local);local.throwIfAborted();this.#active();
   for(const [id,r] of this.#entries)if(!keep.has(id))this.#entries.delete(id);else{r.time=undefined;r.queued=false;r.submittedThrough=undefined;}
   this.#resolvedId=0;this.#resolvedTime=this.#horizon=this.#clock;
  }catch(error){try{await this.stop(error);}catch(stopError){throw new AggregateError([error,stopError],'Fan replacement and stop failed');}throw error;}
  finally{this.#busy=false;}
 }
 stop(cause:unknown=new Error('Fan timeline stopped')):Promise<void>{
  if(this.#stop)return this.#stop;const done=Promise.withResolvers<void>();this.#stop=done.promise;this.#fault=cause;this.#entries.clear();this.#abort.abort(cause);
  try{this.#fan.stop(cause).then(done.resolve,done.reject);}catch(error){done.reject(error);}this.#off();this.#notice.emit(cause);return this.#stop;
 }
}
