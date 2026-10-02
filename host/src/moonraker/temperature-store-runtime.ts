import {componentSubscriptions} from './component-subscriptions.ts';
import {ApiError,type Json} from './rpc.ts';
import {TemperatureStore} from './temperature-store.ts';
import type {KlippyLifecycle} from './klippy-lifecycle.ts';
import type {StatusView} from './subscription-status.ts';
import type {NativeObjects} from './native-objects.ts';
const object=(v:unknown):v is Record<string,Json>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const names=(v:unknown):string[]=>{if(v===undefined)return [];if(!Array.isArray(v)||v.length>4096||v.some(n=>typeof n!=='string'||!n||n.length>256||n.includes('\0')))throw new ApiError(502,'Invalid temperature sensor list');return v as string[];};
const owner=componentSubscriptions.temperatureStore;
/** Server-owned timer; a disconnected cache carries the last value as upstream
 * does. Each ready connection generation discovers and subscribes afresh. */
export class TemperatureStoreRuntime {
 readonly store:TemperatureStore;readonly #cache:()=>StatusView;readonly #seen=new WeakSet<KlippyLifecycle>();readonly #abort=new AbortController();
 #timer:ReturnType<typeof setTimeout>|undefined;#pending:Promise<void>|undefined;#generation:KlippyLifecycle|undefined;#initializationError:string|null=null;#sampleError:string|null=null;#samples=0;
 constructor(store:TemperatureStore,cache:()=>StatusView){this.store=store;this.#cache=cache;}
 #native:NativeObjects|undefined;#nativeQuery:Record<string,null>={};
 readyNative(objects:NativeObjects):void{
  if(this.#abort.signal.aborted)throw new Error('Temperature store closed');
  if(this.#native===objects)return;
  if(this.#native||this.#generation)throw new Error('Temperature source already owned');
  const heaters=objects.query({heaters:null}).status.heaters;
  const sensors=names(heaters.available_sensors),monitors=names(heaters.available_monitors),all=[...new Set([...sensors,...monitors])],query=Object.fromEntries(all.map(name=>[name,null]));
  this.store.configure(sensors,monitors,all.length?objects.query(query).status:{});
  this.#native=objects;this.#nativeQuery=query;this.#initializationError=null;if(all.length)this.#schedule();
 }
 get status(){return {...this.store.status,running:!!this.#timer,initializing:!!this.#pending,samples:this.#samples,error:this.#initializationError??this.#sampleError,closed:this.#abort.signal.aborted};}
 /** Freeze native history without sampling a retired device or closing the
  * process-owned store. A subsequent readyNative discovers a fresh source. */
 detachNative(){this.#stopTimer();this.#native=undefined;this.#nativeQuery={};}
 ready(runtime:KlippyLifecycle):void{
  if(this.#native)throw new Error('Temperature source already owned');
  if(this.#abort.signal.aborted||this.#seen.has(runtime)||!runtime.snapshot.initialized||runtime.snapshot.state!=='ready')return;
  this.#seen.add(runtime);this.#generation=runtime;
  const pending=this.#initialize(runtime);this.#pending=pending;
  void pending.catch(error=>{if(this.#generation===runtime&&!this.#abort.signal.aborted&&!runtime.signal.aborted)this.#initializationError=error instanceof Error?error.message:'Temperature initialization failed';}).finally(()=>{if(this.#pending===pending)this.#pending=undefined;});
 }
 async #initialize(runtime:KlippyLifecycle){
  const signal=AbortSignal.any([runtime.signal,this.#abort.signal]);
  const result=await runtime.request('objects/query',{objects:{heaters:null}},{signal});signal.throwIfAborted();
  if(!object(result)||!object(result.status))throw new ApiError(502,'Invalid heaters query response');
  const heaters=result.status.heaters??{};if(!object(heaters))throw new ApiError(502,'Invalid heaters status');
  const sensors=names(heaters.available_sensors),monitors=names(heaters.available_monitors),all=[...new Set([...sensors,...monitors])];
  let status:StatusView={};if(all.length){const subscription=await runtime.subscribeComponent(owner,Object.fromEntries(all.map(name=>[name,null])),signal);signal.throwIfAborted();status=subscription.status;}
  if(this.#generation!==runtime)throw new ApiError(499,'Temperature generation changed');
  this.store.configure(sensors,monitors,status);this.#initializationError=null;this.#stopTimer();if(all.length)this.#schedule();
 }
 #stopTimer(){clearTimeout(this.#timer);this.#timer=undefined;}
 #schedule(){if(this.#abort.signal.aborted)return;this.#timer=setTimeout(()=>{this.#timer=undefined;try{this.store.sample(this.#native?this.#native.query(this.#nativeQuery).status:this.#cache());this.#samples++;this.#sampleError=null;}catch(error){this.#sampleError=error instanceof Error?error.message:'Temperature sampling failed';}this.#schedule();},1000);this.#timer.unref();}
 async close(){this.#abort.abort(new Error('Temperature store closed'));this.#stopTimer();this.#generation?.removeSubscription(owner);await this.#pending?.catch(()=>{});}
}
