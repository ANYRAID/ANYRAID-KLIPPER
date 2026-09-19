import {NativeSerialQueue,serialClock} from './serial-queue.ts';
import {QueryConnection,type QueryOptions} from './queries.ts';
import {MessageDictionary} from './dictionary.ts';
import {downloadIdentify} from './identify.ts';
import {DictionaryClockTransport,type TimedResponse} from './clock-transport.ts';
import {ClockRuntime} from '../timing/clock-runtime.ts';
import type {ReleaseEstimate} from '../timing/clock-sync.ts';
export interface SerialSessionOptions {
 /** Independent device shutdown/watchdog path. The host queue is already closed
  * when called; successful completion must mean device safety has been handled. */
 stopDevice(cause:unknown):Promise<void>;
 onMessage?(response:TimedResponse):void;
}
interface Ack {deadline:number;resolve:()=>void;reject:(error:unknown)=>void;cleanup:()=>void}
/** Owns bootstrap, ACK dispatch and clock sampling on one preconfigured Linux
 * UART/stream fd. Does not open/configure termios or initialize MCU actuators. */
export class SerialSession {
 #queue:NativeSerialQueue;#queries:QueryConnection;#dictionary=new MessageDictionary();#clock:ClockRuntime|undefined;
 #options:SerialSessionOptions;#pending=new Map<bigint,Ack>();#continuation:ReturnType<typeof setImmediate>|undefined;
 #state:'new'|'identifying'|'warming'|'ready'|'closed'='new';#fault:unknown;#stopError:unknown;#stopPromise:Promise<void>|undefined;
 constructor(fd:number,options:SerialSessionOptions){
  if(typeof options.stopDevice!=='function')throw new TypeError('Device stop handler is required');
  this.#options={...options};this.#queue=new NativeSerialQueue(fd);
  this.#queries=new QueryConnection({send:(p,s)=>this.#send(p,s),setClockEstimate:e=>this.#estimate(e),stop:e=>this.stop(e)},serialClock);
  try{this.#queue.watch(()=>this.#pump(),error=>{void this.stop(error).catch(()=>{});});}catch(error){this.#queue.close();throw error;}
 }
 get status(){return {state:this.#state,pendingAcks:this.#pending.size,fault:this.#fault,stopError:this.#stopError};}
 get dictionary():MessageDictionary{if(this.#state!=='warming'&&this.#state!=='ready')throw new Error('Firmware dictionary is not ready');return this.#dictionary;}
 get clock():ClockRuntime{if(!this.#clock)throw new Error('Clock is not initialized');return this.#clock;}
 async initialize(signal:AbortSignal):Promise<void>{
  if(this.#state!=='new')throw new Error('Serial session cannot restart');this.#state='identifying';
  const abort=()=>{void this.stop(signal.reason??new Error('Serial initialization cancelled')).catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{
   signal.throwIfAborted();const dictionary=await downloadIdentify(async(payload,s)=>(await this.#queries.query(payload,'identify_response',s,{retries:5})).message,{signal});
   signal.throwIfAborted();this.#assertOpen();this.#dictionary=dictionary;
   const setting=(name:string)=>{if(!dictionary.hasConstant(name))return 0;const raw=dictionary.constant(name);if(typeof raw!=='number'&&typeof raw!=='string'||typeof raw==='string'&&!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim()))throw new Error(`Invalid firmware ${name}`);const value=Number(raw);if(!Number.isFinite(value)||value<=0)throw new Error(`Invalid firmware ${name}`);return value;};
   this.#queue.configure(setting('SERIAL_BAUD'),setting('RECEIVE_WINDOW'));this.#state='warming';
   const transport=new DictionaryClockTransport(dictionary,this.#queries);this.#clock=new ClockRuntime(transport.frequency,transport,serialClock);await this.#clock.start();signal.throwIfAborted();this.#assertOpen();this.#clock.assertActive();this.#state='ready';
  }catch(error){try{await this.stop(error);}catch{/* stop failure retained */}throw error;}
  finally{signal.removeEventListener('abort',abort);}
 }
 query(payload:Uint8Array,responseName:string,signal:AbortSignal,options:QueryOptions={}):Promise<TimedResponse>{
  if(this.#state!=='ready')return Promise.reject(new Error('Serial session is not ready'));
  try{this.clock.assertActive();}catch(error){return Promise.reject(error);}return this.#queries.query(payload,responseName,signal,options);
 }
 #assertOpen(){if(this.#state==='closed')throw new Error('Serial session is closed');}
 #estimate(e:ReleaseEstimate){this.#assertOpen();this.#queue.setClockEstimate(e);}
 #send(payload:Uint8Array,signal:AbortSignal):Promise<void>{
  signal.throwIfAborted();this.#assertOpen();if(this.#pending.size>=128)throw new Error('Too many outstanding serial acknowledgements');
  return new Promise((resolve,reject)=>{
   let timer:ReturnType<typeof setTimeout>|undefined;
   const abort=()=>{void this.stop(signal.reason??new Error('Serial send cancelled')).catch(()=>{});};
   try{const id=this.#queue.send(payload),deadline=serialClock.now()+5;
    const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
    this.#pending.set(id,{deadline,resolve,reject,cleanup});signal.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>{void this.stop(new Error('Serial acknowledgement timed out')).catch(()=>{});},5000);
   }catch(error){reject(error);void this.stop(error).catch(()=>{});}
  });
 }
 #pump(){
  if(this.#stopPromise)return;
  clearImmediate(this.#continuation);this.#continuation=undefined;
  let count=0;
  try{for(let i=0;i<256;i++){
   const event=this.#queue.pull();if(event===undefined)break;count++;if(event===null)throw new Error('Serial receive thread exited');
   if(event.notifyId){const ack=this.#pending.get(event.notifyId);if(!ack)throw new Error('Unknown serial acknowledgement');if(serialClock.now()>=ack.deadline)throw new Error('Serial acknowledgement deadline exceeded');this.#pending.delete(event.notifyId);ack.cleanup();ack.resolve();}
   else for(const message of this.#dictionary.parseFrame(event.data)){
    const response={message,sentTime:event.sentTime,receiveTime:event.receiveTime};
    if(!this.#queries.receive(response))this.#options.onMessage?.(response);
    if(this.#stopPromise)return;
   }
  }
  if(count===256)this.#continuation=setImmediate(()=>this.#pump());
  }catch(error){void this.stop(error).catch(()=>{});}
 }
 stop(cause:unknown=new Error('Serial session stopped')):Promise<void>{
  if(this.#stopPromise)return this.#stopPromise;
  this.#state='closed';this.#fault=cause;let cleanupError:unknown;
  this.#stopPromise=Promise.resolve().then(async()=>{try{await this.#options.stopDevice(cause);}catch(error){this.#stopError=error;throw new AggregateError([cause,cleanupError,error].filter(e=>e!==undefined),'Serial device stop failed');}if(cleanupError!==undefined){this.#stopError=cleanupError;throw cleanupError;}});
  clearImmediate(this.#continuation);this.#continuation=undefined;
  for(const p of this.#pending.values()){p.cleanup();p.reject(cause);}this.#pending.clear();
  try{this.#queue.close();}catch(error){cleanupError=error;}
  void this.#clock?.stop().catch(()=>{});void this.#queries.stop(cause).catch(()=>{});
  return this.#stopPromise;
 }
}
