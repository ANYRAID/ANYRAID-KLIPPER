// Service-state wire fields follow Moonraker machine.py (GPL-3.0-or-later).
import {execFile} from 'node:child_process';
import {open} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import type {Json} from './rpc.ts';

export type ServiceState={active_state:string;sub_state:string};
export type ServiceSnapshot={provider:'none'|'systemd_cli';available_services:string[];service_state:Record<string,ServiceState>;instance_ids:{moonraker:string;klipper:string}};
export type ServiceSource=(signal:AbortSignal)=>Promise<ServiceSnapshot>;
export type SystemServicesOptions={source?:ServiceSource;allowedUnits?:readonly string[]};
export type ServiceCommand=(args:readonly string[],signal:AbortSignal)=>Promise<string>;
const empty=():ServiceSnapshot=>({provider:'none',available_services:[],service_state:{},instance_ids:{moonraker:'',klipper:''}});
const unitPattern=/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,239}\.service$/;
// systemd escapes characters in unrelated units as literal \xNN sequences.
// Accept their list format, while the selectable catalogue remains stricter.
const listedUnitPattern=/^(?:[A-Za-z0-9_.@-]|\\x[0-9A-Fa-f]{2}){1,256}\.service$/;
const statePattern=/^[a-z][a-z0-9-]{0,63}$/;
const defaultAllowed=(unit:string)=>/^(?:moonraker|klipper)(?:[_-]?\d+)?\.service$/.test(unit)||unit==='anyraid-node-product-host.service';
export function validateSystemServices(options:SystemServicesOptions):void{
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['source','allowedUnits'].includes(k)))throw new TypeError('Invalid system services options');
 if(options.source!==undefined&&typeof options.source!=='function')throw new TypeError('Invalid service source');
 if(options.allowedUnits!==undefined&&(!Array.isArray(options.allowedUnits)||options.allowedUnits.length>64||options.allowedUnits.some(unit=>typeof unit!=='string'||!unitPattern.test(unit))||new Set(options.allowedUnits).size!==options.allowedUnits.length))throw new TypeError('Invalid allowed service units');
 if(options.source&&options.allowedUnits!==undefined)throw new TypeError('A service source owns its allowlist');
}
/** The current process cgroup identifies its actual enclosing unit. Never infer
 * an installed or running service from an expected name or an environment hint. */
export function processServiceUnit(cgroup:string):string|null{
 if(cgroup.length>65536)return null;
 const units=new Set<string>();
 for(const line of cgroup.trim().split('\n')){const match=/^\d+:[^:]*:(\/[^\r\n]*)$/.exec(line);if(!match)continue;const unit=match[1].split('/').reverse().find(part=>unitPattern.test(part));if(unit)units.add(unit);}
 return units.size===1?[...units][0]:null;
}
async function cgroup(signal:AbortSignal):Promise<string>{
 signal.throwIfAborted();let file:Awaited<ReturnType<typeof open>>|undefined;
 try{file=await open('/proc/self/cgroup','r');const buffer=Buffer.alloc(65537);let size=0;while(size<buffer.length){signal.throwIfAborted();const {bytesRead}=await file.read(buffer,size,buffer.length-size,null);if(!bytesRead)break;size+=bytesRead;}signal.throwIfAborted();return size>65536?'':buffer.subarray(0,size).toString('utf8');}
 catch{signal.throwIfAborted();return '';}finally{await file?.close();}
}
const systemctl:ServiceCommand=(args,signal)=>new Promise((resolve,reject)=>{
 let failed=true,result='';
 const child=execFile('systemctl',[...args],{timeout:1000,killSignal:'SIGKILL',maxBuffer:1048576,encoding:'utf8',env:{...process.env,LC_ALL:'C',SYSTEMD_COLORS:'0'}},(error,stdout)=>{failed=!!error;result=stdout;});
 // Abort may invoke execFile's error callback before the child exits. Join the
 // actual close event; the kill deadline applies only to this read-only child.
 const abort=()=>{child.kill('SIGKILL');};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 child.once('close',()=>{signal.removeEventListener('abort',abort);if(signal.aborted)reject(signal.reason);else if(failed)reject(new Error('Service query unavailable'));else resolve(result);});
});
export function linuxServiceSource(options:{allowedUnits?:readonly string[];nativeCombined?:boolean;command?:ServiceCommand;readCgroup?:(signal:AbortSignal)=>Promise<string>}={}):ServiceSource{
 validateSystemServices({allowedUnits:options.allowedUnits});
 const extra=new Set(options.allowedUnits??[]),command=options.command??systemctl,readCgroup=options.readCgroup??cgroup;
 return async signal=>{
  signal.throwIfAborted();if(process.platform!=='linux')return empty();
  const ownUnit=processServiceUnit(await readCgroup(signal));signal.throwIfAborted();
  const allowed=(unit:string)=>defaultAllowed(unit)||extra.has(unit)||unit===ownUnit;
  const listing=await command(['--no-pager','--no-ask-password','list-units','--all','--type=service','--plain','--no-legend','--full'],signal);signal.throwIfAborted();
  if(typeof listing!=='string'||Buffer.byteLength(listing)>1048576)throw new Error('Invalid service list');
  const units=new Set<string>();
  for(const line of listing.trim().split('\n')){if(!line.trim())continue;const fields=line.trim().split(/\s+/);if(fields.length<4||!listedUnitPattern.test(fields[0])||!statePattern.test(fields[1])||!statePattern.test(fields[2])||!statePattern.test(fields[3]))throw new Error('Invalid service list');if(unitPattern.test(fields[0])&&allowed(fields[0]))units.add(fields[0]);}
  if(ownUnit)units.add(ownUnit);if(units.size>64)throw new Error('Service catalogue capacity exceeded');
  const selected=[...units].sort(),states:Record<string,ServiceState>={};
  if(selected.length){
   const output=await command(['--no-pager','--no-ask-password','show','--property=Id,LoadState,ActiveState,SubState',...selected],signal);signal.throwIfAborted();
   if(typeof output!=='string'||Buffer.byteLength(output)>1048576)throw new Error('Invalid service properties');
   const blocks=output.trim().split(/\n\s*\n/);if(blocks.length!==selected.length)throw new Error('Incomplete service properties');
   for(let i=0;i<blocks.length;i++){
    const fields:Record<string,string>=Object.create(null);
    for(const line of blocks[i].split('\n')){const match=/^(Id|LoadState|ActiveState|SubState)=(.*)$/.exec(line);if(!match||fields[match[1]]!==undefined)throw new Error('Invalid service properties');fields[match[1]]=match[2];}
    if(Object.keys(fields).length!==4||fields.Id!==selected[i]||![fields.LoadState,fields.ActiveState,fields.SubState].every(value=>statePattern.test(value)))throw new Error('Invalid service properties');
    if(fields.LoadState==='not-found')continue;
    // Refuse alias remapping until a control owner can verify its canonical unit.
    states[selected[i].slice(0,-8)]={active_state:fields.ActiveState,sub_state:fields.SubState};
   }
  }
  const own=ownUnit&&states[ownUnit.slice(0,-8)]?ownUnit.slice(0,-8):'';
  return {provider:'systemd_cli',available_services:Object.keys(states),service_state:states,instance_ids:{moonraker:own,klipper:options.nativeCombined?own:''}};
 };
}
function validateSnapshot(value:ServiceSnapshot):ServiceSnapshot{
 if(!value||typeof value!=='object'||!['none','systemd_cli'].includes(value.provider)||!Array.isArray(value.available_services)||value.available_services.length>64||!value.service_state||typeof value.service_state!=='object'||Array.isArray(value.service_state)||!value.instance_ids||typeof value.instance_ids!=='object')throw new Error('Invalid service snapshot');
 const keys=Object.keys(value.service_state);if(keys.length!==value.available_services.length||new Set(value.available_services).size!==keys.length||value.available_services.some(name=>typeof name!=='string'||!unitPattern.test(name+'.service')||!keys.includes(name)))throw new Error('Invalid service catalogue');
 for(const state of Object.values(value.service_state))if(!state||typeof state!=='object'||Object.keys(state).length!==2||!Object.hasOwn(state,'active_state')||!Object.hasOwn(state,'sub_state')||typeof state.active_state!=='string'||typeof state.sub_state!=='string'||!statePattern.test(state.active_state)||!statePattern.test(state.sub_state))throw new Error('Invalid service state');
 for(const role of ['moonraker','klipper'] as const){const name=value.instance_ids[role];if(typeof name!=='string'||name!==''&&!keys.includes(name))throw new Error('Invalid service instance');}
 if(value.provider==='none'&&keys.length)throw new Error('Unavailable service provider has a catalogue');
 return {provider:value.provider,available_services:[...value.available_services],service_state:structuredClone(value.service_state),instance_ids:{moonraker:value.instance_ids.moonraker,klipper:value.instance_ids.klipper}};
}
/** Process-owned sampler: HTTP/RPC reads never spawn children, concurrent polls
 * coalesce, failed snapshots retain the complete last good view, and close joins
 * cancellation before dependencies are released. No system mutation is exposed. */
export class SystemServices {
 readonly #source:ServiceSource;readonly #notify:((change:Record<string,ServiceState>)=>void)|undefined;readonly #abort=new AbortController();
 #value=empty();#pending:Promise<void>|undefined;#timer:ReturnType<typeof setTimeout>|undefined;#started=false;#samples=0;#failures=0;#notificationFailures=0;
 constructor(options:SystemServicesOptions={},notify?:((change:Record<string,ServiceState>)=>void),nativeCombined=false){validateSystemServices(options);if(notify!==undefined&&typeof notify!=='function')throw new TypeError('Invalid service observer');this.#source=options.source??linuxServiceSource({allowedUnits:options.allowedUnits,nativeCombined});this.#notify=notify;}
 get status(){return {samples:this.#samples,failures:this.#failures,notification_failures:this.#notificationFailures,pending:!!this.#pending,closed:this.#abort.signal.aborted};}
 snapshot():Record<string,Json>{return structuredClone(this.#value);}
 refresh():Promise<void>{
  if(this.#abort.signal.aborted)return Promise.reject(this.#abort.signal.reason);if(this.#pending)return this.#pending;
  const pending=Promise.resolve().then(()=>this.#source(this.#abort.signal)).then(value=>{
   this.#abort.signal.throwIfAborted();const next=validateSnapshot(value),changes:Record<string,ServiceState>={};
   if(this.#samples)for(const [name,state] of Object.entries(next.service_state))if(!isDeepStrictEqual(state,this.#value.service_state[name]))changes[name]={...state};
   this.#value=next;this.#samples++;
   // Changes are per-service deltas, as in the upstream notification. Catalogue
   // removals are reflected by the next system_info query, not invented states.
   for(const [name,state] of Object.entries(changes))try{this.#notify?.({[name]:state});}catch{this.#notificationFailures++;}
  }).finally(()=>{if(this.#pending===pending)this.#pending=undefined;});this.#pending=pending;return pending;
 }
 async start(){if(this.#started)return;this.#started=true;await this.#sample();this.#abort.signal.throwIfAborted();this.#schedule();}
 async #sample(){try{await this.refresh();}catch(error){if(this.#abort.signal.aborted)throw error;this.#failures++;}}
 #schedule(){if(this.#abort.signal.aborted)return;this.#timer=setTimeout(()=>{this.#timer=undefined;void this.#sample().catch(()=>{}).finally(()=>this.#schedule());},2000);this.#timer.unref();}
 async close(){this.#abort.abort(new Error('System services closed'));clearTimeout(this.#timer);await this.#pending?.catch(()=>{});}
}
