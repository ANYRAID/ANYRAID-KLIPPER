import {randomUUID} from 'node:crypto';
import {DatabaseStore} from './database.ts';
import type {DatabaseNamespace} from './database-namespace.ts';
import type {Json} from './rpc.ts';
import {SystemBusOwner} from './system-bus-owner.ts';
import {packageKitActions,packageKitNames,packageKitId,PackageKitError,type PackageKitRequest,type PackageKitIdentity,type PackageKitProgress,type PackageKitPackage} from './packagekit-protocol.ts';

interface PackageOperation {id:string;method:'RefreshCache'|'InstallPackages'|'UpdatePackages';state:'pending'|'succeeded'|'failed'|'interrupted';transaction:PackageKitIdentity|null;error:string|null;}
interface Saved {schema:1;packages:string[];last_refresh:number|null;operation:PackageOperation|null;}
const empty=():Saved=>({schema:1,packages:[],last_refresh:null,operation:null});
const registrations=new WeakMap<DatabaseStore,{namespace:Promise<DatabaseNamespace>;active:PackageKitProvider|undefined}>();
function saved(value:unknown):value is Saved {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const row=value as Saved;
 if(row.schema!==1||!Array.isArray(row.packages)||row.packages.length>4096||row.packages.some(name=>typeof name!=='string'||!name.isWellFormed()||Buffer.byteLength(name)>2048||/[;\0\r\n]/u.test(name))||row.last_refresh!==null&&(!Number.isFinite(row.last_refresh)||row.last_refresh<0))return false;
 const op=row.operation;if(op===null)return true;
 return !!op&&typeof op==='object'&&typeof op.id==='string'&&/^packagekit-[a-f0-9-]{36}$/u.test(op.id)&&['RefreshCache','InstallPackages','UpdatePackages'].includes(op.method)&&['pending','succeeded','failed','interrupted'].includes(op.state)&&(op.error===null||typeof op.error==='string'&&op.error.length<=128)&&(op.transaction===null||!!op.transaction&&typeof op.transaction==='object'&&typeof op.transaction.path==='string'&&/^\/[0-9]+_[A-Za-z0-9_]+$/u.test(op.transaction.path)&&op.transaction.path.length<=200&&Number.isSafeInteger(op.transaction.connection)&&Number.isSafeInteger(op.transaction.owner)&&typeof op.transaction.sender==='string'&&/^:[0-9]+\.[0-9]+$/u.test(op.transaction.sender));
}
/** Internal standalone provider. A durable namespace is mandatory for writes.
 * Borrows a process bus; never closes it, invokes APT or replays a mutation. */
export class PackageKitProvider {
 readonly #bus:SystemBusOwner;readonly #database:DatabaseStore;readonly #timeout:number;readonly #notify:((progress:PackageKitProgress)=>void)|undefined;readonly #abort=new AbortController();
 #namespace:DatabaseNamespace|undefined;#saved=empty();#initialized=false;#fault=false;#pending:Promise<unknown>|undefined;#closing:Promise<void>|undefined;
 constructor(options:{bus:SystemBusOwner;database:DatabaseStore;timeoutMs?:number;notify?:(progress:PackageKitProgress)=>void}){
  if(!(options.bus instanceof SystemBusOwner)||!(options.database instanceof DatabaseStore)||options.timeoutMs!==undefined&&(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>3600000)||options.notify!==undefined&&typeof options.notify!=='function')throw new TypeError('Invalid PackageKit owner');
  this.#bus=options.bus;this.#database=options.database;this.#timeout=options.timeoutMs??600000;this.#notify=options.notify;
 }
 get status(){return {provider:'packagekit' as const,initialized:this.#initialized,busy:!!this.#pending,closed:this.#abort.signal.aborted,storage_fault:this.#fault,package_count:this.#saved.packages.length,package_list:[...this.#saved.packages],last_refresh:this.#saved.last_refresh,operation:this.#saved.operation?structuredClone(this.#saved.operation):null,mutation_blocked:this.#fault||!!this.#saved.operation&&this.#saved.operation.state!=='succeeded'};}
 async #persist(value:Saved){try{await this.#namespace!.insert('state',value as unknown as Json);this.#saved=value;}catch(error){this.#fault=true;throw error;}}
 #run<T>(action:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  if(this.#abort.signal.aborted||this.#pending) return Promise.reject(new PackageKitError('closed-or-busy'));
  const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new PackageKitError('timeout','unknown')),this.#timeout);timer.unref();const active=AbortSignal.any([this.#abort.signal,deadline.signal,...signal?[signal]:[]]);
  const cancelled=Promise.withResolvers<never>(),abort=()=>cancelled.reject(new PackageKitError('cancelled','unknown'));active.addEventListener('abort',abort,{once:true});if(active.aborted)abort();
  // Keep the actual task owned after its caller times out; close and all future
  // requests wait/reject until accepted durable writes and cancellation drain.
  const task=Promise.resolve().then(()=>{active.throwIfAborted();return action(active);});this.#pending=task;
  void task.finally(()=>{clearTimeout(timer);active.removeEventListener('abort',abort);if(this.#pending===task)this.#pending=undefined;}).catch(()=>{});
  return Promise.race([task,cancelled.promise]);
 }
 initialize(signal?:AbortSignal):Promise<void>{return this.#run(async active=>{
  if(this.#initialized)return;let registration=registrations.get(this.#database);if(!registration){registration={namespace:this.#database.registerLocalNamespace('packagekit_provider',{forbidden:true}),active:undefined};registrations.set(this.#database,registration);}if(registration.active&&registration.active!==this)throw new PackageKitError('provider-already-owned');registration.active=this;this.#namespace??=await registration.namespace;const storage=await this.#namespace.get('state');if(storage!==null){if(!saved(storage)){this.#fault=true;throw new PackageKitError('invalid-journal');}this.#saved=storage;}
  if(this.#saved.operation?.state==='pending')await this.#persist({...this.#saved,operation:{...this.#saved.operation,state:'interrupted',error:'reopened-without-confirmed-result'}});
  for(const action of packageKitActions){active.throwIfAborted();if(!await this.#bus.packageKitPermission(action,active))throw new PackageKitError('permission-denied');}
  await this.#bus.packageKitAvailable(active);active.throwIfAborted();this.#initialized=true;
 },signal);}
 #require(){if(!this.#initialized||this.#fault)throw new PackageKitError(this.#fault?'storage-fault':'not-initialized');}
 async #transaction(request:PackageKitRequest,signal:AbortSignal,notify=false):Promise<PackageKitPackage[]>{
  this.#require();const mutation=request.method==='RefreshCache'||request.method==='InstallPackages'||request.method==='UpdatePackages';let submitted=false;
  if(mutation){if(this.status.mutation_blocked)throw new PackageKitError('reconciliation-required');const operation:PackageOperation={id:'packagekit-'+randomUUID(),method:request.method as PackageOperation['method'],state:'pending',transaction:null,error:null};await this.#persist({...this.#saved,operation});}
  try{
   signal.throwIfAborted();
   const result=await this.#bus.packageKit(request,signal,{...mutation?{beforeSubmit:async identity=>{await this.#persist({...this.#saved,operation:{...this.#saved.operation!,transaction:identity}});},submitted:()=>{submitted=true;}}:{},...notify&&this.#notify?{progress:this.#notify}:{}},this.#timeout);
   if(mutation)await this.#persist({...this.#saved,operation:{...this.#saved.operation!,state:'succeeded',error:null}});return result;
  }catch(error){if(mutation&&!this.#fault){const code=error instanceof PackageKitError?error.code:'transaction-failed';await this.#persist({...this.#saved,operation:{...this.#saved.operation!,state:submitted&&(!(error instanceof PackageKitError)||error.outcome==='unknown')?'interrupted':'failed',error:code}});}throw error;}
 }
 getPackages(signal?:AbortSignal):Promise<string[]>{return this.#run(async active=>{const rows=await this.#transaction({method:'GetUpdates'},active);const packages=[...new Set(rows.map(row=>row.package_id.split(';')[0]))];await this.#persist({...this.#saved,packages,last_refresh:Date.now()/1000});return packages;},signal);}
 refreshPackages(notify=false,signal?:AbortSignal):Promise<void>{return this.#run(async active=>{await this.#transaction({method:'RefreshCache'},active,notify);},signal);}
 resolvePackages(names:readonly string[],signal?:AbortSignal):Promise<string[]>{packageKitNames(names);return this.#run(async active=>(await this.#transaction({method:'Resolve',names},active)).map(row=>row.package_id),signal);}
 installPackages(names:readonly string[],options:{notify?:boolean;signal?:AbortSignal}={}):Promise<void>{packageKitNames(names);return this.#run(async active=>{await this.#transaction({method:'RefreshCache'},active,options.notify);const ids=[...new Set((await this.#transaction({method:'Resolve',names},active)).map(row=>row.package_id))];if(ids.length)await this.#transaction({method:'InstallPackages',ids},active,options.notify);},options.signal);}
 upgradeSystem(signal?:AbortSignal):Promise<void>{return this.#run(async active=>{this.#require();if(this.status.mutation_blocked)throw new PackageKitError('reconciliation-required');const ids=[...new Set((await this.#transaction({method:'GetUpdates'},active)).map(row=>row.package_id))];if(ids.some(id=>!packageKitId(id)))throw new PackageKitError('invalid-package');if(ids.length)await this.#transaction({method:'UpdatePackages',ids},active,true);await this.#persist({...this.#saved,packages:[]});},signal);}
 close():Promise<void>{return this.#closing??=(async()=>{this.#abort.abort(new PackageKitError('closed','unknown'));await this.#pending?.catch(()=>{});const registration=registrations.get(this.#database);if(registration?.active===this)registration.active=undefined;})();}
}
