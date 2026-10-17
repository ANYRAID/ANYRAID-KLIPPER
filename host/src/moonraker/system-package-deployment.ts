// System deployment follows Moonraker 1cfb0c41 system_deploy.py; no shell,
// backend failover after submission, or automatic mutation replay.
import {createHash,randomUUID} from 'node:crypto';
import {AptPackageProvider,type AptProviderConfiguration,type AptMutationState} from './apt-package-provider.ts';
import {PackageKitProvider} from './packagekit-provider.ts';
import {SystemBusOwner} from './system-bus-owner.ts';
import {DatabaseStore} from './database.ts';
import type {DatabaseNamespace} from './database-namespace.ts';
import {ApiError,validateJson,type Json} from './rpc.ts';
export interface SystemPackageRuntime {bus?:SystemBusOwner;apt?:Omit<AptProviderConfiguration,'journal'|'notify'>;packageKitTimeoutMs?:number;}
export interface SystemPackageContext {signal:AbortSignal;authorize:()=>void|Promise<void>;notify?:(message:string)=>void;}
type Backend='apt'|'packagekit';
interface Operation {id:string;effect:'refresh'|'upgrade'|'install';backend:Backend;backend_key:string;state:'pending'|'failed'|'interrupted'|'succeeded'|'acknowledged';started_at:number;error:string|null;receipt:Json;packages?:string[];}
interface Evidence {operation_id:string;revision:string;at:number;facts:Json;}
interface Saved {schema:1;packages:string[];package_query_confirmed:boolean;last_refresh:number;last_error:string;operation:Operation|null;apt:AptMutationState|null;evidence:Evidence|null;}
const registrations=new WeakMap<DatabaseStore,Promise<DatabaseNamespace>>();
const initial=():Saved=>({schema:1,packages:[],package_query_confirmed:false,last_refresh:0,last_error:'',operation:null,apt:null,evidence:null});
const blocked=(op:Operation|null)=>!!op&&!['succeeded','acknowledged'].includes(op.state);
function restore(value:unknown):Saved {
 validateJson(value);if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError(503,'Invalid system update journal');const row=value as unknown as Saved;if(row.package_query_confirmed===undefined)row.package_query_confirmed=false;
 if(typeof row.package_query_confirmed!=='boolean'||row.schema!==1||!Array.isArray(row.packages)||row.packages.length>65536||row.packages.some(v=>typeof v!=='string'||!v.isWellFormed()||Buffer.byteLength(v)>2048||/[\0\r\n]/u.test(v))||!Number.isFinite(row.last_refresh)||row.last_refresh<0||typeof row.last_error!=='string'||row.last_error.length>128||!Object.hasOwn(row,'operation')||!Object.hasOwn(row,'apt')||!Object.hasOwn(row,'evidence'))throw new ApiError(503,'Invalid system update cache');
 const op=row.operation;if(op&&(!/^system-[a-f0-9-]{36}$/u.test(op.id)||!['refresh','upgrade','install'].includes(op.effect)||!['apt','packagekit'].includes(op.backend)||!/^[a-f0-9]{64}$/u.test(op.backend_key)||!['pending','failed','interrupted','succeeded','acknowledged'].includes(op.state)||!Number.isFinite(op.started_at)||op.error!==null&&typeof op.error!=='string'||op.packages!==undefined&&(!Array.isArray(op.packages)||op.packages.length>256||op.packages.some(name=>typeof name!=='string'||name.length>256||!/^[A-Za-z0-9][A-Za-z0-9+_.:-]*$/u.test(name)))))throw new ApiError(503,'Invalid system update operation');
 if(row.evidence&&(!op||row.evidence.operation_id!==op.id||typeof row.evidence.revision!=='string'||!/^[a-f0-9-]{36}$/u.test(row.evidence.revision)||!Number.isFinite(row.evidence.at)))throw new ApiError(503,'Invalid system reconciliation evidence');return structuredClone(row);
}
/** Owns selection/cache/journal. Runtime ports come only from process startup. */
export class SystemPackageDeployment {
 readonly #database:DatabaseStore;readonly #runtime:SystemPackageRuntime;readonly #enabled:boolean;readonly #preferPackageKit:boolean;readonly #interval:number;readonly #life=new AbortController();
 #namespace:DatabaseNamespace|undefined;#saved=initial();#apt:AptPackageProvider|undefined;#pk:PackageKitProvider|undefined;#backend:Backend|undefined;#available=false;#fault=false;#closed=false;#notify:((message:string)=>void)|undefined;readonly #observers=new Set<()=>void>();
 constructor(database:DatabaseStore,options:{enabled:boolean;packagekit:boolean;refreshInterval:number;runtime?:SystemPackageRuntime}){this.#database=database;this.#enabled=options.enabled;this.#preferPackageKit=options.packagekit;this.#interval=options.refreshInterval;this.#runtime={...options.runtime};}
 get enabled(){return this.#enabled;}
 get mutationBlocked(){return this.#fault||blocked(this.#saved.operation);}
 get lastRefresh(){return this.#saved.last_refresh;}
 get status():Record<string,Json>{return {name:'system',configured_type:'system',package_count:this.#saved.packages.length,package_list:[...this.#saved.packages],package_query_confirmed:this.#saved.package_query_confirmed,provider:this.#backend??null,available:this.#available,enabled:this.#enabled,mutation_blocked:this.mutationBlocked,last_error:this.#saved.last_error,operation:this.#saved.operation?structuredClone(this.#saved.operation) as unknown as Json:null,reconciliation:this.#saved.evidence?structuredClone(this.#saved.evidence) as unknown as Json:null};}
 needsRefresh(){return this.#enabled&&Date.now()/1000>=this.#saved.last_refresh+this.#interval;}
 #key(backend:Backend){return createHash('sha256').update(JSON.stringify(backend==='packagekit'?{backend,bus_identity:this.#runtime.bus?.configurationIdentity??null}: {backend,commands:this.#runtime.apt?.commands,configurationFile:this.#runtime.apt?.configurationFile,aptConfiguration:this.#runtime.apt?.aptConfiguration,privilege:this.#runtime.apt?.privilege})).digest('hex');}
 observe(observer:()=>void){this.#observers.add(observer);return ()=>{this.#observers.delete(observer);};}
 #changed(){for(const fn of this.#observers)try{fn();}catch{}}
 async #persist(next:Saved){try{await this.#namespace!.insert('state',next as unknown as Json);this.#saved=structuredClone(next);this.#changed();}catch(error){this.#fault=true;this.#changed();throw error;}}
 async #pkSaved():Promise<any>{try{return await this.#database.get('packagekit_provider',['state']);}catch(e){if(e instanceof ApiError&&e.status===404)return null;throw e;}}
 async initialize(signal:AbortSignal):Promise<void>{
  let registration=registrations.get(this.#database);if(!registration){registration=this.#database.registerLocalNamespace('native_system_update',{forbidden:true});registrations.set(this.#database,registration);}this.#namespace=await registration;const saved=await this.#namespace.get('state');if(saved!==null)this.#saved=restore(saved);
  if(this.#saved.operation?.state==='pending')await this.#persist({...this.#saved,operation:{...this.#saved.operation,state:'interrupted',error:'reopened-without-confirmed-result'}});
  const pkSaved=await this.#pkSaved();if(!this.mutationBlocked&&pkSaved?.operation&&!['succeeded','acknowledged'].includes(pkSaved.operation.state))await this.#persist({...this.#saved,operation:{id:'system-'+randomUUID(),effect:pkSaved.operation.method==='RefreshCache'?'refresh':'upgrade',backend:'packagekit',backend_key:this.#key('packagekit'),state:'interrupted',started_at:Date.now()/1000,error:'retained-packagekit-operation',receipt:pkSaved.operation},evidence:null});
  if(!this.#enabled&&!this.mutationBlocked)return;
  const required=this.mutationBlocked?this.#saved.operation?.backend:undefined;
  if((required==='packagekit'||!required&&this.#preferPackageKit)&&this.#runtime.bus){
   this.#pk=new PackageKitProvider({bus:this.#runtime.bus,database:this.#database,timeoutMs:this.#runtime.packageKitTimeoutMs,notify:progress=>{this.#notify?.('PackageKit '+JSON.stringify(progress));}});
   try{await this.#pk.initialize(signal);await this.#pk.drain();this.#backend='packagekit';this.#available=true;await this.#initializeCache(signal);return;}catch(error){await this.#pk.drain();signal.throwIfAborted();if(this.#fault)throw error;if(required==='packagekit'||this.#pk.status.mutation_blocked){this.#backend='packagekit';return;}await this.#pk.close();this.#pk=undefined;}
  }
  if((!required||required==='apt')&&this.#runtime.apt){
   this.#apt=new AptPackageProvider({...this.#runtime.apt,journal:{load:async()=>this.#saved.apt,save:async apt=>{await this.#persist({...this.#saved,apt});}},notify:message=>this.#notify?.(message)});
   try{await this.#apt.initialize({signal,authorize:()=>{signal.throwIfAborted();}});this.#backend='apt';this.#available=true;await this.#initializeCache(signal);return;}catch(error){await this.#apt.drain();signal.throwIfAborted();if(this.#fault)throw error;this.#backend=required==='apt'?'apt':undefined;}
  }
  this.#saved.last_error='System package backend unavailable';
 }
 async #initializeCache(signal:AbortSignal){if(this.mutationBlocked)return;try{const packages=await this.#packages({signal,authorize:()=>{signal.throwIfAborted();}});await this.drain();signal.throwIfAborted();await this.#persist({...this.#saved,packages,package_query_confirmed:true,last_error:''});}catch(error){await this.drain();signal.throwIfAborted();if(this.#fault)throw error;await this.#persist({...this.#saved,package_query_confirmed:false,last_error:'Initial package query failed'});}}
 async #admit(context:SystemPackageContext){context.signal.throwIfAborted();this.#life.signal.throwIfAborted();await context.authorize();context.signal.throwIfAborted();this.#life.signal.throwIfAborted();}
 async #packages(context:SystemPackageContext):Promise<string[]>{await this.#admit(context);if(this.#backend==='packagekit')return this.#pk!.getPackages(context.signal,context.authorize);return this.#apt!.getPackages(context);}
 async #mutate(effect:Operation['effect'],context:SystemPackageContext,names?:readonly string[]):Promise<void>{
  if(this.#closed||!this.#enabled||!this.#available||!this.#backend)throw new ApiError(503,'System package backend unavailable');if(this.mutationBlocked)throw new ApiError(409,'System update requires explicit reconciliation');await this.#admit(context);
  const operation:Operation={id:'system-'+randomUUID(),effect,backend:this.#backend,backend_key:this.#key(this.#backend),state:'pending',started_at:Date.now()/1000,error:null,receipt:null,...names?{packages:[...names]}:{}};await this.#persist({...this.#saved,operation,evidence:null});this.#notify=context.notify;
  try{
   await this.#admit(context);
   if(effect==='install'){if(this.#backend==='packagekit')await this.#pk!.installPackages(names!,{notify:true,signal:context.signal,authorize:context.authorize});else await this.#apt!.installPackages(names!,context,{notify:true});}
   else if(this.#backend==='packagekit'){await this.#pk!.refreshPackages(effect==='upgrade',context.signal,context.authorize);await this.#pk!.drain();if(effect==='upgrade'){await this.#admit(context);await this.#pk!.upgradeSystem(context.signal,context.authorize);}}
   else{await this.#apt!.refreshPackages(context,effect==='upgrade');if(effect==='upgrade'){await this.#admit(context);await this.#apt!.upgradeSystem(context);}}
   await this.drain();await this.#admit(context);const packages=await this.#packages(context);await this.drain();await this.#admit(context);
   await this.#persist({...this.#saved,packages,package_query_confirmed:true,last_refresh:Date.now()/1000,last_error:'',operation:{...operation,state:'succeeded',receipt:this.#receipt()}});
  }catch(error){await this.drain();const receipt=this.#receipt();await this.#persist({...this.#saved,last_error:'System '+effect+' failed',operation:{...operation,state:'interrupted',error:'inspect-original-backend-receipt',receipt}}).catch(()=>{});throw error;}
  finally{await this.drain();this.#notify=undefined;}
 }
 #receipt():Json{return this.#backend==='packagekit'?this.#pk?.status.operation as unknown as Json??null:this.#apt?.status.mutation as unknown as Json??null;}
 refresh(context:SystemPackageContext):Promise<void>{return this.#mutate('refresh',context);}
 installPackages(names:readonly string[],context:SystemPackageContext):Promise<void>{if(!Array.isArray(names)||names.length>256||names.some(name=>typeof name!=='string'||name.length>256||!/^[A-Za-z0-9][A-Za-z0-9+_.:-]*$/u.test(name)))return Promise.reject(new ApiError(400,'Invalid system package names'));if(!names.length)return Promise.resolve();return this.#mutate('install',context,names);}
 async update(context:SystemPackageContext):Promise<boolean>{if(this.mutationBlocked)throw new ApiError(409,'System update requires explicit reconciliation');if(!this.#enabled||!this.#available)throw new ApiError(503,'System package backend unavailable');if(!this.#saved.package_query_confirmed)throw new ApiError(503,'System package list is unknown; refresh required');if(!this.#saved.packages.length)return false;await this.#mutate('upgrade',context);return true;}
 async inspect(context:SystemPackageContext):Promise<Record<string,Json>>{
  if(!this.#saved.operation||!this.mutationBlocked||this.#fault)throw new ApiError(409,'No reconcilable system operation');await this.drain();await this.#admit(context);const op=this.#saved.operation;if(op.backend_key!==this.#key(op.backend))throw new ApiError(409,'Original system backend configuration required for reconciliation');let facts:Json;
  try{if(op.backend==='packagekit'){const active=await this.#pk?.inspectReconciliation(context.signal,context.authorize);facts=active?{available:true,...active}:{available:false};}else{const found=await this.#apt?.inspectReconciliation(context);facts=found?{available:true,...found}:{available:false};}}
  catch(error){context.signal.throwIfAborted();facts={available:false,probe:'fixed-read-only-probe-failed'};}finally{await this.drain();}
  await this.#admit(context);const evidence:Evidence={operation_id:op.id,revision:randomUUID(),at:Date.now()/1000,facts};await this.#persist({...this.#saved,evidence});return this.status;
 }
 async reconcile(params:Readonly<Record<string,Json>>,actor:string|null,context:SystemPackageContext):Promise<void>{
  if(Object.keys(params).some(k=>!['operation_id','revision','confirm_external_check','note'].includes(k))||typeof params.operation_id!=='string'||typeof params.revision!=='string'||params.confirm_external_check!==true||typeof params.note!=='string'||!params.note.trim()||Buffer.byteLength(params.note)>2048||/[\0\r]/u.test(params.note))throw new ApiError(400,'Expected operation_id, revision, explicit external-check confirmation and bounded note');
  const op=this.#saved.operation,evidence=this.#saved.evidence;if(!op||!blocked(op)||!evidence||params.operation_id!==op.id||params.revision!==evidence.revision||Date.now()/1000-evidence.at>300||this.#fault)throw new ApiError(409,'Reconciliation evidence is stale');await this.drain();await this.#admit(context);
  if(op.backend_key!==this.#key(op.backend))throw new ApiError(409,'Original system backend configuration required');
  // Reprobe at acknowledgement. An active daemon transaction always prevents
  // clearing its fence. Unavailable facts remain unknown, not proof of success.
  if(op.backend==='packagekit'&&this.#pk){try{const facts=await this.#pk.inspectReconciliation(context.signal,context.authorize);if(facts.active_transactions.length)throw new ApiError(409,'PackageKit transactions are still active');}catch(error){if(error instanceof ApiError||context.signal.aborted)throw error;}finally{await this.drain();}}
  await this.#admit(context);const receipt={original:structuredClone(op),facts:structuredClone(evidence),acknowledgement:{actor,permission:'machine.update.reconcile',at:Date.now()/1000,note:params.note,external_check_confirmed:true,meaning:'acknowledged unknown result; new explicit actions permitted; original upgrade not proven successful'}};
  await this.#namespace!.insert('receipt-'+op.id+'-'+randomUUID(),receipt as unknown as Json);await this.#admit(context);
  if(op.backend==='packagekit'){
   if(this.#pk?.status.operation)await this.#pk.acknowledgeReconciliation(this.#pk.status.operation.id,context.signal,context.authorize);
   else{const old=await this.#pkSaved();if(old?.operation){const ns=await this.#database.wrapNamespace('packagekit_provider',false);await ns.insert('state',{...old,operation:{...old.operation,state:'acknowledged'}});}}
  }else if(this.#apt){const mutation=this.#apt.status.mutation;if(mutation.state!=='idle')await this.#apt.acknowledgeReconciliation(mutation.id,context);}
  await this.drain();await this.#admit(context);await this.#persist({...this.#saved,operation:{...op,state:'acknowledged'},last_error:'',evidence:null});
 }
 async drain(){await Promise.all([this.#pk?.drain(),this.#apt?.drain()]);}
 waitUnblocked(signal:AbortSignal):Promise<void>{if(!this.mutationBlocked)return Promise.resolve();return new Promise((resolve,reject)=>{const changed=()=>{if(!this.mutationBlocked){release();signal.removeEventListener('abort',abort);resolve();}},release=this.observe(changed),abort=()=>{release();reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();else changed();});}
 async close(){this.#closed=true;this.#life.abort();await Promise.all([this.#pk?.close(),this.#apt?.close()]);this.#observers.clear();}
}
