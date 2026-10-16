import {submitLinuxPower,validateMachineControlOptions,MachineControlError,type MachineControlOptions,type MachineControlPort,type MachineAction,type MachineRetirement} from './machine-control.ts';
import {SystemBusOwner} from './system-bus-owner.ts';
const containers=new Set(['openvz','lxc','lxc-libvirt','systemd-nspawn','docker','podman','rkt','wsl','proot','pouch']);
/** A borrowed facade owns admission and its own pending operation only. The
 * process factory closes the shared bus after server/installer shutdown. */
export class SystemdBusControl implements MachineControlPort {
 readonly #bus:SystemBusOwner;readonly #own:string;readonly #allowed:Set<string>;readonly #devices:Set<string>;readonly #shutdown:'poweroff'|'halt';readonly #power:typeof submitLinuxPower;readonly #abort=new AbortController();#pending:Promise<void>|undefined;#closing:Promise<void>|undefined;
 constructor(bus:SystemBusOwner,options:MachineControlOptions,shutdown:'poweroff'|'halt'='poweroff',power:typeof submitLinuxPower=submitLinuxPower){
  if(!(bus instanceof SystemBusOwner)||!['poweroff','halt'].includes(shutdown)||typeof power!=='function')throw new TypeError('Invalid system bus control owner');validateMachineControlOptions(options);this.#bus=bus;this.#own=options.ownUnit;this.#allowed=new Set([options.ownUnit,...options.allowedUnits??[]]);this.#devices=new Set(options.deviceUnits??[]);this.#shutdown=shutdown;this.#power=power;
 }
 #checked(value:MachineAction):MachineAction{
  if(this.#abort.signal.aborted)throw new MachineControlError('unavailable','Machine control is closed');
  if(!value||typeof value!=='object'||Array.isArray(value))throw new MachineControlError('not_allowed','Invalid machine action');
  if(value.kind==='service'){
   if(Object.keys(value).length!==3||Object.keys(value).some(k=>!['kind','action','service'].includes(k))||!['start','stop','restart'].includes(value.action)||typeof value.service!=='string'||!this.#allowed.has(value.service+'.service'))throw new MachineControlError('not_allowed','Service action is not allowed');
   if(value.service+'.service'===this.#own&&value.action!=='restart')throw new MachineControlError('not_allowed','The Moonraker process service supports restart only');return {kind:'service',action:value.action,service:value.service};
  }
  if(Object.keys(value).length!==1||!['server_restart','reboot','shutdown'].includes(value.kind))throw new MachineControlError('not_allowed','Invalid machine action');return {kind:value.kind};
 }
 retirement(value:MachineAction):MachineRetirement{const action=this.#checked(value);if(action.kind!=='service'||action.service+'.service'===this.#own)return 'process';return this.#devices.has(action.service+'.service')||/^klipper(?:[_-]?\d+|_mcu)?\.service$/u.test(action.service+'.service')?'device':'none';}
 #run(signal:AbortSignal,operation:(owned:AbortSignal)=>Promise<void>):Promise<void>{
  try{signal.throwIfAborted();this.#abort.signal.throwIfAborted();if(this.#pending)throw new MachineControlError('busy','A machine command is already pending');}catch(error){return Promise.reject(error);}
  const pending=Promise.resolve().then(()=>operation(AbortSignal.any([signal,this.#abort.signal]))).finally(()=>{if(this.#pending===pending)this.#pending=undefined;});this.#pending=pending;return pending;
 }
 async #identity(signal:AbortSignal){if(await this.#bus.ownUnit(signal)!==this.#own)throw new MachineControlError('identity','Process service identity changed or is unavailable');const proof=await this.#bus.unitProperties(this.#own,signal);if(proof.values.LoadState!=='loaded'||proof.values.MainPID!==process.pid)throw new MachineControlError('identity','Current process service does not own this PID');return proof;}
 assertDeviceAvailable(signal:AbortSignal):Promise<void>{return this.#run(signal,async owned=>{
  const first=await this.#identity(owned);for(const unit of this.#allowed){if(unit===this.#own||!this.#devices.has(unit)&&!/^klipper(?:[_-]?\d+|_mcu)?\.service$/u.test(unit))continue;const proof=await this.#bus.unitProperties(unit,owned);if(!['loaded','not-found'].includes(String(proof.values.LoadState))||!['inactive','failed'].includes(String(proof.values.ActiveState))||proof.values.MainPID!==0)throw new MachineControlError('busy','Another device service has not stopped');}owned.throwIfAborted();if(this.#bus.generation!==first.generation)throw new MachineControlError('identity','Device availability proof changed');
 });}
 execute(value:MachineAction,signal:AbortSignal):Promise<void>{let action:MachineAction;try{action=this.#checked(value);}catch(error){return Promise.reject(error);}return this.#run(signal,async owned=>{
  const identity=await this.#identity(owned);if(action.kind==='reboot'||action.kind==='shutdown'){
   const virt=await this.#bus.virtualization(owned);if(containers.has(virt))throw new MachineControlError('container','Operating system control is unavailable inside a container');const login=await this.#bus.loginAvailable(owned),proof=await this.#identity(owned),power=action.kind==='reboot'?'reboot':this.#shutdown;if(!login){if(this.#bus.generation!==proof.generation)throw new MachineControlError('identity','Power fallback proof changed');await this.#power(power,owned);return;}await this.#bus.power(power,proof.generation,owned);return;
  }
  const unit=action.kind==='service'?action.service+'.service':this.#own,proof=await this.#bus.unitProperties(unit,owned);if(proof.generation!==identity.generation)throw new MachineControlError('identity','Process service proof changed before target submission');if(proof.values.LoadState!=='loaded')throw new MachineControlError('unit','Canonical service is not loaded');await this.#bus.serviceAction(unit,action.kind==='service'?action.action:'restart',proof.generation,owned);
 });}
 close():Promise<void>{return this.#closing??=(async()=>{this.#abort.abort(new MachineControlError('unavailable','Machine control closed'));await this.#pending?.catch(()=>{});})();}
}
