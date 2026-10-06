import {execFile} from 'node:child_process';
import {open,stat} from 'node:fs/promises';
import {processServiceUnit,validateSystemServices,type ServiceCommand} from './system-services.ts';

export type MachineAction={kind:'service';action:'start'|'stop'|'restart';service:string}|{kind:'server_restart'|'reboot'|'shutdown'};
export type MachineRetirement='none'|'device'|'process';
export interface MachineControlPort {
 /** Validate trusted scope before response admission. This performs no I/O. */
 retirement(action:MachineAction):MachineRetirement;
 /** The product owner must finish the required retirement first. Completion
  * acknowledges the OS job submission, not target state or physical shutdown. */
 execute(action:MachineAction,signal:AbortSignal):Promise<void>;
 /** Before device acquisition, prove that another permitted hardware-owning
  * service has no running process. Job acceptance alone cannot prove this. */
 assertDeviceAvailable(signal:AbortSignal):Promise<void>;
 close():Promise<void>;
}
export interface MachineControlOptions {ownUnit:string;allowedUnits?:readonly string[];deviceUnits?:readonly string[];}
/** Same bounded trusted descriptor is used by runtime and deployment preparation. */
export function validateMachineControlOptions(options:MachineControlOptions):void{
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['ownUnit','allowedUnits','deviceUnits'].includes(k)))throw new TypeError('Invalid machine control options');
 validateSystemServices({allowedUnits:[options.ownUnit]});validateSystemServices({allowedUnits:options.allowedUnits});validateSystemServices({allowedUnits:options.deviceUnits});
 const allowed=new Set([options.ownUnit,...options.allowedUnits??[]]);
 if(allowed.size>64||(options.deviceUnits??[]).some(unit=>!allowed.has(unit)))throw new TypeError('Invalid machine control catalogue');
}
export interface MachineControlIO {
 command:ServiceCommand;
 readCgroup(signal:AbortSignal):Promise<string>;
 insideContainer(signal:AbortSignal):Promise<boolean>;
}
export class MachineControlError extends Error {
 readonly code:'unavailable'|'not_allowed'|'busy'|'identity'|'container'|'unit'|'command';
 constructor(code:MachineControlError['code'],message:string){super(message);this.code=code;}
}
async function readCgroup(signal:AbortSignal):Promise<string>{
 signal.throwIfAborted();const file=await open('/proc/self/cgroup','r');
 try{const buffer=Buffer.alloc(65537);let size=0;while(size<buffer.length){signal.throwIfAborted();const read=await file.read(buffer,size,buffer.length-size,null);if(!read.bytesRead)break;size+=read.bytesRead;}signal.throwIfAborted();if(size>65536)throw new MachineControlError('identity','Process cgroup exceeds capacity');return buffer.subarray(0,size).toString('utf8');}
 finally{await file.close();}
}
async function insideContainer(signal:AbortSignal):Promise<boolean>{
 for(const path of ['/run/systemd/container','/.dockerenv','/run/.containerenv']){
  signal.throwIfAborted();try{await stat(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
 const result=(await runCommand('systemd-detect-virt',['--container'],signal,true)).trim();
 if(!/^[a-z][a-z0-9-]{0,63}$/u.test(result))throw new MachineControlError('container','Container detection is unavailable');
 return result!=='none';
}
/** Fixed executable, no shell or interactive sudo. A response callback may run
 * before the process exits; only actual child close completes this command. */
function runCommand(binary:'systemctl'|'systemd-detect-virt',args:readonly string[],signal:AbortSignal,allowNone=false):Promise<string>{return new Promise((resolve,reject)=>{
 signal.throwIfAborted();let failed=true,result='';
 const child=execFile(binary,[...args],{timeout:2000,killSignal:'SIGKILL',maxBuffer:65536,encoding:'utf8',env:{...process.env,LC_ALL:'C',SYSTEMD_COLORS:'0'}},(error,stdout)=>{failed=!!error&&!(allowNone&&error.code===1&&!error.killed&&stdout.trim()==='none');result=stdout;});
 const abort=()=>{child.kill('SIGKILL');};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 child.once('close',()=>{signal.removeEventListener('abort',abort);if(signal.aborted)reject(signal.reason);else if(failed)reject(new MachineControlError('command','System service command failed; inspect permissions and system journal'));else resolve(result);});
});}
const command:ServiceCommand=(args,signal)=>runCommand('systemctl',args,signal);
const systemIO:MachineControlIO={command,readCgroup,insideContainer};
const flags=['--no-pager','--no-ask-password'] as const;
/** Explicit trusted integration capability. Read-only service sources never
 * create one implicitly. The kernel owner, canonical unit and current load state
 * are rechecked for every request. No request can extend the unit allowlist. */
export class LinuxMachineControl implements MachineControlPort {
 readonly #own:string;readonly #allowed:Set<string>;readonly #device:Set<string>;readonly #io:MachineControlIO;readonly #abort=new AbortController();#pending:Promise<void>|undefined;
 constructor(options:MachineControlOptions,io:Partial<MachineControlIO>={}){
  validateMachineControlOptions(options);
  this.#own=options.ownUnit;this.#allowed=new Set([this.#own,...options.allowedUnits??[]]);this.#device=new Set(options.deviceUnits??[]);
  if(!io||typeof io!=='object'||Array.isArray(io)||Object.keys(io).some(k=>!['command','readCgroup','insideContainer'].includes(k))||Object.values(io).some(value=>typeof value!=='function'))throw new TypeError('Invalid machine control dependencies');
  this.#io={...systemIO,...io};
 }
 #checked(value:MachineAction):MachineAction{
  if(this.#abort.signal.aborted)throw new MachineControlError('unavailable','Machine control is closed');
  if(!value||typeof value!=='object'||Array.isArray(value))throw new MachineControlError('not_allowed','Invalid machine action');
  if(value.kind==='service'){
   if(Object.keys(value).length!==3||Object.keys(value).some(k=>!['kind','action','service'].includes(k))||!['start','stop','restart'].includes(value.action)||typeof value.service!=='string'||!this.#allowed.has(value.service+'.service'))throw new MachineControlError('not_allowed','Service action is not allowed');
   if(value.service+'.service'===this.#own&&value.action!=='restart')throw new MachineControlError('not_allowed','The Moonraker process service supports restart only');
   return {kind:'service',action:value.action,service:value.service};
  }
  if(Object.keys(value).length!==1||!['server_restart','reboot','shutdown'].includes(value.kind))throw new MachineControlError('not_allowed','Invalid machine action');
  return {kind:value.kind};
 }
 retirement(value:MachineAction):MachineRetirement{
  const action=this.#checked(value);if(action.kind!=='service'||action.service+'.service'===this.#own)return 'process';
  const unit=action.service+'.service';return this.#device.has(unit)||/^klipper(?:[_-]?\d+|_mcu)?\.service$/u.test(unit)?'device':'none';
 }
 assertDeviceAvailable(signal:AbortSignal):Promise<void>{
  if(this.#abort.signal.aborted)return Promise.reject(this.#abort.signal.reason);if(this.#pending)return Promise.reject(new MachineControlError('busy','A machine command is already pending'));
  const owned=AbortSignal.any([signal,this.#abort.signal]);
  const pending=Promise.resolve().then(()=>this.#deviceAvailable(owned)).finally(()=>{if(this.#pending===pending)this.#pending=undefined;});this.#pending=pending;return pending;
 }
 async #deviceAvailable(owned:AbortSignal){
  owned.throwIfAborted();
  if(processServiceUnit(await this.#io.readCgroup(owned))!==this.#own)throw new MachineControlError('identity','Process service identity changed or is unavailable');
  for(const unit of this.#allowed){
   if(unit===this.#own||!this.#device.has(unit)&&!/^klipper(?:[_-]?\d+|_mcu)?\.service$/u.test(unit))continue;
   const output=await this.#io.command([...flags,'show','--property=Id,LoadState,ActiveState,MainPID','--',unit],owned);owned.throwIfAborted();
   if(typeof output!=='string'||Buffer.byteLength(output)>65536)throw new MachineControlError('unit','Invalid device service properties');
   const properties=new Map<string,string>();for(const line of output.trim().split('\n')){const match=/^(Id|LoadState|ActiveState|MainPID)=(.*)$/u.exec(line);if(!match||properties.has(match[1]))throw new MachineControlError('unit','Invalid device service properties');properties.set(match[1],match[2]);}
   if(properties.size!==4||properties.get('Id')!==unit||!['loaded','not-found'].includes(properties.get('LoadState')??'')||!['inactive','failed'].includes(properties.get('ActiveState')??'')||properties.get('MainPID')!=='0')throw new MachineControlError('busy','Another device service has not stopped');
  }
 }
 execute(value:MachineAction,signal:AbortSignal):Promise<void>{
  let action:MachineAction;try{action=this.#checked(value);signal.throwIfAborted();if(this.#pending)throw new MachineControlError('busy','A machine command is already pending');}catch(error){return Promise.reject(error);}
  const owned=AbortSignal.any([signal,this.#abort.signal]);
  // Snapshot the validated request before any await. A caller cannot mutate it
  // into another unit while kernel identity or canonical properties are read.
  const pending=Promise.resolve().then(()=>this.#execute(action,owned)).finally(()=>{if(this.#pending===pending)this.#pending=undefined;});this.#pending=pending;return pending;
 }
 async #execute(action:MachineAction,signal:AbortSignal){
  signal.throwIfAborted();if(process.platform!=='linux')throw new MachineControlError('unavailable','Linux system service control is unavailable');
  if(processServiceUnit(await this.#io.readCgroup(signal))!==this.#own)throw new MachineControlError('identity','Process service identity changed or is unavailable');signal.throwIfAborted();
  if((action.kind==='reboot'||action.kind==='shutdown')&&await this.#io.insideContainer(signal))throw new MachineControlError('container','Operating system control is unavailable inside a container');signal.throwIfAborted();
  const unit=action.kind==='service'?action.service+'.service':this.#own;
  const output=await this.#io.command([...flags,'show','--property=Id,LoadState','--',unit],signal);signal.throwIfAborted();
  if(typeof output!=='string'||Buffer.byteLength(output)>65536)throw new MachineControlError('unit','Invalid service properties');
  const properties=new Map<string,string>();for(const line of output.trim().split('\n')){const match=/^(Id|LoadState)=(.*)$/u.exec(line);if(!match||properties.has(match[1]))throw new MachineControlError('unit','Invalid service properties');properties.set(match[1],match[2]);}
  if(properties.size!==2||properties.get('Id')!==unit||properties.get('LoadState')!=='loaded')throw new MachineControlError('unit','Canonical service is not loaded');
  const argv=action.kind==='service'?[...flags,'--no-block',action.action,'--',unit]:action.kind==='server_restart'?[...flags,'--no-block','restart','--',this.#own]:[...flags,'--no-block',action.kind==='shutdown'?'poweroff':'reboot'];
  await this.#io.command(argv,signal);signal.throwIfAborted();
 }
 async close(){this.#abort.abort(new MachineControlError('unavailable','Machine control closed'));await this.#pending?.catch(()=>{});}
}
