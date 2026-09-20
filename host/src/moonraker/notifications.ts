import {encodeNotification,type Json} from './rpc.ts';
export interface NotificationLimits {pending?:number;perClient?:number;bytes?:number;timeoutMs?:number;}
export type DeliveryStatus='sent'|'denied'|'closed'|'overflow'|'failed';
export type DeliveryReport=Record<DeliveryStatus,number>;
export interface NotificationTarget {
 signal:AbortSignal;
 authorize(method:string,params:readonly Json[],signal:AbortSignal):void|Promise<void>;
 send(encoded:string):boolean;
 disconnect(reason:Error):void;
}
interface Task {method:string;params:readonly Json[];encoded:string;bytes:number;resolve?:(status:DeliveryStatus)=>void;done?:Promise<DeliveryStatus>;status?:DeliveryStatus;timer?:ReturnType<typeof setTimeout>;}
interface Client {id:number;target:NotificationTarget;queue:Task[];active?:Task;abort:()=>void;removed:boolean;controller:AbortController;}
function wait(task:Task):Promise<DeliveryStatus>{if(!task.done)task.done=task.status===undefined?new Promise<DeliveryStatus>(resolve=>task.resolve=resolve):Promise.resolve(task.status);return task.done;}
const report=():DeliveryReport=>({sent:0,denied:0,closed:0,overflow:0,failed:0});
function bounded(value:number|undefined,fallback:number,max:number):number{const n=value??fallback;if(!Number.isSafeInteger(n)||n<1||n>max)throw new Error('Invalid notification capacity or timeout');return n;}
function freeze(value:Json):void{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}}
/** Serial per-recipient authorization, parallel across recipients. Synchronous
 * authorization sends synchronously; unresolved async authorization remains
 * accounted for even after cancellation, until it actually settles. */
export class NotificationFanout {
 #clients=new Map<number,Client>();#tasks=new Set<Task>();#bytes=0;#closed=false;#totals=report();
 #pending:number;#perClient:number;#maximumBytes:number;#timeout:number;
 constructor(limits:NotificationLimits={}){this.#pending=bounded(limits.pending,256,100000);this.#perClient=bounded(limits.perClient,32,10000);this.#maximumBytes=bounded(limits.bytes,8*1024*1024,64*1024*1024);this.#timeout=bounded(limits.timeoutMs,10000,2147483647);}
 get status(){return {pending:this.#tasks.size,bytes:this.#bytes,clients:this.#clients.size,closed:this.#closed,totals:{...this.#totals}};}
 add(id:number,target:NotificationTarget):void{
  if(this.#closed||!Number.isSafeInteger(id)||id<1||this.#clients.has(id))throw new Error('Invalid notification client');if(target.signal.aborted)return;
  const client:Client={id,target,queue:[],abort:()=>this.remove(id),removed:false,controller:new AbortController()};this.#clients.set(id,client);target.signal.addEventListener('abort',client.abort,{once:true});
 }
 remove(id:number):void{const client=this.#clients.get(id);if(!client)return;this.#clients.delete(id);client.removed=true;client.target.signal.removeEventListener('abort',client.abort);client.controller.abort(new Error('Notification client disconnected'));clearTimeout(client.active?.timer);for(const task of client.queue.splice(0))this.#finish(client,task,'closed');}
 #disconnect(client:Client,reason:string):void{if(client.removed)return;this.remove(client.id);try{client.target.disconnect(new Error(reason));}catch{/* Transport is already removed; cleanup must not strand other recipients. */}}
 publish(method:string,params:readonly Json[],excluded:readonly number[]=[]):Promise<DeliveryReport>{
  return Promise.resolve(this.#publish(method,params,[...this.#clients.values()],false,excluded));
 }
 /** Target one connection without scanning or authorizing unrelated clients.
  * Shares the broadcast queue, ordering, cancellation and capacity accounting. */
 publishTo(id:number,method:string,params:readonly Json[]):Promise<DeliveryReport>{
  return Promise.resolve(this.dispatchTo(id,method,params));
 }
 /** Internal hot path: completed synchronous authorization has no Promise job. */
 dispatchTo(id:number,method:string,params:readonly Json[]):DeliveryReport|Promise<DeliveryReport>{
  if(!Number.isSafeInteger(id)||id<1)throw new Error('Invalid notification client');
  const client=this.#clients.get(id);return this.#publish(method,params,client?[client]:[],!client);
 }
 #publish(method:string,params:readonly Json[],clients:readonly Client[],missing=false,excluded:readonly number[]=[]):DeliveryReport|Promise<DeliveryReport>{
  if(this.#closed)return Promise.reject(new Error('Notification fanout is closed'));
  const encoded=encodeNotification(method,params),bytes=Buffer.byteLength(encoded);if(bytes>1024*1024)throw new Error('Notification exceeds message size limit');
  const payload:Json[]=JSON.parse(encoded).params??[];freeze(payload);const mask=excluded.length?new Set(excluded):undefined,pending:Promise<void>[]=[],result=report();if(missing){result.closed++;this.#totals.closed++;}
  // Snapshot iteration: authorization callbacks may remove/add connections.
  for(const client of clients){
   if(client.removed||mask?.has(client.id))continue;
   if(this.#tasks.size>=this.#pending||this.#bytes+bytes>this.#maximumBytes||client.queue.length+(client.active?1:0)>=this.#perClient){this.#totals.overflow++;result.overflow++;this.#disconnect(client,'Notification queue capacity exceeded');continue;}
   const task:Task={method,params:payload,encoded,bytes};
   this.#tasks.add(task);this.#bytes+=bytes;client.queue.push(task);this.#advance(client);if(task.status!==undefined)result[task.status]++;else pending.push(wait(task).then(status=>{result[status]++;}));
  }
  return pending.length?Promise.all(pending).then(()=>result):result;
 }
 #advance(client:Client):void{
  if(client.active||client.removed)return;
  while(!client.active&&!client.removed&&client.queue.length){
   const task=client.queue.shift()!;client.active=task;const signal=client.controller.signal;
   try{
    const authorized=client.target.authorize(task.method,task.params,signal);
    if(authorized&&typeof authorized.then==='function'){
     if(!client.removed)task.timer=setTimeout(()=>{client.controller.abort(new Error('Notification authorization timed out'));this.#disconnect(client,'Notification authorization timed out');},this.#timeout);
     Promise.resolve(authorized).then(()=>{this.#deliver(client,task);this.#advance(client);},()=>{this.#finish(client,task,client.removed||signal.aborted?'closed':'denied');this.#advance(client);});return;
    }
   }catch{this.#finish(client,task,client.removed||signal.aborted?'closed':'denied');continue;}
   this.#deliver(client,task);
  }
 }
 #deliver(client:Client,task:Task):void{
  if(client.removed||client.controller.signal.aborted){this.#finish(client,task,'closed');return;}
  try{if(client.target.send(task.encoded))this.#finish(client,task,'sent');else{this.#disconnect(client,'Notification transport closed');this.#finish(client,task,'closed');}}
  catch{this.#disconnect(client,'Notification transport failed');this.#finish(client,task,'failed');}
 }
 #finish(client:Client,task:Task,status:DeliveryStatus):void{if(!this.#tasks.delete(task))return;clearTimeout(task.timer);this.#bytes-=task.bytes;if(client.active===task)client.active=undefined;this.#totals[status]++;task.status=status;task.resolve?.(status);}
 close():Promise<void>{this.#closed=true;for(const id of [...this.#clients.keys()])this.remove(id);return Promise.all([...this.#tasks].map(task=>wait(task))).then(()=>{});}
}
