import {OutputBoundaryTimeline} from './output-boundaries.ts';
import {StopNotice} from '../runtime/stop-notice.ts';
const owners=new WeakSet<OutputBoundaryTimeline>();
/** Global motion marker namespace for independently scheduled peripherals.
 * Retirement uses a print-time watermark observed on EVERY participating MCU. */
export class BoundaryOutputRouter {
 #outputs:ReadonlyMap<string,OutputBoundaryTimeline>;#capacity:number;
 #entries=new Map<number,{output:OutputBoundaryTimeline;local:number}>();#next=1;#retired=0;#clock=0;
 #busy=false;#stop:Promise<void>|undefined;#fault:unknown;#notice=new StopNotice();#detach:(()=>void)[]=[];
 constructor(outputs:readonly {name:string;output:OutputBoundaryTimeline}[],capacity=1024){
  if(!outputs.length||outputs.length>128||new Set(outputs.map(o=>o.name)).size!==outputs.length||new Set(outputs.map(o=>o.output)).size!==outputs.length||!Number.isInteger(capacity)||capacity<1||capacity>65536)throw new Error('Invalid output router configuration');
  for(const o of outputs)if(!o.name||owners.has(o.output)||o.output.status.stopped||o.output.status.busy||o.output.status.pending)throw new Error('Invalid output router ownership');
  this.#outputs=new Map(outputs.map(o=>[o.name,o.output]));this.#capacity=capacity;
  for(const {output} of outputs){owners.add(output);this.#detach.push(output.subscribeStop(cause=>{void this.stop(cause).catch(()=>{});}));}
 }
 get status(){return {pending:this.#entries.size,busy:this.#busy,stopped:this.#stop!==undefined,fault:this.#fault};}
 get names(){return [...this.#outputs.keys()];}
 subscribeStop(listener:(cause:unknown)=>void){return this.#notice.subscribe(listener);}
 #active(){if(this.#stop)throw new Error('Output router stopped',{cause:this.#fault});if(this.#busy)throw new Error('Output router busy');}
 register(value:number,name='fan'):number{
  this.#active();const output=this.#outputs.get(name);if(!output)throw new Error('Unknown output route');
  if(this.#entries.size>=this.#capacity||!Number.isSafeInteger(this.#next))throw new RangeError('Output router capacity exceeded');
  const local=output.register(value),id=this.#next++;this.#entries.set(id,{output,local});return id;
 }
 async deliver(boundaries:readonly {id:number;time:number}[],horizon:number,signal:AbortSignal):Promise<void>{
  this.#active();signal.throwIfAborted();this.#busy=true;
  try{
   if(!Array.isArray(boundaries)||boundaries.length>65536)throw new RangeError('Invalid routed boundary batch');
   const batches=new Map([...this.#outputs.values()].map(o=>[o,[] as {id:number;time:number}[]])),seen=new Set<number>();
   for(const {id,time} of boundaries){
    if(!Number.isSafeInteger(id)||id<1||!Number.isFinite(time)||time<0||seen.has(id))throw new RangeError('Invalid routed boundary');seen.add(id);
    const entry=this.#entries.get(id);
    if(!entry){if(id<=this.#retired&&time<=this.#clock)continue;throw new Error('Unknown routed boundary');}
    batches.get(entry.output)!.push({id:entry.local,time});
   }
   await Promise.all([...batches].map(([output,markers])=>output.deliver(markers,horizon,signal)));
   signal.throwIfAborted();if(this.#stop)throw this.#fault;
  }catch(error){await this.#fail(error);}finally{this.#busy=false;}
 }
 async settleScheduled(signal:AbortSignal):Promise<number>{
  this.#active();signal.throwIfAborted();this.#busy=true;
  try{const horizons=await Promise.all([...this.#outputs.values()].map(o=>o.settleScheduled(signal)));signal.throwIfAborted();if(this.#stop)throw this.#fault;return Math.max(...horizons);}
  catch(error){return await this.#fail(error);}finally{this.#busy=false;}
 }
 retireThrough(time:number):void{
  this.#active();if(!Number.isFinite(time)||time<this.#clock)throw new RangeError('Invalid output router clock');
  for(const output of this.#outputs.values())output.retireThrough(time);
  this.#clock=time;
  for(const [id,entry] of this.#entries){if(entry.local>entry.output.status.retiredThrough)break;this.#entries.delete(id);this.#retired=id;}
 }
 invalidateAfter(time:number):void{this.#active();for(const output of this.#outputs.values())output.invalidateAfter(time);}
 async #fail(error:unknown):Promise<never>{try{await this.stop(error);}catch(stopError){throw new AggregateError([error,stopError],'Output router operation and stop failed');}throw error;}
 stop(cause:unknown=new Error('Output router stopped')):Promise<void>{
  if(this.#stop)return this.#stop;const done=Promise.withResolvers<void>();this.#stop=done.promise;this.#fault=cause;this.#entries.clear();
  for(const off of this.#detach)off();this.#detach=[];
  const jobs:Promise<void>[]=[];for(const output of this.#outputs.values())try{jobs.push(Promise.resolve(output.stop(cause)));}catch(error){jobs.push(Promise.reject(error));}
  void Promise.allSettled(jobs).then(results=>{const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)done.reject(new AggregateError(errors,'Output router stop failed'));else done.resolve();});
  this.#notice.emit(cause);return done.promise;
 }
}
