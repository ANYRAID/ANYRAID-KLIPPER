import {execFile,type ChildProcess,type ExecFileException} from 'node:child_process';
import {constants} from 'node:fs';
import {access,open,stat} from 'node:fs/promises';
import {MachineActionUncertain,MachineControlError,NoneProviderUnavailable,type MachineAction,type MachineControlPort} from './machine-control.ts';
export interface NonePowerOptions {allowedActions:readonly ('reboot'|'shutdown')[];}
/** Borrowed actual device admission authority. Its owner retains release/close. */
export type MachineDeviceGuard=Pick<MachineControlPort,'assertDeviceAvailable'>;
export interface ProcessPowerIdentity {pid:number;startTicks:string;}
export type PowerBinary='systemctl'|'reboot'|'poweroff'|'halt';
export interface NonePowerIO {
 readIdentity(signal:AbortSignal):Promise<ProcessPowerIdentity>;
 insideContainer(signal:AbortSignal):Promise<boolean>;
 hasSystemctl(signal:AbortSignal):Promise<boolean>;
 command(binary:PowerBinary,args:readonly string[],signal:AbortSignal):Promise<void>;
}
export function validateNonePowerOptions(options:NonePowerOptions){
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='allowedActions')||!Array.isArray(options.allowedActions)||!options.allowedActions.length||options.allowedActions.length>2||options.allowedActions.some(action=>!['reboot','shutdown'].includes(action))||new Set(options.allowedActions).size!==options.allowedActions.length)throw new TypeError('Invalid none power descriptor');
}
async function boundedProc(path:string,signal:AbortSignal){
 signal.throwIfAborted();const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
 try{const bytes=Buffer.alloc(65537);let size=0;while(size<bytes.length){signal.throwIfAborted();const result=await file.read(bytes,size,bytes.length-size,null);if(!result.bytesRead)break;size+=result.bytesRead;}signal.throwIfAborted();if(size>65536)throw new MachineControlError('identity','Process proof exceeded capacity');return bytes.subarray(0,size).toString('utf8');}finally{await file.close();}
}
export async function currentPowerIdentity(signal:AbortSignal):Promise<ProcessPowerIdentity>{
 if(process.platform!=='linux')throw new MachineControlError('unavailable','Linux process identity is unavailable');const text=await boundedProc('/proc/self/stat',signal),end=text.lastIndexOf(')'),pid=Number(text.slice(0,text.indexOf(' '))),startTicks=text.slice(end+2).split(' ')[19];if(end<0||pid!==process.pid||!/^\d{1,32}$/u.test(startTicks??''))throw new MachineControlError('identity','Current process identity is unavailable');return {pid,startTicks};
}
async function container(signal:AbortSignal){
 for(const path of ['/.dockerenv','/.dockerinit','/run/.containerenv','/run/systemd/container']){signal.throwIfAborted();try{await stat(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 // Fixed upstream cgroup and PID1 schedule checks, with unreadable proof failing closed.
 const cgroup=await boundedProc('/proc/1/cgroup',signal);if(/docker|lxc|kubepods|libpod/u.test(cgroup))return true;
 const name=(await boundedProc('/proc/1/sched',signal)).trim().split(/\s/u)[0];if(!name)throw new MachineControlError('container','Container proof is unavailable');return !['init','systemd'].includes(name);
}
async function hasSystemctl(path:string,signal:AbortSignal){
 for(const directory of path.split(':').filter(Boolean)){signal.throwIfAborted();try{if((await stat(directory+'/systemctl')).isFile()){await access(directory+'/systemctl',constants.X_OK);return true;}}catch(error){if(!['ENOENT','EACCES'].includes((error as NodeJS.ErrnoException).code??''))throw error;}}signal.throwIfAborted();return false;
}
export type PowerExec=(binary:string,args:readonly string[],options:{timeout:number;killSignal:'SIGKILL';maxBuffer:number;encoding:'utf8';env:NodeJS.ProcessEnv},callback:(error:ExecFileException|null,stdout:string)=>void)=>ChildProcess;
/** Fixed argv, no shell/interactive sudo; actual close joins failed or cancelled children. */
export function nonePowerCommand(binary:PowerBinary,args:readonly string[],signal:AbortSignal,execute:PowerExec=execFile,path=process.env.PATH??''):Promise<void>{return new Promise((resolve,reject)=>{
 signal.throwIfAborted();let failure:unknown,spawned=false;const child=execute(binary,[...args],{timeout:2000,killSignal:'SIGKILL',maxBuffer:65536,encoding:'utf8',env:{PATH:path,LC_ALL:'C'}},error=>{failure=error??undefined;});child.once('spawn',()=>{spawned=true;});const abort=()=>child.kill('SIGKILL');signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();child.once('close',()=>{signal.removeEventListener('abort',abort);const error=signal.aborted?signal.reason:failure;if(error!==undefined)reject(spawned?new MachineActionUncertain('Power command was submitted but its result is unconfirmed; do not replay',error):error);else resolve();});
});}
function defaultIO(path:string):NonePowerIO{return {readIdentity:currentPowerIdentity,insideContainer:container,hasSystemctl:signal=>hasSystemctl(path,signal),command:(binary,args,signal)=>nonePowerCommand(binary,args,signal,execFile,path)};}
/** Explicit power capability for a process without a service-manager identity. */
export class NonePowerControl implements MachineControlPort {
 readonly #actions:Set<string>;readonly #guard:MachineDeviceGuard;readonly #io:NonePowerIO;readonly #shutdown:'poweroff'|'halt';readonly #abort=new AbortController();#identity:ProcessPowerIdentity|undefined;#pending:Promise<void>|undefined;#closed:Promise<void>|undefined;
 constructor(options:NonePowerOptions,guard:MachineDeviceGuard,shutdown:'poweroff'|'halt'='poweroff',io:Partial<NonePowerIO>={}){
  validateNonePowerOptions(options);if(!guard||typeof guard.assertDeviceAvailable!=='function'||!['poweroff','halt'].includes(shutdown)||!io||typeof io!=='object'||Array.isArray(io)||Object.keys(io).some(key=>!['readIdentity','insideContainer','hasSystemctl','command'].includes(key))||Object.values(io).some(value=>typeof value!=='function'))throw new TypeError('None power requires a trusted device guard and fixed dependencies');this.#actions=new Set(options.allowedActions);this.#guard=guard;this.#shutdown=shutdown;this.#io={...defaultIO(process.env.PATH??''),...io};
 }
 #checked(action:MachineAction){
  if(this.#abort.signal.aborted)throw new MachineControlError('unavailable','None power control is closed');if(action?.kind==='service'||action?.kind==='server_restart')throw new NoneProviderUnavailable();if(!action||typeof action!=='object'||Array.isArray(action)||Object.keys(action).length!==1||!['reboot','shutdown'].includes(action.kind)||!this.#actions.has(action.kind))throw new MachineControlError('not_allowed','Power action is outside the trusted scope');return action.kind as 'reboot'|'shutdown';
 }
 retirement(action:MachineAction){this.#checked(action);return 'process' as const;}
 #start(signal:AbortSignal,operation:(signal:AbortSignal)=>Promise<void>){
  if(this.#abort.signal.aborted)return Promise.reject(new MachineControlError('unavailable','None power control is closed'));if(this.#pending)return Promise.reject(new MachineControlError('busy','A process power proof or command is pending'));const owned=AbortSignal.any([signal,this.#abort.signal]);if(owned.aborted)return Promise.reject(owned.reason);const pending=Promise.resolve().then(()=>operation(owned)).finally(()=>{if(this.#pending===pending)this.#pending=undefined;});this.#pending=pending;return pending;
 }
 async #current(signal:AbortSignal){
  signal.throwIfAborted();const value=await this.#io.readIdentity(signal);signal.throwIfAborted();if(!value||value.pid!==process.pid||!/^\d{1,32}$/u.test(value.startTicks)||this.#identity&&(value.pid!==this.#identity.pid||value.startTicks!==this.#identity.startTicks))throw new MachineControlError('identity','Current process identity changed');this.#identity??={...value};
 }
 prepare(signal:AbortSignal){return this.#start(signal,s=>this.#current(s));}
 assertDeviceAvailable(signal:AbortSignal){return this.#start(signal,async s=>{await this.#current(s);await this.#guard.assertDeviceAvailable(s);s.throwIfAborted();await this.#current(s);});}
 execute(value:MachineAction,signal:AbortSignal):Promise<void>{
  let action:'reboot'|'shutdown';try{action=this.#checked(value);signal.throwIfAborted();}catch(error){return Promise.reject(error);}return this.#start(signal,async s=>{await this.#current(s);await this.#guard.assertDeviceAvailable(s);s.throwIfAborted();if(await this.#io.insideContainer(s))throw new MachineControlError('container','Operating system control is unavailable inside a container');s.throwIfAborted();const binary:PowerBinary=await this.#io.hasSystemctl(s)?'systemctl':action==='reboot'?'reboot':this.#shutdown;s.throwIfAborted();await this.#current(s);await this.#guard.assertDeviceAvailable(s);s.throwIfAborted();await this.#current(s);await this.#io.command(binary,binary==='systemctl'?['--no-pager','--no-ask-password','--no-block',action==='reboot'?'reboot':this.#shutdown]:[],s);});
 }
 close(){return this.#closed??=(async()=>{this.#abort.abort(new MachineControlError('unavailable','None power control closed'));await this.#pending?.catch(()=>{});})();}
}
