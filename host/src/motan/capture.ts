import {parseTypedMotanJson,assignMotanObject,motanNumberToken,MotanNumberMetadataError,hasMotanObjectOrder,motanObjectKeys,mergeMotanKeyOrder} from './number-types.ts';
import {parseRequestJson,JsonNumberError} from '../moonraker/json.ts';
// GPL-3.0-or-later. Native Motan capture state machine, based on data_logger.py.
import {MotanLogWriter} from './log-writer.ts';
import {motanSubscriptions,type MotanSubscription} from './subscriptions.ts';
type ObjectValue=Record<string,unknown>;
const object=(value:unknown):ObjectValue=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Expected Motan JSON object');return value as ObjectValue;};
const rawJson=(JSON as unknown as {rawJSON:(text:string)=>unknown}).rawJSON;
const decoder=new TextDecoder('utf-8',{fatal:true});
function statusRecord(value:unknown):boolean{return value!==null&&typeof value==='object'&&!Array.isArray(value)&&((value as ObjectValue).q==='status'||Object.hasOwn(value,'status')||((value as ObjectValue).id==='status'&&typeof (value as ObjectValue).result==='object'&&(value as ObjectValue).result!==null&&Object.hasOwn((value as ObjectValue).result as object,'status')));}
export function parseMotanJson(data:Uint8Array,preserveNumberTypes=false):unknown{
 const text=decoder.decode(data);let result:unknown;
 try{result=parseRequestJson(text);}catch(error){
  if(!(error instanceof JsonNumberError))throw error;
  result=JSON.parse(text,(_key,value,context?:{source?:string})=>{
   if(typeof value!=='number')return value;
   if(context?.source&&/^-?\d+$/.test(context.source)&&!Number.isSafeInteger(value)&&(preserveNumberTypes||Number.isFinite(value))){
    if(preserveNumberTypes&&context.source.length-(context.source[0]==='-'?1:0)>4300)throw new MotanNumberMetadataError('Motan integer digit limit');
    return BigInt(context.source);
   }
   if(!Number.isFinite(value))throw new Error('Non-finite Motan number');return value;
  });
 }
 // The opt-in reader profile types status columns, not interpolated sensor
 // arrays. Avoid a reviver and metadata on unrelated high-volume records.
 return preserveNumberTypes&&statusRecord(result)?parseTypedMotanJson(text):result;
}

export function encodeMotanJson(value:unknown):Buffer{
 let proxies:WeakMap<object,object>|undefined,owners:WeakMap<object,Record<string,unknown>>|undefined;
 return Buffer.from(JSON.stringify(value,function(this:Record<string,unknown>,key:string,v:unknown){
 if(typeof v==='bigint')return rawJson(String(v));
 if(typeof v==='number'){const token=motanNumberToken(owners?.get(this)??this,key,v);if(token!==undefined)return rawJson(token);if(Object.is(v,-0))return rawJson('-0.0');}
 if(v!==null&&typeof v==='object'&&hasMotanObjectOrder(v)){
  proxies??=new WeakMap();owners??=new WeakMap();let proxy=proxies.get(v);if(!proxy){
   proxy=new Proxy(v,{ownKeys(target){const keys=motanObjectKeys(target),seen=new Set<PropertyKey>(keys);return [...keys,...Reflect.ownKeys(target).filter(k=>!seen.has(k))];}});
   proxies.set(v,proxy);owners.set(proxy,v as Record<string,unknown>);
  }return proxy;
 }
 return v;
 }));
}
export interface MotanWriters {log:Pick<MotanLogWriter,'addRecords'|'flush'>&Partial<Pick<MotanLogWriter,'addRecordsAndFlush'>>;index:Pick<MotanLogWriter,'addRecords'>;}
/** One sequential accept caller. Flushes pending raw frames before publishing
 * each original index boundary, then batches remaining frames from the chunk. */
export class MotanCapture {
 readonly #writers:MotanWriters;readonly #send:(message:ObjectValue)=>Promise<void>;readonly #patterns:readonly string[];readonly #output:(text:string)=>void;
 readonly #pending=new Map<string,'info'|'list'|'status'|'dump'>();#status:ObjectValue=Object.create(null);#subscriptions:ObjectValue|undefined;#nextIndex=0;#initialized=false;#ended=false;#busy=false;
 #toSubscribe:MotanSubscription[]=[];#indexRecords:Buffer[]=[];#indexBytes=0;
 #records:Buffer[]=[];#recordBytes=0;#frames=0;#indexes=0;
 constructor(writers:MotanWriters,send:(message:ObjectValue)=>Promise<void>,patterns:readonly string[],output:(text:string)=>void){this.#writers=writers;this.#send=send;this.#patterns=[...patterns];this.#output=output;}
 get status(){return {frames:this.#frames,indexes:this.#indexes,pendingRequests:this.#pending.size,ended:this.#ended};}
 async start():Promise<void>{if(this.#initialized)throw new Error('Motan capture already started');this.#initialized=true;await this.#query('info','info',{client_info:{program:'motan_data_logger',version:'v0.1'}},'info');}
 async #query(id:string,method:string,params:ObjectValue,handler:'info'|'list'|'status'|'dump'):Promise<void>{if(this.#pending.size>=4096||this.#pending.has(id))throw new Error('Motan request capacity or duplicate ID');this.#pending.set(id,handler);await this.#send({id,method,params});}
 async #pumpSubscriptions():Promise<void>{while(this.#toSubscribe.length&&this.#pending.size<16){const sub=this.#toSubscribe.shift()!;await this.#query(sub.name,sub.method,{...sub.params,response_template:{q:sub.name}},'dump');}}
 async #drain():Promise<void>{if(this.#records.length){await this.#writers.log.addRecords(this.#records);this.#records=[];this.#recordBytes=0;}}
 async #drainIndexes():Promise<void>{if(this.#indexRecords.length){await this.#writers.index.addRecords(this.#indexRecords);this.#indexRecords=[];this.#indexBytes=0;}}
 async #index():Promise<void>{let position:number;if(this.#records.length&&this.#writers.log.addRecordsAndFlush){position=await this.#writers.log.addRecordsAndFlush(this.#records);this.#records=[];this.#recordBytes=0;}else{await this.#drain();position=await this.#writers.log.flush();}const db={status:this.#status,...this.#subscriptions?{subscriptions:this.#subscriptions}:{},file_position:position},encoded=encodeMotanJson(db);if(encoded.length>1024*1024)throw new Error('Motan index snapshot limit exceeded');if(this.#indexBytes+encoded.length+1>1024*1024||this.#indexRecords.length>=256)await this.#drainIndexes();this.#indexRecords.push(encoded);this.#indexBytes+=encoded.length+1;this.#status=Object.create(null);this.#subscriptions=undefined;this.#indexes++;}
 #merge(update:ObjectValue):void{mergeMotanKeyOrder(this.#status,update);for(const [key,value] of Object.entries(update)){const current=Object.hasOwn(this.#status,key)?object(this.#status[key]):Object.create(null);assignMotanObject(current,object(value));this.#status[key]=current;}if(encodeMotanJson(this.#status).length>1024*1024)throw new Error('Motan status snapshot limit exceeded');}
 async accept(frames:readonly Buffer[]):Promise<void>{
  if(!this.#initialized||this.#busy||this.#ended)throw new Error('Invalid Motan capture state');this.#busy=true;
  try{for(const raw of frames){if(raw.length>1024*1024)throw new Error('Motan frame limit exceeded');let message:ObjectValue;try{message=object(parseMotanJson(raw,true));}catch(error){if(error instanceof MotanNumberMetadataError||error instanceof RangeError)throw error;this.#output('ERROR: Unable to parse line\n');continue;}
   if(this.#recordBytes+raw.length+1>4*1024**2||this.#records.length>=256)await this.#drain();this.#records.push(raw);this.#recordBytes+=raw.length+1;this.#frames++;
   if(message.q!==undefined&&message.q!==null){if(message.q==='status'){const params=object(message.params),time=params.eventtime;if(typeof time!=='number'||!Number.isFinite(time))throw new Error('Invalid Motan event time');this.#merge(object(params.status??{}));if(time>=this.#nextIndex){this.#nextIndex=time+5;await this.#index();}}continue;}
   const id=message.id,handler=typeof id==='string'?this.#pending.get(id):undefined;if(!handler){this.#output('ERROR: Message with unknown id\n');continue;}this.#pending.delete(id as string);
   if(handler==='info'){if(object(message.result).state!=='ready'){this.#ended=true;this.#output('Klipper not in ready state\n');break;}await this.#query('list','objects/list',{},'list');}
   else if(handler==='list'){const names=object(message.result).objects;if(!Array.isArray(names)||names.length>4096||names.some(n=>typeof n!=='string'||n.length>1024))throw new Error('Invalid Motan object list');await this.#query('status','objects/subscribe',{objects:Object.fromEntries(names.map(n=>[n,null])),response_template:{q:'status'}},'status');}
   else if(handler==='status'){const result=object(message.result),time=result.eventtime;if(typeof time!=='number'||!Number.isFinite(time))throw new Error('Invalid Motan initial event time');this.#nextIndex=time+5;this.#status=Object.create(null);this.#merge(object(result.status));const subscriptions=motanSubscriptions(this.#status,this.#patterns);this.#output('Available subscriptions:\n  '+subscriptions.available.join('\n  ')+'\nSubscribing to:\n  '+subscriptions.selected.map(v=>v.name).join('\n  ')+'\n');this.#toSubscribe=subscriptions.selected;await this.#pumpSubscriptions();this.#output('Starting capture...\n');}
   else if(message.result===undefined)this.#output(`Unable to subscribe to '${String(id)}': ${String(object(message.error??{}).message??'')}\n`);
   else{this.#subscriptions??=Object.create(null);this.#subscriptions![id as string]=message.result;}
   await this.#pumpSubscriptions();if(!this.#pending.size&&!this.#toSubscribe.length)await this.#index();
  }await this.#drain();await this.#drainIndexes();}catch(error){this.#ended=true;try{await this.#drain();await this.#drainIndexes();}catch(writeError){throw new AggregateError([error,writeError],'Motan capture and log drain failed');}throw error;}finally{this.#busy=false;}
 }
}
