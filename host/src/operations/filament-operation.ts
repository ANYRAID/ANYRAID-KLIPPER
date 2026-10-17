import {createHash,randomUUID} from 'node:crypto';
import {DatabaseStore} from '../moonraker/database.ts';
import type {DatabaseNamespace} from '../moonraker/database-namespace.ts';
import {ApiError,validateJson,type Json} from '../moonraker/rpc.ts';
import {MaintenanceGate} from './maintenance-gate.ts';
import {parseFilamentRecipe,type FilamentRecipe} from '../config/filament-recipe.ts';
export interface FilamentPort {
 idle():boolean;canQueue():boolean;reserve(work:(signal:AbortSignal,begin:()=>void)=>Promise<void>,signal:AbortSignal):Promise<void>;
 sensors():{entry:{valid:boolean;present:boolean;settling?:boolean};toolhead:{valid:boolean;present:boolean;settling?:boolean}};
 target():number;heat(target:number,signal:AbortSignal):Promise<void>;stable(signal:AbortSignal):Promise<void>;
 feed(distance:number,speed:number,signal:AbortSignal):Promise<void>;off(expected:number):Promise<void>;stop(cause:unknown):Promise<void>;checkpoint?(signal:AbortSignal):Promise<void>;
}
type Action='load'|'unload';type State='pending'|'completed'|'failed'|'cancelled'|'interrupted';
interface Receipt {request_id:string;state_token:string;action:Action;recipe_hash:string;state:State;phase:string;commanded_mm:number;stop_confirmed:boolean;error:string|null;}
const registrations=new WeakMap<DatabaseStore,Promise<DatabaseNamespace>>();
/** One actual product operation. Durable receipts never resume heater/feed work.
 * Dispatch and maintenance stay owned until every accepted IO and stop settles. */
export class FilamentOperation {
 readonly #recipe:FilamentRecipe;readonly #hash:string;readonly #gate:MaintenanceGate;readonly #port:FilamentPort;readonly #ns:DatabaseNamespace;readonly #key:string;
 #token=randomUUID();#records:Receipt[]=[];#pending:Promise<Json>|undefined;#abort:AbortController|undefined;#closed=false;#fault=false;#current:Receipt|undefined;
 private constructor(recipe:FilamentRecipe,gate:MaintenanceGate,port:FilamentPort,ns:DatabaseNamespace){this.#recipe=recipe;this.#hash=createHash('sha256').update(JSON.stringify(recipe)).digest('hex');this.#key=recipe.deviceId;this.#gate=gate;this.#port=port;this.#ns=ns;}
 static async open(recipe:FilamentRecipe,gate:MaintenanceGate,port:FilamentPort,database:DatabaseStore){let registration=registrations.get(database);if(!registration){registration=database.registerLocalNamespace('native_filament_operations',{forbidden:true});registrations.set(database,registration);}const owner=new FilamentOperation(parseFilamentRecipe(recipe),gate,port,await registration),saved=await owner.#ns.get(owner.#key);if(saved!==null){validateJson(saved);if(!Array.isArray(saved)||saved.length>64)throw Error('Invalid filament journal');for(const item of saved){const r=item as unknown as Receipt;if(!r||!/^[-A-Za-z0-9_]{1,128}$/u.test(r.request_id)||!['load','unload'].includes(r.action)||!['pending','completed','failed','cancelled','interrupted'].includes(r.state)||typeof r.state_token!=='string'||!/^[a-f0-9]{64}$/u.test(r.recipe_hash)||typeof r.phase!=='string'||r.phase.length>32||!Number.isFinite(r.commanded_mm)||typeof r.stop_confirmed!=='boolean'||r.error!==null&&typeof r.error!=='string')throw Error('Invalid filament receipt');}owner.#records=structuredClone(saved) as unknown as Receipt[];if(owner.#records.some(r=>r.state==='pending')){owner.#records=owner.#records.map(r=>r.state==='pending'?{...r,state:'interrupted',phase:'reopened',stop_confirmed:false,error:'Previous process ended without confirmed completion'}:r);await owner.#ns.insert(owner.#key,owner.#records as unknown as Json);}}return owner;}
 snapshot():Record<string,Json>{return {state_token:this.#token,recipe_hash:this.#hash,unload_mode:'reverse_only',available:!this.#closed&&!this.#fault&&!this.#pending&&this.#gate.available&&this.#port.canQueue(),busy:!!this.#pending,storage_failed:this.#fault,operation:this.#current?structuredClone(this.#current) as unknown as Json:this.#records.at(-1) as unknown as Json??null};}
 async #save(record:Receipt){const next=[...this.#records.filter(r=>r.request_id!==record.request_id),structuredClone(record)].slice(-64);try{await this.#ns.insert(this.#key,next as unknown as Json);this.#records=next;this.#current=structuredClone(record);}catch(error){this.#fault=true;throw error;}}
 #guard(signal:AbortSignal){signal.throwIfAborted();if(this.#closed||this.#fault||this.#gate.status.closed)throw new ApiError(503,'Filament operation owner unavailable');}
 async #wait(predicate:()=>boolean,signal:AbortSignal){let checkpoint=performance.now();while(true){this.#guard(signal);if(predicate())return;if(performance.now()-checkpoint>=1000){await this.#port.checkpoint?.(signal);this.#guard(signal);checkpoint=performance.now();}await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason);},timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},20);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}}
 async start(params:Readonly<Record<string,Json>>,request:AbortSignal,authorize:(signal:AbortSignal)=>Promise<void>):Promise<Json>{
  if(Object.keys(params).some(k=>!['version','request_id','state_token','action'].includes(k))||params.version!==1||typeof params.request_id!=='string'||!/^[-A-Za-z0-9_]{1,128}$/u.test(params.request_id)||typeof params.state_token!=='string'||typeof params.action!=='string'||!['load','unload'].includes(params.action))return Promise.reject(new ApiError(400,'Expected version, request_id, state_token and load or unload action'));
  const initialSignal=AbortSignal.any([request,AbortSignal.timeout(this.#recipe.timeoutMs)]);await authorize(initialSignal);initialSignal.throwIfAborted();
  if(this.#pending&&this.#current?.request_id===params.request_id){if(this.#current.state_token!==params.state_token||this.#current.action!==params.action)return Promise.reject(new ApiError(409,'Filament request identity conflicts'));return this.#pending;}
  const existing=this.#records.find(r=>r.request_id===params.request_id);if(existing){if(existing.state_token!==params.state_token||existing.action!==params.action||existing.recipe_hash!==this.#hash)return Promise.reject(new ApiError(409,'Filament request identity conflicts'));if(this.#pending&&this.#current?.request_id===existing.request_id)return this.#pending;return Promise.resolve(structuredClone(existing) as unknown as Json);}
  if(this.#closed||this.#fault)return Promise.reject(new ApiError(503,'Filament operation unavailable'));if(params.state_token!==this.#token||this.#pending||!this.#port.canQueue())return Promise.reject(new ApiError(409,'Filament operation requires a fresh token and idle printer'));
  const abort=new AbortController(),deadline=setTimeout(()=>abort.abort(new Error('Filament operation deadline exceeded')),this.#recipe.timeoutMs),signal=AbortSignal.any([initialSignal,abort.signal]),record:Receipt={request_id:params.request_id,state_token:params.state_token,action:params.action as Action,recipe_hash:this.#hash,state:'pending',phase:'admission',commanded_mm:0,stop_confirmed:false,error:null};this.#abort=abort;this.#current=record;
  const task=this.#port.reserve(async(s,begin)=>{
   let release:(()=>void)|undefined,started=false,stopping:Promise<void>|undefined;const step=this.#recipe[record.action];
   const stop=()=>{if(!started)return Promise.resolve();return stopping??=(()=>{const jobs:Promise<void>[]=[];for(const work of [()=>this.#port.off(step.temperature),()=>this.#port.stop(s.reason??new Error('Filament operation failed'))])try{jobs.push(work());}catch(error){jobs.push(Promise.reject(error));}return Promise.allSettled(jobs);})().then(results=>{if(results.some(r=>r.status==='rejected'))throw new Error('Filament stop or owned heater-off was not confirmed');});};
   const aborted=()=>{void stop().catch(()=>{});};
   const admit=async()=>{this.#guard(s);await authorize(s);this.#guard(s);};
   const stage=async(phase:string)=>{record.phase=phase;await this.#save(record);await admit();};
   try{
    await admit();if(!this.#port.idle()||this.#port.target()!==0)throw new ApiError(409,'Filament operation requires idle motion and an unowned zero heater target');
    try{release=this.#gate.acquire();}catch{throw new ApiError(409,'Printer activity blocks filament operation');}await stage('waiting_input');
    await this.#wait(()=>{const sensors=this.#port.sensors();return sensors.entry.valid&&sensors.toolhead.valid&&!sensors.entry.settling&&!sensors.toolhead.settling&&sensors.entry.present&&(record.action==='load'?!sensors.toolhead.present:sensors.toolhead.present);},s);
    await stage('heating');begin();started=true;s.addEventListener('abort',aborted,{once:true});this.#guard(s);await this.#port.heat(step.temperature,s);await admit();await this.#port.stable(s);await admit();if(this.#port.target()!==step.temperature)throw Error('Owned heater target changed');
    const settled=()=>{const sensors=this.#port.sensors();if(!sensors.entry.valid||!sensors.toolhead.valid)throw Error('Filament sensor is disabled or unconfirmed');return !sensors.entry.settling&&!sensors.toolhead.settling;};
    const reached=()=>{const sensors=this.#port.sensors();return settled()&&(record.action==='load'?sensors.toolhead.present:!sensors.toolhead.present);};
    const feed=async(distance:number,phase:string,seek=false)=>{let remaining=distance;while(Math.abs(remaining)>1e-9){await stage(phase);await this.#wait(settled,s);if(seek&&reached())return;const sensors=this.#port.sensors();if(record.action==='load'&&!sensors.entry.present||this.#port.target()!==step.temperature)throw Error('Filament input or heater ownership changed');const chunk=Math.sign(remaining)*Math.min(Math.abs(remaining),this.#recipe.chunkLength);await this.#port.feed(chunk,step.speed,s);await admit();record.commanded_mm+=chunk;remaining-=chunk;}await this.#wait(settled,s);};
    await feed(step.seekDistance,'seeking_switch',true);if(!reached())throw Error('Filament switch not reached within maximum seek travel');
    await feed(record.action==='load'?this.#recipe.load.purgeDistance:this.#recipe.unload.retractDistance,record.action==='load'?'purging':'retracting');
    await stage('checking_result');await this.#wait(()=>{const sensors=this.#port.sensors();return sensors.entry.valid&&sensors.toolhead.valid&&!sensors.entry.settling&&!sensors.toolhead.settling&&(record.action==='load'?sensors.entry.present&&sensors.toolhead.present:!sensors.entry.present&&!sensors.toolhead.present);},s);
    await stage('heater_off');await this.#port.off(step.temperature);await admit();record.state='completed';record.phase='complete';record.stop_confirmed=true;await this.#save(record);await admit();
   }catch(error){
    if(started){this.#gate.invalidate();try{await stop();record.stop_confirmed=true;}catch{record.stop_confirmed=false;}}
    if(!started)record.stop_confirmed=true;record.state=s.aborted?'cancelled':'failed';record.phase='stopped';record.error=s.aborted?'Filament operation cancelled or timed out':'Filament operation failed';if(release)await this.#save(record).catch(()=>{});throw error;
   }finally{s.removeEventListener('abort',aborted);release?.();}
  },signal).then(()=>structuredClone(record) as unknown as Json);
  this.#pending=task;void task.finally(()=>{clearTimeout(deadline);this.#pending=undefined;this.#abort=undefined;this.#token=randomUUID();}).catch(()=>{});return task;
 }
 async cancel(params:Readonly<Record<string,Json>>,authorize:(signal:AbortSignal)=>Promise<void>){if(Object.keys(params).some(k=>k!=='request_id')||typeof params.request_id!=='string')throw new ApiError(400,'Expected request_id');await authorize(new AbortController().signal);if(!this.#pending||this.#current?.request_id!==params.request_id)throw new ApiError(409,'No matching active filament request');this.#abort!.abort(new Error('Explicit filament cancellation'));await this.#pending.catch(()=>{});return this.snapshot();}
 async close(){this.#closed=true;this.#abort?.abort(new Error('Filament owner retired'));await this.#pending?.catch(()=>{});}
}
