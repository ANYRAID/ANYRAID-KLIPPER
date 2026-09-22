import {cloneMotanJson,mergeMotanObjects,copyMotanStatusRoot,motanNumberToken} from './number-types.ts';
// GPL-3.0-or-later. Based on readlog.py, copyright (C) 2021 Kevin O'Connor.
import {encodeMotanJson} from './capture.ts';
import type {MotanMessage} from './log-reader.ts';
export type MotanObject=Readonly<Record<string,unknown>>;
export function motanObject(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Expected Motan object');return value as Record<string,unknown>;}
/** Ownership transfers to the consumer; nested JSON values become immutable. */
const immutable=new WeakSet<object>();
function freezeJson(value:unknown,depth=0,budget={nodes:0}):void{
 if(depth>64||++budget.nodes>1000000)throw new Error('Motan JSON structure limit exceeded');
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='bigint')return;
 if(typeof value==='number'&&Number.isFinite(value))return;
 if(!value||typeof value!=='object')throw new Error('Invalid Motan JSON value');
 if(depth===0&&immutable.has(value))return;
 if(!Array.isArray(value)){const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)throw new Error('Invalid Motan JSON object');}
 for(const child of Array.isArray(value)?value:Object.values(value))freezeJson(child,depth+1,budget);Object.freeze(value);if(depth<=1&&!Array.isArray(value))immutable.add(value);
}
interface Entry {value:MotanObject;bytes:number;}
interface Queue {entries:(Entry|undefined)[];at:number;}
export interface DispatchOptions {maxQueuedBytes?:number;maxQueuedMessages?:number;maxScanMessages?:number;timeHint?:'legacy'|'status';}
/** Reader ownership stays with the caller. Register every handler before pull.
 * A null result can mean time lookahead, not only EOF; inspect status. */
export class MotanDispatcher {
 readonly #reader:{pullMessage():Promise<MotanMessage|null>;pullReadyMessage?():MotanMessage|null|undefined;encodedSize?(message:MotanMessage):number|undefined};readonly #names=new Map<string,Queue>();readonly #subscriptions=new Map<string,Queue[]>();
 readonly #maxBytes:number;readonly #maxMessages:number;readonly #maxScan:number;readonly #hint:'legacy'|'status';
 #bytes=0;#messages=0;#started=false;#busy=false;#closed=false;#eof=false;#lastTime=0;#failure:Error|undefined;
 constructor(reader:{pullMessage():Promise<MotanMessage|null>;pullReadyMessage?():MotanMessage|null|undefined;encodedSize?(message:MotanMessage):number|undefined},options:DispatchOptions={}){
  this.#reader=reader;this.#maxBytes=options.maxQueuedBytes??32*1024**2;this.#maxMessages=options.maxQueuedMessages??65536;this.#maxScan=options.maxScanMessages??65536;this.#hint=options.timeHint??'legacy';
  for(const [value,max] of [[this.#maxBytes,256*1024**2],[this.#maxMessages,1000000],[this.#maxScan,1000000]])if(!Number.isSafeInteger(value)||value<1||value>max)throw new Error('Invalid Motan dispatch limits');if(!['legacy','status'].includes(this.#hint))throw new Error('Invalid Motan time hint');
 }
 get status(){return {queuedBytes:this.#bytes,queuedMessages:this.#messages,eof:this.#eof,endOfData:this.#eof&&this.#messages===0,closed:this.#closed,failed:!!this.#failure,lastReadTime:this.#lastTime};}
 #check(){if(this.#closed)throw new Error('Motan dispatcher is closed');if(this.#failure)throw this.#failure;}
 addHandler(name:string,subscription:string):void{
  this.#check();if(this.#started)throw new Error('Motan handlers must register before reading');if(typeof name!=='string'||!name.length||name.length>1024||typeof subscription!=='string'||!subscription.length||subscription.length>1024||this.#names.has(name)||this.#names.size>=128)throw new Error('Invalid or duplicate Motan handler');
  const queue:Queue={entries:[],at:0};this.#names.set(name,queue);const targets=this.#subscriptions.get(subscription)??[];targets.push(queue);this.#subscriptions.set(subscription,targets);
 }
 async pull(time:number,name:string):Promise<MotanObject|null>{
  this.#check();if(!Number.isFinite(time)||this.#busy||!this.#names.has(name))throw new Error('Invalid or concurrent Motan dispatch pull');this.#started=true;this.#busy=true;const queue=this.#names.get(name)!;
  try{let scanned=0;for(;;){this.#check();if(queue.at<queue.entries.length){const entry=queue.entries[queue.at]!;queue.entries[queue.at++]=undefined;this.#bytes-=entry.bytes;this.#messages--;if(queue.at===queue.entries.length){queue.entries.length=0;queue.at=0;}else if(queue.at>1024&&queue.at*2>queue.entries.length){queue.entries=queue.entries.slice(queue.at);queue.at=0;}return entry.value;}
    if(this.#eof||time+1<this.#lastTime)return null;if(++scanned>this.#maxScan)throw new Error('Motan dispatch scan limit exceeded');const ready=this.#reader.pullReadyMessage?.(),message=ready===undefined?await this.#reader.pullMessage():ready;this.#check();if(message===null){this.#eof=true;return null;}
    if(message.q==='status'){const root=this.#hint==='status'?motanObject(motanObject(message.params).status??{}):message;const toolhead=root.toolhead;if(toolhead!==undefined){const pt=motanObject(toolhead).estimated_print_time;if(pt!==undefined){if(typeof pt!=='number'||!Number.isFinite(pt))throw new Error('Invalid Motan status time');this.#lastTime=pt;}}}
    const targets=typeof message.q==='string'?this.#subscriptions.get(message.q):undefined;if(!targets)continue;const value=motanObject(message.params);freezeJson(value);const measured=this.#reader.encodedSize?.(message),bytes=measured??Buffer.byteLength(encodeMotanJson(value));if(!Number.isSafeInteger(bytes)||bytes<1)throw new Error('Invalid Motan encoded size');if(this.#bytes+bytes*targets.length>this.#maxBytes||this.#messages+targets.length>this.#maxMessages)throw new Error('Motan dispatch queue limit exceeded');
    const entry={value,bytes};for(const target of targets)target.entries.push(entry);this.#bytes+=bytes*targets.length;this.#messages+=targets.length;
   }
  }catch(error){this.#failure=error instanceof Error?error:new Error(String(error));this.#clear();throw this.#failure;}finally{this.#busy=false;}
 }
 #clear(){for(const queue of this.#names.values()){queue.entries=[];queue.at=0;}this.#bytes=0;this.#messages=0;}
 close():void{this.#closed=true;this.#clear();}
}
export interface StatusSnapshot {status:MotanObject;nextTime:number;}
/** Copy-on-write status snapshots remain stable after subsequent updates. */
export class MotanStatusTracker {
 readonly #source:(time:number)=>Promise<MotanObject|null>;readonly #maxStatusBytes:number;readonly #fieldSizes=new Map<string,Map<string,{prefix:number;bytes:number}>>();#bytes=2;#status:MotanObject;#update:MotanObject={};#nextTime=0;#last=-Infinity;#busy=false;#failure:Error|undefined;
 constructor(initial:MotanObject,source:(time:number)=>Promise<MotanObject|null>,maxStatusBytes=4*1024**2){if(!Number.isSafeInteger(maxStatusBytes)||maxStatusBytes<1||maxStatusBytes>64*1024**2)throw new Error('Invalid Motan status size limit');this.#maxStatusBytes=maxStatusBytes;const copy=cloneMotanJson(motanObject(initial));this.#validate(copy);freezeJson(copy);for(const [key,value] of Object.entries(copy))this.#account(key,motanObject(value));this.#bound();this.#status=copy;this.#source=source;}
 #bound(){if(this.#bytes>this.#maxStatusBytes)throw new Error('Motan status size limit exceeded');}
 #account(key:string,update:MotanObject):void{
  let fields=this.#fieldSizes.get(key);if(!fields){this.#bytes+=Buffer.byteLength(JSON.stringify(key))+3+(this.#fieldSizes.size?1:0);fields=new Map();this.#fieldSizes.set(key,fields);}
  for(const [field,value] of Object.entries(update)){let bytes:number;if(typeof value==='number')bytes=motanNumberToken(update as Record<string,unknown>,field,value)?.length??(Object.is(value,-0)?4:String(value).length);else if(typeof value==='bigint')bytes=String(value).length;else if(value===null)bytes=4;else if(typeof value==='boolean')bytes=value?4:5;else bytes=encodeMotanJson(value).length;
   const previous=fields.get(field),prefix=previous?.prefix??Buffer.byteLength(JSON.stringify(field))+1,next=prefix+bytes;this.#bytes+=next-(previous?.bytes??0)+(previous===undefined&&fields.size?1:0);if(previous)previous.bytes=next;else fields.set(field,{prefix,bytes:next});
  }
 }
 #validate(status:MotanObject){for(const value of Object.values(status))motanObject(value);}
 async sample(time:number):Promise<StatusSnapshot>{
  if(this.#failure)throw this.#failure;if(!Number.isFinite(time)||time<this.#last||this.#busy)throw new Error('Motan status samples require sequential nondecreasing times');this.#busy=true;this.#last=time;
  try{let reads=0;while(time>=this.#nextTime){if(Object.keys(this.#update).length){const next=copyMotanStatusRoot(this.#status,this.#update);for(const [key,value] of Object.entries(this.#update)){const update=motanObject(value),previous=Object.hasOwn(this.#status,key)?motanObject(this.#status[key]):{};Object.defineProperty(next,key,{value:Object.freeze(mergeMotanObjects(previous,update)),enumerable:true,configurable:true,writable:true});this.#account(key,update);}this.#bound();this.#status=Object.freeze(next);}
    if(++reads>4096)throw new Error('Motan status update limit exceeded');const message=await this.#source(time);if(message===null){this.#nextTime=time+.1;if(!(this.#nextTime>time))throw new Error('Motan time cannot represent EOF lookahead');this.#update={};break;}
    const update=motanObject(message.status);this.#validate(update);freezeJson(update);const nextTime=motanObject(update.toolhead??{}).estimated_print_time??0;if(typeof nextTime!=='number'||!Number.isFinite(nextTime))throw new Error('Invalid Motan status time');this.#update=update;this.#nextTime=nextTime;
   }return {status:this.#status,nextTime:this.#nextTime};
  }catch(error){this.#failure=error instanceof Error?error:new Error(String(error));throw this.#failure;}finally{this.#busy=false;}
 }
}
