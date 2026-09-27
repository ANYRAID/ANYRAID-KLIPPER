import {trsyncFormats,type TriggerSyncProtocol,type TriggerPlan} from '../inputs/trsync.ts';
import {firmwareFault,FirmwareFault} from './firmware-fault.ts';
import {MotionRetiredError} from '../motion/retired.ts';
import {configureMCU,type MCUConfigPlan,type ConfiguredMCU} from './mcu-config.ts';
import type {ScheduledPacket} from '../motion/move-queue.ts';
import type {ScheduledTransport,MCUQueueConfig} from '../motion/move-queue-sink.ts';
import {NativeSerialQueue,serialClock} from './serial-queue.ts';
import {QueryConnection,type QueryOptions} from './queries.ts';
import {MessageDictionary} from './dictionary.ts';
import {downloadIdentify} from './identify.ts';
import {DictionaryClockTransport,type TimedResponse} from './clock-transport.ts';
import {ClockRuntime} from '../timing/clock-runtime.ts';
import type {ReleaseEstimate} from '../timing/clock-sync.ts';
export interface SerialSessionOptions {
 /** Already-bound Classical CAN socket; ID = 256 + 2 * node ID. */
 canClientId?:number;
 /** Independent device shutdown/watchdog path. The host queue is already closed
  * when called; successful completion must mean device safety has been handled. */
 stopDevice(cause:unknown):Promise<void>;
 onMessage?(response:TimedResponse):void;
}
export interface ResponseSubscription {
 receive(response:TimedResponse):void;
 /** Synchronous lifecycle notification; the native queue is already closed.
  * Must not wait for or initiate asynchronous cleanup here. */
 closed(cause:unknown):void;
}
export interface TimedCommandQueue {
 send(payload:Uint8Array,minClock:bigint,reqClock:bigint,signal:AbortSignal):Promise<void>;
 stop(cause:unknown):Promise<void>;
}
interface ControlAck {motion?:false;deadline:number;resolve:()=>void;reject:(error:unknown)=>void;cleanup:()=>void}
export interface RetirableMotionTransport extends ScheduledTransport {
 /** Permanently fence this transport, discard its not-yet-accepted tail, then
  * await firmware delivery of already accepted commands. Owner must establish
  * an MCU stop/reset-required boundary and await BOTH it and this retirement
  * before resetting or sending replacement motion. Accepted commands may execute
  * until stopped. Success permits binding a replacement transport. */
 retire(signal:AbortSignal):Promise<void>;
}
interface MotionLease {retired:boolean;pending:Promise<void>|undefined;retirement:Promise<void>|undefined}
type Ack=ControlAck|{motion:true;deadline:number};
interface AckWait {boundary:bigint;remaining:number;resolve:()=>void;reject:(error:unknown)=>void;cleanup:()=>void}
/** Owns bootstrap, ACK dispatch and clock sampling on one preconfigured Linux
 * UART/stream fd. Does not open/configure termios or initialize MCU actuators. */
export class SerialSession {
 #queue:NativeSerialQueue;#queries:QueryConnection;#dictionary=new MessageDictionary();#clock:ClockRuntime|undefined;
 #options:SerialSessionOptions;#pending=new Map<bigint,Ack>();#continuation:ReturnType<typeof setImmediate>|undefined;
 #lastAccepted=0n;#ackWaits=new Set<AckWait>();
 #motionTimer:ReturnType<typeof setTimeout>|undefined;#motionExpiry=Infinity;#motionPending=0;
 #configuration:ConfiguredMCU|undefined;#configuring=false;
 #resetting=false;#motionBound=false;#motionBusy=false;#queryPending=0;#space=new Set<()=>void>();
 #commandQueueIds=new WeakMap<TimedCommandQueue,number>();
 #nextCommandQueue=2;#outputPending=0;
 #closeObservers=new Set<(cause:unknown)=>void>();
 #subscriptions=new Map<string,Map<number,ResponseSubscription>>();#subscriptionCount=0;
 #state:'new'|'identifying'|'warming'|'ready'|'closed'='new';#fault:unknown;#stopError:unknown;#stopPromise:Promise<void>|undefined;
 constructor(fd:number,options:SerialSessionOptions){
  if(typeof options.stopDevice!=='function')throw new TypeError('Device stop handler is required');
  this.#options={...options};this.#queue=new NativeSerialQueue(fd,options.canClientId);
  this.#queries=new QueryConnection({send:(p,s)=>this.#send(p,s),setClockEstimate:e=>this.#estimate(e),stop:e=>this.stop(e)},serialClock);
  try{this.#queue.watch(()=>this.#pump(),error=>{void this.stop(error).catch(()=>{});});}catch(error){this.#queue.close();throw error;}
 }
 get status(){return {state:this.#state,pendingAcks:this.#pending.size,configured:!!this.#configuration,fault:this.#fault,stopError:this.#stopError};}
 get dictionary():MessageDictionary{if(this.#state!=='warming'&&this.#state!=='ready')throw new Error('Firmware dictionary is not ready');return this.#dictionary;}
 get clock():ClockRuntime{if(!this.#clock)throw new Error('Clock is not initialized');return this.#clock;}
 /** Health check without allocating a status snapshot. */
 assertActive():void{if(this.#state!=='ready'||this.#resetting)throw new Error('MCU session is not ready',{cause:this.#fault});this.clock.assertActive();}
 /** Register before MCU configuration so init reports cannot race registration.
  * Each name/OID has one consumer; subscribed responses cannot be queried. */
 subscribeResponse(format:string,oid:number,handler:ResponseSubscription):()=>void{
  this.assertActive();if(!Number.isInteger(oid)||oid<0||oid>254||typeof handler.receive!=='function'||typeof handler.closed!=='function')throw new Error('Invalid response subscription');
  const {name}=this.#dictionary.lookup(format);
  if(['clock','uptime','identify_response','shutdown','is_shutdown','starting'].includes(name)||!format.includes(' oid=%c')||this.#queries.hasPending(name,oid)||this.#configuring)throw new Error('Response subscription requires an idle route');
  const routes=this.#subscriptions.get(name);if(routes?.has(oid)||this.#subscriptionCount>=512)throw new Error('Response subscription duplicate or capacity exceeded');
  const owned={receive:handler.receive.bind(handler),closed:handler.closed.bind(handler)},map=routes??new Map<number,ResponseSubscription>();if(!routes)this.#subscriptions.set(name,map);map.set(oid,owned);this.#subscriptionCount++;
  return ()=>{if(this.#subscriptions.get(name)!==map||map.get(oid)!==owned)return;map.delete(oid);this.#subscriptionCount--;if(!map.size)this.#subscriptions.delete(name);};
 }
 /** Observe session closure without occupying a response OID. Unsubscribe
  * when the owning operation ends; callbacks run after native queue closure. */
 observeClose(handler:(cause:unknown)=>void):()=>void{
  this.assertActive();if(typeof handler!=='function'||this.#closeObservers.size>=128)throw new Error('Invalid serial close observer');
  const owned=(cause:unknown)=>handler(cause);this.#closeObservers.add(owned);return ()=>{this.#closeObservers.delete(owned);};
 }
 /** Wait for ACKs of messages accepted before this call. Later sends do not
  * extend the snapshot. This is delivery, not MCU execution or physical stop.
  * Aborting cancels only this observation, not already accepted commands. */
 waitForAcknowledgements(signal:AbortSignal):Promise<void>{
  try{signal.throwIfAborted();this.#assertOpen();if(!this.#pending.size)return Promise.resolve();if(this.#ackWaits.size>=128)throw new Error('Too many acknowledgement waits');}catch(error){return Promise.reject(error);}
  return new Promise((resolve,reject)=>{
   const abort=()=>{wait.cleanup();reject(signal.reason??new Error('Acknowledgement wait cancelled'));};
   const wait:AckWait={boundary:this.#lastAccepted,remaining:this.#pending.size,resolve,reject,cleanup:()=>{this.#ackWaits.delete(wait);signal.removeEventListener('abort',abort);}};
   this.#ackWaits.add(wait);signal.addEventListener('abort',abort,{once:true});
  });
 }
 async initialize(signal:AbortSignal):Promise<void>{
  if(this.#state!=='new')throw new Error('Serial session cannot restart');this.#state='identifying';
  const abort=()=>{void this.stop(signal.reason??new Error('Serial initialization cancelled')).catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{
   signal.throwIfAborted();const dictionary=await downloadIdentify(async(payload,s)=>(await this.#queries.query(payload,'identify_response',s,{retries:5})).message,{signal});
   signal.throwIfAborted();this.#assertOpen();this.#dictionary=dictionary;
   const setting=(name:string)=>{if(!dictionary.hasConstant(name))return 0;const raw=dictionary.constant(name);if(typeof raw!=='number'&&typeof raw!=='string'||typeof raw==='string'&&!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim()))throw new Error(`Invalid firmware ${name}`);const value=Number(raw);if(!Number.isFinite(value)||value<=0)throw new Error(`Invalid firmware ${name}`);return value;};
   this.#queue.configure(setting(this.#options.canClientId===undefined?'SERIAL_BAUD':'CANBUS_FREQUENCY'),setting('RECEIVE_WINDOW'));this.#state='warming';
   const transport=new DictionaryClockTransport(dictionary,this.#queries);this.#clock=new ClockRuntime(transport.frequency,transport,serialClock);await this.#clock.start();signal.throwIfAborted();this.#assertOpen();this.#clock.assertActive();this.#state='ready';
  }catch(error){try{await this.stop(error);}catch{/* stop failure retained */}throw error;}
  finally{signal.removeEventListener('abort',abort);}
 }
 query(payload:Uint8Array,responseName:string,signal:AbortSignal,options:QueryOptions={}):Promise<TimedResponse>{
  if(this.#state!=='ready'||this.#resetting||this.#configuring)return Promise.reject(new Error('Serial session is not ready'));
  if(options.oid!==undefined&&this.#subscriptions.get(responseName)?.has(options.oid))return Promise.reject(new Error('Response route is subscribed'));
  try{this.clock.assertActive();}catch(error){return Promise.reject(error);}return this.#queries.query(payload,responseName,signal,options);
 }
 get configuration():ConfiguredMCU{if(!this.#configuration)throw new Error('MCU is not configured');return this.#configuration;}
 /** Independent FIFO for scheduled peripheral commands. Motion uses queue 1;
  * peripherals use 2..127 and at most 64 reserved control ACK slots in total. */
 commandQueue():TimedCommandQueue{
  this.assertActive();if(!this.#configuration||this.#nextCommandQueue>=128)throw new Error('Configured MCU and an available command queue are required');
  const queue=this.#nextCommandQueue++;
  const result:TimedCommandQueue={send:(payload,min,req,signal)=>{
   try{this.assertActive();if(this.#configuring||this.#outputPending>=64)throw new Error('Scheduled command capacity exceeded');if(typeof min!=='bigint'||typeof req!=='bigint'||min<0n||req<min||req>=0x7fffffffffffffffn)throw new RangeError('Invalid scheduled command clocks');
    const now=serialClock.now(),release=req>min+(3n<<29n)?req-(3n<<29n):min;
    const ready=release===0n?now:this.clock.sync.systemTime(release),requested=req===0n?now:this.clock.sync.systemTime(req);
    if(!Number.isFinite(ready)||!Number.isFinite(requested)||Math.max(ready,requested)>now+60)throw new RangeError('Scheduled command exceeds 60 second horizon');
    return this.#send(payload,signal,{queue,min,req,deadline:Math.max(now,ready,requested)+5});
   }catch(error){return Promise.reject(error);}
  },stop:cause=>this.stop(cause)};
  this.#commandQueueIds.set(result,queue);return Object.freeze(result);
 }
 assertCommandQueue(queue:TimedCommandQueue):void{this.assertActive();if(!this.#configuration||!this.#commandQueueIds.has(queue))throw new Error('Configured owned command queue required');}
 /** Query on an owned peripheral FIFO. Route ownership, ACK/response freshness,
  * timeout and cancellation use the same shared query manager as normal queries. */
 queryOnQueue(queue:TimedCommandQueue,payload:Uint8Array,responseName:string,signal:AbortSignal,options:QueryOptions&{minClock?:bigint;reqClock?:bigint}={}):Promise<TimedResponse>{
  if(!this.#commandQueueIds.has(queue))return Promise.reject(new Error('Command queue belongs to another session'));
  if(this.#state!=='ready'||this.#resetting||this.#configuring)return Promise.reject(new Error('Serial session is not ready'));
  if(options.oid!==undefined&&this.#subscriptions.get(responseName)?.has(options.oid))return Promise.reject(new Error('Response route is subscribed'));
  try{this.clock.assertActive();}catch(error){return Promise.reject(error);}
  const min=options.minClock??0n,req=options.reqClock??min;
  return this.#queries.query(payload,responseName,signal,options,(p,s)=>queue.send(p,min,req,s));
 }
 /** Native group creation does not arm firmware. Send each start plan on its
  * supplied FIFO, then start the group before enabling endstop sampling. */
 static createTriggerDispatch(members:readonly {session:SerialSession;queue:TimedCommandQueue;protocol:TriggerSyncProtocol;plan:TriggerPlan}[]){
  if(!Array.isArray(members)||!members.length||members.length>16)throw new RangeError('Invalid trigger sessions');
  return NativeSerialQueue.createTriggerDispatch(members.map(({session,queue,protocol,plan})=>{
   session.assertActive();const commandQueue=session.#commandQueueIds.get(queue);
   if(!session.#configuration||commandQueue===undefined)throw new Error('Trigger dispatch requires an owned configured command queue');
   for(const name of ['timeout','trigger','state'] as const)if((session.#dictionary.lookup(trsyncFormats[name]).id>>>0)!==protocol.tags[name])throw new Error('Trigger dictionary does not match session');
   return {queue:session.#queue,commandQueue,oid:protocol.oid,tags:protocol.tags,plan};
  }));
 }
 async configure(plan:MCUConfigPlan,signal:AbortSignal):Promise<ConfiguredMCU>{
  if(this.#state!=='ready'||this.#resetting||this.#configuring||this.#configuration||this.#motionBound)throw new Error('MCU configuration requires an unconfigured ready session');
  this.#configuring=true;
  try{this.clock.assertActive();const result=await configureMCU(this.#dictionary,{query:(p,n,s)=>this.#queries.query(p,n,s,{retries:5}),send:(p,s)=>this.#send(p,s),stop:e=>this.stop(e)},plan,signal);this.#assertOpen();this.clock.assertActive();this.#configuration=result;return result;}
  catch(error){try{await this.stop(error);}catch{/* failure retained */}throw error;}
  finally{this.#configuring=false;}
 }
 /** Explicit offline maintenance only. The owner must exclude other host users
  * and have closed all peripherals. ACK means delivery, not successful reboot;
  * the caller must reconnect and verify firmware. Never reuses this session. */
 async resetOffline(signal:AbortSignal):Promise<{acknowledged:boolean;restartObserved:boolean}>{
  signal.throwIfAborted();this.assertActive();
  if(this.#motionBound||this.#configuring||this.#subscriptionCount||this.#outputPending)throw new Error('Offline reset requires an idle session without motion or subscriptions');
  this.#dictionary.lookup('reset');const payload=this.#dictionary.encode('reset',{});this.#resetting=true;
  let sent=false,result={acknowledged:false,restartObserved:false},failure:unknown;
  try{await this.waitForAcknowledgements(signal);sent=true;await this.#send(payload,signal);signal.throwIfAborted();result.acknowledged=true;}
  catch(error){if(sent&&!signal.aborted&&error instanceof FirmwareFault&&error.details.event==='starting')result.restartObserved=true;else failure=signal.aborted?signal.reason:error;}
  try{await this.stop(new Error('Offline firmware reset requested'));}catch(error){failure=failure===undefined?error:new AggregateError([failure,error],'Offline reset and cleanup failed');}
  if(failure!==undefined)throw failure;return result;
 }
 /** Build the move-slot sink binding using firmware-confirmed capacity. */
 motionQueue(id:string,emitterIds:readonly string[],clockAt:(printTime:number)=>bigint):MCUQueueConfig{
  if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)||typeof clockAt!=='function')throw new Error('Invalid MCU motion queue binding');
  return {id,emitters:[...emitterIds],moveSlots:this.configuration.moveSlots,clockAt,transport:this.motionTransport(emitterIds)};
 }
 /** One ordered motion queue per MCU, matching steppersync's single cq.
  * Resolve after native acceptance; firmware ACKs remain tracked in background. */
 motionTransport(emitterIds:readonly string[]):RetirableMotionTransport{
  if(this.#state!=='ready'||this.#resetting||this.#motionBound||!this.#configuration||this.#configuration.moveSlots<1)throw new Error('Motion transport requires an unbound ready session with configured move slots');
  if(!emitterIds.length||emitterIds.length>128||new Set(emitterIds).size!==emitterIds.length||emitterIds.some(id=>!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)))throw new Error('Invalid motion emitter binding');
  this.#motionBound=true;const ids=new Set(emitterIds),lease:MotionLease={retired:false,pending:undefined,retirement:undefined};
  return Object.freeze({send:(packets:readonly ScheduledPacket[])=>{
   if(lease.retired)return Promise.reject(new MotionRetiredError());
   if(lease.pending)return Promise.reject(new Error('Motion send already in progress'));
   const sent=this.#motion(packets,ids,lease);lease.pending=sent;
   void sent.then(()=>{lease.pending=undefined;},()=>{lease.pending=undefined;});return sent;
  },stop:(cause:unknown)=>this.stop(cause),retire:(signal:AbortSignal)=>{
   if(lease.retirement)return lease.retirement;
   lease.retired=true;for(const wake of this.#space)wake();this.#space.clear();
   lease.retirement=this.#retireMotion(lease,signal);return lease.retirement;
  }});
 }
 async #retireMotion(lease:MotionLease,signal:AbortSignal):Promise<void>{
  try{
   signal.throwIfAborted();this.assertActive();
   try{await lease.pending;}catch(error){if(!(error instanceof MotionRetiredError))throw error;}
   // No old send can enqueue after the fence, so this delivery snapshot covers
   // every accepted prefix. Do not clear native ACK accounting or replay it.
   await this.waitForAcknowledgements(signal);signal.throwIfAborted();this.assertActive();
   this.#motionBound=false;
  }catch(error){try{await this.stop(error);}catch(stopError){throw new AggregateError([error,stopError],'Motion retirement and device stop failed');}throw error;}
 }
 async #motion(packets:readonly ScheduledPacket[],ids:ReadonlySet<string>,lease:MotionLease):Promise<void>{
  if(this.#motionBusy)throw new Error('Motion send already in progress');this.#motionBusy=true;
  try{
   if(this.#state!=='ready')throw new Error('Motion session is not ready');this.clock.assertActive();
   if(packets.length>200000)throw new RangeError('Motion batch exceeds message budget');
   let bytes=0;const now=serialClock.now(),staged:{data:Uint8Array;min:bigint;req:bigint;deadline:number}[]=[];
   for(const p of packets){
    if(!ids.has(p.id)||!(p.data instanceof Uint8Array)||p.data.length<1||p.data.length>59||typeof p.minClock!=='bigint'||typeof p.reqClock!=='bigint'||p.minClock<0n||p.reqClock<0n||p.minClock>=0x7fffffffffffffffn||p.reqClock>=0x7fffffffffffffffn)throw new RangeError('Invalid scheduled motion packet');
    bytes+=p.data.length+32;if(bytes>16*1024*1024)throw new RangeError('Motion batch exceeds byte budget');
    // Same 31-bit comparison guard as serialqueue_send_batch.
    const release=p.reqClock!==0x7fffffff00000000n&&p.reqClock>p.minClock+(3n<<29n)?p.reqClock-(3n<<29n):p.minClock;
    const ready=release===0n?now:this.clock.sync.systemTime(release);
    const requested=p.reqClock===0n||p.reqClock===0x7fffffff00000000n?now:this.clock.sync.systemTime(p.reqClock);
    if(!Number.isFinite(ready)||!Number.isFinite(requested)||Math.max(ready,requested)>now+60)throw new RangeError('Motion clocks exceed 60 second horizon');
    staged.push({data:Uint8Array.from(p.data),min:p.minClock,req:p.reqClock,deadline:Math.max(now,ready,requested)+5});
   }
   let index=0;
   while(index<staged.length){
    if(lease.retired)throw new MotionRetiredError();
    this.#assertOpen();this.clock.assertActive();
    // Reserve 128 native slots for clock/control queries even under backpressure.
    const capacity=3968-this.#pending.size;
    if(capacity<=0){await new Promise<void>(resolve=>this.#space.add(resolve));continue;}
    const end=Math.min(index+capacity,staged.length);
    const chunk=staged.slice(index,end);let deadline=Infinity;for(const p of chunk)deadline=Math.min(deadline,p.deadline);
    if(serialClock.now()>=deadline)throw new Error('Motion enqueue deadline exceeded');
    let id=this.#queue.sendBatch(chunk,1,deadline);this.#lastAccepted=id+BigInt(chunk.length-1);
    for(const p of chunk){
     this.#motionPending++;
     this.#pending.set(id++,{motion:true,deadline:p.deadline});
     this.#armMotionDeadline(p.deadline);
    }
    index=end;
   }
   this.#assertOpen();this.clock.assertActive();
  }catch(error){if(error instanceof MotionRetiredError&&lease.retired)throw error;try{await this.stop(error);}catch(stopError){throw new AggregateError([error,stopError],'Motion send and stop failed');}throw error;}
  finally{this.#motionBusy=false;}
 }
 #motionDone(){if(--this.#motionPending===0){clearTimeout(this.#motionTimer);this.#motionTimer=undefined;this.#motionExpiry=Infinity;}}
 #armMotionDeadline(deadline:number){
  if(deadline>=this.#motionExpiry)return;clearTimeout(this.#motionTimer);this.#motionExpiry=deadline;
  this.#motionTimer=setTimeout(()=>{
   this.#motionTimer=undefined;this.#motionExpiry=Infinity;if(this.#stopPromise)return;
   const now=serialClock.now();let next=Infinity;
   for(const ack of this.#pending.values())if(ack.motion){if(ack.deadline<=now){void this.stop(new Error('Motion acknowledgement timed out')).catch(()=>{});return;}next=Math.min(next,ack.deadline);}
   if(next!==Infinity)this.#armMotionDeadline(next);
  },Math.max(1,(deadline-serialClock.now())*1000));
 }
 #assertOpen(){if(this.#state==='closed')throw new Error('Serial session is closed');}
 #estimate(e:ReleaseEstimate){this.#assertOpen();this.#queue.setClockEstimate(e);}
 #send(payload:Uint8Array,signal:AbortSignal,scheduled?:{queue:number;min:bigint;req:bigint;deadline:number}):Promise<void>{
  signal.throwIfAborted();this.#assertOpen();if(this.#queryPending>=128)throw new Error('Too many outstanding serial acknowledgements');
  return new Promise((resolve,reject)=>{
   let timer:ReturnType<typeof setTimeout>|undefined;
   const abort=()=>{void this.stop(signal.reason??new Error('Serial send cancelled')).catch(()=>{});};
   try{const id=scheduled?this.#queue.sendBatch([{data:payload,min:scheduled.min,req:scheduled.req}],scheduled.queue,scheduled.deadline):this.#queue.send(payload),deadline=scheduled?.deadline??serialClock.now()+5;this.#lastAccepted=id;
    this.#queryPending++;if(scheduled)this.#outputPending++;
    const cleanup=()=>{this.#queryPending--;if(scheduled)this.#outputPending--;clearTimeout(timer);signal.removeEventListener('abort',abort);};
    this.#pending.set(id,{deadline,resolve,reject,cleanup});signal.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>{void this.stop(new Error('Serial acknowledgement timed out')).catch(()=>{});},Math.max(1,(deadline-serialClock.now())*1000));
   }catch(error){reject(error);void this.stop(error).catch(()=>{});}
  });
 }
 #pump(){
  if(this.#stopPromise)return;
  clearImmediate(this.#continuation);this.#continuation=undefined;
  let count=0;
  try{for(let i=0;i<256;i++){
   const event=this.#queue.pull();if(event===undefined)break;count++;if(event===null)throw new Error('Serial receive thread exited');
   if(event.notifyId){const ack=this.#pending.get(event.notifyId);if(!ack)throw new Error('Unknown serial acknowledgement');if(serialClock.now()>=ack.deadline)throw new Error('Serial acknowledgement deadline exceeded');this.#pending.delete(event.notifyId);if(ack.motion)this.#motionDone();else{ack.cleanup();ack.resolve();}
    if(this.#ackWaits.size)for(const wait of this.#ackWaits)if(event.notifyId<=wait.boundary&&--wait.remaining===0){wait.cleanup();wait.resolve();}
    for(const wake of this.#space)wake();this.#space.clear();}
   else for(const message of this.#dictionary.parseFrame(event.data)){
    const fault=firmwareFault(message,event.receiveTime,this.#state==='ready'?this.#clock?.sync:undefined);if(fault)throw fault;
    const response={message,sentTime:event.sentTime,receiveTime:event.receiveTime};
    if(!this.#queries.receive(response)){const oid=message.parameters.oid,handler=typeof oid==='number'?this.#subscriptions.get(message.name)?.get(oid):undefined;if(handler)handler.receive(response);else this.#options.onMessage?.(response);}
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
  clearImmediate(this.#continuation);this.#continuation=undefined;clearTimeout(this.#motionTimer);this.#motionTimer=undefined;this.#motionExpiry=Infinity;
  for(const p of this.#pending.values()){if(p.motion)this.#motionDone();else{p.cleanup();p.reject(cause);}}this.#pending.clear();for(const wake of this.#space)wake();this.#space.clear();
  for(const wait of this.#ackWaits){wait.cleanup();wait.reject(cause);}
  try{this.#queue.close();}catch(error){cleanupError=error;}
  void this.#queries.stop(cause).catch(()=>{});void this.#clock?.stop(cause).catch(()=>{});
  const subscribers=[...this.#subscriptions.values()].flatMap(routes=>[...routes.values()]);this.#subscriptions.clear();this.#subscriptionCount=0;
  for(const subscriber of subscribers)try{subscriber.closed(cause);}catch(error){cleanupError=cleanupError===undefined?error:new AggregateError([cleanupError,error],'Serial subscription cleanup failed');}
  const observers=[...this.#closeObservers];this.#closeObservers.clear();
  for(const notify of observers)try{notify(cause);}catch(error){cleanupError=cleanupError===undefined?error:new AggregateError([cleanupError,error],'Serial close observer failed');}
  return this.#stopPromise;
 }
}
