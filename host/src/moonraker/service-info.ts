import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {MachineControlError} from './machine-control.ts';
import {currentPowerIdentity,type ProcessPowerIdentity} from './none-machine-control.ts';
import {readServiceCgroup,readSystemctl,type ServiceCommand} from './system-services.ts';
import {supervisorCommand,parseSupervisorStatus} from './supervisor-machine-control.ts';
import type {SystemBusOwner,SystemdProperties} from './system-bus-owner.ts';

// Fixed Moonraker 1cfb0c41 default ordering. Group is an explicit systemd extension.
export const servicePropertyNames=['Requires','After','SupplementaryGroups','EnvironmentFiles','ExecStart','WorkingDirectory','FragmentPath','Description','User','Group'] as const;
export type ServiceInfoProperties=Partial<Record<typeof servicePropertyNames[number],string|readonly string[]>>;
export interface ServiceInfo {
 provider:'none'|'systemd_cli'|'systemd_dbus'|'supervisord_cli';manager:'none'|'systemd'|'supervisord';
 unit_name:string;is_default:boolean;properties:ServiceInfoProperties|Readonly<Record<string,string>>;
 /** Internal typed argv, not executable instructions or a public API field. */
 execArgv?:readonly string[];executable?:string;diagnostic?:string;
 /** Complete internal environment facts; the upstream display still uses first. */
 environmentFiles?:readonly (readonly [string,boolean])[];environmentDisplay?:string;
}
export interface ServiceInfoProof {info:ServiceInfo;process:ProcessPowerIdentity;generation:number;fingerprint:string;bus?:SystemdProperties;}
export interface ServiceInfoSource {read(signal:AbortSignal):Promise<ServiceInfoProof>;current(proof:ServiceInfoProof):boolean;}
interface ReadOnlyInfoIO {identity(signal:AbortSignal):Promise<ProcessPowerIdentity>;cgroup(signal:AbortSignal):Promise<string>;systemctl:ServiceCommand;supervisor(args:readonly string[],signal:AbortSignal):Promise<string>;configuration(path:string,signal:AbortSignal):Promise<string>;}
const error=(message:string)=>new MachineControlError('identity',message);
const text=(value:unknown):value is string=>typeof value==='string'&&value.isWellFormed()&&!value.includes('\0')&&Buffer.byteLength(value)<=65536;
const list=(value:unknown):value is string[]=>Array.isArray(value)&&value.length<=512&&value.every(text);
const unitPattern=/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,239}\.service$/u;
/** systemctl joins argv with spaces without escaping (systemd v256 show.c
 * 1273). Keep a complete unique display; NEVER reconstruct trusted argv. */
export function systemctlExecDisplay(value:string):{executable:string;display:string}{
 if(!text(value)||(value.match(/argv\[\]=/gu)??[]).length!==1||(value.match(/\{\s*path=/gu)??[]).length!==1||(value.match(/;\s*(?:ignore_errors|flags)=/gu)??[]).length!==1)throw error('Ambiguous or multiple service commands require manual installation');
 const match=/^\{\s*path=(.*?)\s+;\s+argv\[\]=(.*?)\s+;\s+(?:ignore_errors=(?:yes|no)|flags=[^;]*)\s+;\s+start_time=\[[^\]\r\n]*\]\s+;\s+stop_time=\[[^\]\r\n]*\]\s+;\s+pid=\d+\s+;\s+code=[^;]+\s+;\s+status=[^;}]+\s*\}$/u.exec(value);
 if(!match||!match[1]||!match[2])throw error('Unsupported service command display requires manual installation');return {executable:match[1],display:match[2]};
}
export function normalizeSystemdProperties(raw:Readonly<Record<string,unknown>>,provider:'systemd_cli'|'systemd_dbus',unit:string):ServiceInfo{
 const properties:ServiceInfoProperties={};let execArgv:readonly string[]|undefined,executable:string|undefined,environmentFiles:readonly (readonly [string,boolean])[]|undefined,environmentDisplay:string|undefined;
 for(const key of servicePropertyNames){if(!Object.hasOwn(raw,key))continue;const value=raw[key];
  if(['Requires','After','SupplementaryGroups'].includes(key)){
   const values=provider==='systemd_cli'&&text(value)?value.trim().split(/\s+/u).filter(Boolean):value;if(!list(values))throw error('Invalid service property list');properties[key]=Object.freeze([...values]);
  }else if(key==='EnvironmentFiles'){
   if(provider==='systemd_cli'){if(!text(value))throw error('Invalid service environment declaration');properties[key]=value.trim()?value.trim().split(/\s+/u)[0]:'';environmentDisplay=value;}
   else{if(!Array.isArray(value)||value.length>512||value.some(item=>!Array.isArray(item)||item.length!==2||!text(item[0])||typeof item[1]!=='boolean'))throw error('Invalid typed environment declaration');properties[key]=value.length?value[0][0]:'';environmentFiles=Object.freeze(value.map(item=>Object.freeze([item[0],item[1]] as [string,boolean])));}
  }else if(key==='ExecStart'){
   if(provider==='systemd_cli'){
    if(!text(value))throw error('Invalid service command declaration');if(value){const command=systemctlExecDisplay(value);properties[key]=command.display;executable=command.executable;}else properties[key]='';
   }else{
    if(!Array.isArray(value)||value.length>32||value.some(item=>!Array.isArray(item)||item.length<2||!text(item[0])||!list(item[1])))throw error('Invalid typed service command declaration');
    if(value.length===1){execArgv=Object.freeze([...value[0][1]]);executable=value[0][0];properties[key]=execArgv.join(' ');}else if(value.length===0)properties[key]='';else throw error('Multiple service commands require manual installation');
   }
  }else{if(!text(value))throw error('Invalid service string property');properties[key]=value;}
 }
 return Object.freeze({provider,manager:'systemd',unit_name:unit,is_default:unit==='moonraker.service',properties:Object.freeze(properties),...execArgv?{execArgv}:{},...executable?{executable}:{},...environmentFiles?{environmentFiles}:{},...environmentDisplay!==undefined?{environmentDisplay}:{}});
}
export function serviceInfoFingerprint(info:ServiceInfo):string{
 const keys=info.manager==='systemd'?servicePropertyNames:Object.keys(info.properties).sort();
 // Ordered present key/value pairs preserve absent versus empty; no observation time.
 const properties=keys.filter(key=>Object.hasOwn(info.properties,key)).map(key=>[key,info.properties[key as keyof typeof info.properties]]);
 return createHash('sha256').update(JSON.stringify([info.provider,info.manager,info.unit_name,info.is_default,properties,info.execArgv??null,info.executable??null,info.environmentFiles??null,info.environmentDisplay??null,info.diagnostic??null])).digest('hex');
}
function parseShow(value:string):Record<string,unknown>{
 if(!text(value)||Buffer.byteLength(value)>65536)throw error('Service properties exceeded capacity');const result:Record<string,unknown>=Object.create(null);
 for(const line of value.split('\n')){if(!line)continue;const at=line.indexOf('=');if(at<1)throw error('Malformed service property');const key=line.slice(0,at);if(Object.hasOwn(result,key))throw error('Duplicate service property');result[key]=line.slice(at+1);}
 if(typeof result.MainPID==='string'&&/^\d+$/u.test(result.MainPID))result.MainPID=Number(result.MainPID);return result;
}
function pidStatusUnit(status:string):string{
 if(!text(status))throw error('Current process service status exceeded capacity');const header=status.split('\n')[0].trim(),match=/^(?:[\u25cf\u25cb*]\s+)?([A-Za-z0-9][A-Za-z0-9_.@-]{0,239}\.service)(?:\s|$)/u.exec(header);
 if(!match||(status.match(/^(?:[\u25cf\u25cb*]\s+)?[A-Za-z0-9][A-Za-z0-9_.@-]{0,239}\.(?:service|scope)(?:\s|$)/gmu)??[]).length!==1)throw error('Current PID has no unique systemd service heading');return match[1];
}
const propertyArgs=(unit:string)=>['--no-pager','--no-ask-password','show','--property=Id,MainPID,LoadState,'+servicePropertyNames.join(','),'--',unit];
/** Validate every hierarchy before selecting its deepest service membership. */
function installationCgroup(value:string):string|null{
 if(!text(value)||!value.trim())throw error('Malformed installation cgroup');const units=new Set<string>();
 for(const line of value.trimEnd().split('\n')){
  const match=/^\d+:[^:\r\n]*:(\/[^\r\n]*)$/u.exec(line);if(!match)throw error('Malformed installation cgroup');let deepest:string|undefined;
  for(const component of match[1].split('/'))if(component.endsWith('.service')){if(!unitPattern.test(component))throw error('Invalid installation service component');deepest=component;}
  if(deepest)units.add(deepest);
 }
 if(units.size>1)throw error('Current process has no unambiguous systemd service');return units.values().next().value??null;
}
async function configuration(path:string,signal:AbortSignal):Promise<string>{
 signal.throwIfAborted();const f=await open(path,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);try{const before=await f.stat();if(!before.isFile()||before.size>1048576)throw error('Supervisor configuration exceeded capacity');const buffer=Buffer.alloc(1048577);let size=0;while(size<buffer.length){signal.throwIfAborted();const read=await f.read(buffer,size,buffer.length-size,null);if(!read.bytesRead)break;size+=read.bytesRead;}signal.throwIfAborted();if(size>1048576)throw error('Supervisor configuration exceeded capacity');const after=await f.stat();if(before.dev!==after.dev||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||before.size!==after.size)throw error('Supervisor configuration changed');return new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,size));}finally{await f.close();}
}
export function supervisorProgramProperties(value:string,unit:string):Readonly<Record<string,string>>|undefined{
 if(Buffer.byteLength(value)>1048576)throw error('Supervisor configuration exceeded capacity');const sections=new Map<string,Record<string,string>>();let section:Record<string,string>|undefined,last:string|undefined,lastIndent=0;
 for(const original of value.split('\n')){const line=original.trim();if(!line||line.startsWith('#')||line.startsWith(';'))continue;const header=/^\[([^\]]+)\]\s*(?:[#;].*)?$/u.exec(line);
  if(header){if(sections.has(header[1]))throw error('Duplicate Supervisor section');section=Object.create(null) as Record<string,string>;sections.set(header[1],section);last=undefined;continue;}
  if(!section)throw error('Supervisor option has no section');const indent=original.length-original.trimStart().length;if(indent>lastIndent&&last){section[last]+='\n'+line;continue;}
  const option=/^([^:=\s][^:=]*?)\s*[:=]\s*(.*)$/u.exec(line);if(!option)throw error('Invalid Supervisor option');const key=option[1].trim().toLowerCase();if(Object.hasOwn(section,key))throw error('Duplicate Supervisor option');section[key]=option[2];last=key;lastIndent=indent;
 }
 let program=sections.get('program:'+unit);
 if(!program&&unit.includes(':')){const [group,processName]=unit.split(':'),members=sections.get('group:'+group)?.programs?.split(',').map(s=>s.trim());if(members?.includes(processName)){const candidate=sections.get('program:'+processName);if(candidate&&(!candidate.process_name||candidate.process_name==='%(program_name)s')&&(!candidate.numprocs||candidate.numprocs==='1'))program=candidate;}}
 return program?Object.freeze({...sections.get('DEFAULT'),...program}):undefined;
}
/** One process owner; consumers borrow it. CLI current() means last observed,
 * never a substitute for async refresh before acquisition or install effects. */
export class ProviderServiceInfo implements ServiceInfoSource {
 readonly #provider:ServiceInfo['provider'];readonly #bus:SystemBusOwner|undefined;readonly #config:string;readonly #allowed:Set<string>;readonly #io:ReadOnlyInfoIO;readonly #abort=new AbortController();readonly #pending=new Set<Promise<unknown>>();#routeHint:{unit:string;cgroup:string}|undefined;#fingerprint='';#generation=0;#sequence=0;#latest:ServiceInfoProof|undefined;#process:ProcessPowerIdentity|undefined;#closing:Promise<void>|undefined;
 constructor(provider:ServiceInfo['provider'],options:{bus?:SystemBusOwner;supervisordConfig?:string;supervisorProcesses?:readonly string[]}={},io:Partial<ReadOnlyInfoIO>={}){
  this.#provider=provider;this.#bus=options.bus;this.#config=options.supervisordConfig??'';this.#allowed=new Set(options.supervisorProcesses??[]);this.#io={identity:currentPowerIdentity,cgroup:readServiceCgroup,systemctl:readSystemctl,supervisor:(args,signal)=>supervisorCommand(this.#config,args,signal),configuration,...io};
 }
 current(proof:ServiceInfoProof){return !this.#abort.signal.aborted&&proof===this.#latest&&proof.generation===this.#generation&&proof.fingerprint===this.#fingerprint&&proof.process.pid===process.pid&&proof.process.startTicks===this.#process?.startTicks&&(!proof.bus||!!this.#bus?.installationCurrent(proof.bus));}
 read(signal:AbortSignal):Promise<ServiceInfoProof>{
  const sequence=++this.#sequence;this.#generation++;this.#latest=undefined;const owned=AbortSignal.any([signal,this.#abort.signal]);const task=(async()=>{owned.throwIfAborted();const processIdentity=await this.#io.identity(owned);if(processIdentity.pid!==process.pid||!/^\d{1,32}$/u.test(processIdentity.startTicks)||this.#process&&this.#process.startTicks!==processIdentity.startTicks)throw error('Process identity changed during service discovery');let info:ServiceInfo,bus:SystemdProperties|undefined,routeHint:{unit:string;cgroup:string}|undefined;
   if(this.#provider==='none')info={provider:'none',manager:'none',unit_name:'',is_default:false,properties:{},diagnostic:'No machine provider configured; service file validation is unavailable.'};
   else if(this.#provider==='systemd_dbus'){
    if(!this.#bus)throw error('D-Bus service information owner is unavailable');bus=await this.#bus.unitProperties(await this.#bus.ownUnit(owned),owned);const unit=bus.values.Id;if(typeof unit!=='string'||bus.values.MainPID!==process.pid||bus.values.LoadState!=='loaded')throw error('Current service identity is unavailable');info=normalizeSystemdProperties(bus.values,'systemd_dbus',unit);
   }else if(this.#provider==='systemd_cli'){
    const cgroup=await this.#io.cgroup(owned);let unit=installationCgroup(cgroup),raw:Record<string,unknown>;const hint=this.#routeHint?.cgroup===cgroup?this.#routeHint:undefined;
    if(this.#routeHint&&!hint&&sequence===this.#sequence)this.#routeHint=undefined;
    if(!unit&&hint){
     // Only a route hint, never an authorization proof: both observations must
     // be current and agree. Join both actual child closes even on early error.
     const [status,properties]=await Promise.allSettled([Promise.resolve().then(()=>this.#io.systemctl(['--no-pager','--no-ask-password','--full','status',String(process.pid)],owned)),Promise.resolve().then(()=>this.#io.systemctl(propertyArgs(hint.unit),owned))]);owned.throwIfAborted();
     if(status.status==='rejected')throw status.reason;if(properties.status==='rejected')throw properties.reason;unit=pidStatusUnit(status.value);if(unit!==hint.unit)throw error('Current PID service differs from its routing hint');raw=parseShow(properties.value);
    }else{
     if(!unit)unit=pidStatusUnit(await this.#io.systemctl(['--no-pager','--no-ask-password','--full','status',String(process.pid)],owned));if(!unitPattern.test(unit))throw error('Current process service is unsupported');raw=parseShow(await this.#io.systemctl(propertyArgs(unit),owned));
    }
    if(raw.Id!==unit||raw.MainPID!==process.pid||raw.LoadState!=='loaded'||await this.#io.cgroup(owned)!==cgroup)throw error('CLI service identity changed');info=normalizeSystemdProperties(raw,'systemd_cli',unit);routeHint={unit,cgroup};
   }else{
    const rows=parseSupervisorStatus(await this.#io.supervisor(['status'],owned)),matches=[...rows].filter(([name,row])=>row.pid===String(process.pid)&&(this.#allowed.has(name)||/(?:^|:)(?:moonraker|klipper)(?:[_-]?\d+)?$/u.test(name)));if(matches.length!==1)throw error('Supervisor current process identity is unavailable');const unit=matches[0][0];let properties:Readonly<Record<string,string>>|undefined;
    for(const path of this.#config?[this.#config]:['/etc/supervisord.conf','/etc/supervisor/supervisord.conf'])try{properties=supervisorProgramProperties(await this.#io.configuration(path,owned),unit);break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if((await this.#io.supervisor(['pid',unit],owned)).trim()!==String(process.pid))throw error('Supervisor process identity changed');info={provider:'supervisord_cli',manager:'supervisord',unit_name:unit,is_default:unit==='moonraker',properties:properties??{},...properties?{}:{diagnostic:'Supervisor program properties unavailable; service must be updated manually.'}};
   }
   const after=await this.#io.identity(owned);owned.throwIfAborted();if(sequence!==this.#sequence||after.pid!==processIdentity.pid||after.startTicks!==processIdentity.startTicks||bus&&!this.#bus!.installationCurrent(bus))throw error('Process service proof changed during discovery');const frozenInfo=Object.freeze({...info,properties:Object.freeze({...info.properties})}),fingerprint=serviceInfoFingerprint(frozenInfo);this.#routeHint=routeHint;this.#fingerprint=fingerprint;this.#process={...processIdentity};const token=bus?Object.freeze({...bus,identity:Object.freeze({...bus.identity}),values:Object.freeze({})}):undefined;const proof=Object.freeze({info:frozenInfo,process:Object.freeze({...processIdentity}),generation:this.#generation,fingerprint,...token?{bus:token}:{}});this.#latest=proof;return proof;
  })().catch(failure=>{if(sequence===this.#sequence){this.#latest=undefined;this.#routeHint=undefined;this.#fingerprint='';this.#generation++;}throw failure;});this.#pending.add(task);void task.then(()=>this.#pending.delete(task),()=>this.#pending.delete(task));return task;
 }
 close(){return this.#closing??=(async()=>{this.#routeHint=undefined;this.#abort.abort(error('Service information owner closed'));await Promise.allSettled([...this.#pending]);})();}
}
