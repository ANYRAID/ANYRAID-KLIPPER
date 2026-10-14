import {SupervisorMachineControl,supervisorCommand} from './supervisor-machine-control.ts';
import {resolveConfigurationPath} from './config-path.ts';
import {ConfigurationReader} from './config-reader.ts';
import {ConfigurationError} from './config-source.ts';
import {linuxServiceSource,type ServiceSource,type ServiceSnapshot,type SystemServicesOptions} from './system-services.ts';
import {LinuxMachineControl,MachineControlError,validateMachineControlOptions,type MachineControlOptions,type MachineControlPort} from './machine-control.ts';
import {SystemBusOwner,type SystemBusOptions,type PolkitAction,type SystemdProperties} from './system-bus-owner.ts';
import {SystemdBusControl} from './systemd-bus-control.ts';
export type MachineProviderName=ServiceSnapshot['provider'];
export interface MachineProviderConfiguration{provider:MachineProviderName;shutdown:'poweroff'|'halt';supervisordConfig:string;}
export function readMachineProvider(reader:ConfigurationReader):MachineProviderConfiguration{
 const machine=reader.section('machine'),provider=machine.getChoice('provider',['none','systemd_cli','systemd_dbus','supervisord_cli'],{defaultValue:'systemd_dbus'}) as MachineProviderName,shutdown=machine.getChoice('shutdown_action',['poweroff','halt'],{defaultValue:'poweroff',forceLowercase:true}) as 'poweroff'|'halt',supervisordConfig=machine.get('supervisord_config_path',{defaultValue:''});
 if(!supervisordConfig.isWellFormed()||Buffer.byteLength(supervisordConfig)>4096||/[\0\r\n]/u.test(supervisordConfig))throw new ConfigurationError('Invalid supervisord configuration path');return {provider,shutdown,supervisordConfig:supervisordConfig?resolveConfigurationPath(supervisordConfig):''};
}
export interface MachineProviderOptions{bus?:SystemBusOptions;control?:MachineControlOptions;}
const empty:ServiceSource=async signal=>{signal.throwIfAborted();return {provider:'none',available_services:[],service_state:{},instance_ids:{moonraker:'',klipper:''}};};
function supervisorSource(config:string,allowedUnits:readonly string[]):ServiceSource{
 const allowed=new Set(allowedUnits.map(unit=>unit.slice(0,-8)));return async signal=>{const output=await supervisorCommand(config,['status'],signal),states:ServiceSnapshot['service_state']={};signal.throwIfAborted();for(const line of output.trim().split('\n')){if(!line)continue;const row=/^([A-Za-z0-9][A-Za-z0-9_.@-]{0,239})\s+(STOPPED|STARTING|RUNNING|BACKOFF|STOPPING|EXITED|FATAL|UNKNOWN)(?:\s+.*)?$/u.exec(line);if(!row)throw new Error('Invalid supervisor service state');if(!allowed.has(row[1])&&!/^(?:moonraker|klipper)(?:[_-]?\d+)?$/u.test(row[1]))continue;states[row[1]]={active_state:row[2]==='RUNNING'?'active':row[2]==='STOPPING'?'deactivating':'inactive',sub_state:row[2].toLowerCase()};if(Object.keys(states).length>64)throw new Error('Supervisor catalogue exceeds capacity');}return {provider:'supervisord_cli',available_services:Object.keys(states),service_state:states,instance_ids:{moonraker:'',klipper:''}};};
}
/** Explicit trusted composition creates one owner per configuration generation.
 * Configuration selects transport behavior; only control descriptors grant writes. */
export class MachineSystemProvider {
 readonly configuration:MachineProviderConfiguration;readonly services:SystemServicesOptions;readonly control:MachineControlPort|undefined;readonly bus:SystemBusOwner|undefined;#unavailable=false;#permissionEpoch='';#permissions:Partial<Record<PolkitAction,boolean|'unavailable'>>={};#closed:Promise<void>|undefined;
 constructor(reader:ConfigurationReader,options:MachineProviderOptions={},nativeCombined=false){
  this.configuration=readMachineProvider(reader);if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['bus','control'].includes(key)))throw new TypeError('Invalid machine provider capabilities');if(options.control)validateMachineControlOptions(options.control);if(options.bus&&this.configuration.provider!=='systemd_dbus')throw new TypeError('A system bus capability requires the systemd_dbus provider');
  const allowed=options.control?[options.control.ownUnit,...options.control.allowedUnits??[]]:options.bus?.allowedUnits;
  switch(this.configuration.provider){
   case 'systemd_dbus':{this.bus=new SystemBusOwner({...options.bus,...allowed?{allowedUnits:[...new Set(allowed)]}:{}});const bus=this.bus;this.services={provider:'systemd_dbus',source:async signal=>{await this.prepare(signal);return bus.snapshot(signal,nativeCombined);},subscribeInvalidation:observer=>bus.observeInvalidation(observer)};if(options.control)this.control=new SystemdBusControl(bus,options.control,this.configuration.shutdown);break;}
   case 'systemd_cli':this.services={provider:'systemd_cli',source:linuxServiceSource({allowedUnits:allowed,nativeCombined})};if(options.control)this.control=new LinuxMachineControl(options.control,{},this.configuration.shutdown);break;
   case 'none':this.services={provider:'none',source:empty};if(options.control){const power=new LinuxMachineControl(options.control,{},this.configuration.shutdown),check=(action:Parameters<MachineControlPort['retirement']>[0])=>{if(!action||!['reboot','shutdown'].includes(action.kind)||Object.keys(action).length!==1)throw new MachineControlError('not_allowed','The none provider exposes reboot and shutdown only');};this.control={retirement:action=>{check(action);return power.retirement(action);},execute:(action,signal)=>{try{check(action);}catch(error){return Promise.reject(error);}return power.execute(action,signal);},assertDeviceAvailable:signal=>power.assertDeviceAvailable(signal),close:()=>power.close()};}break;
   case 'supervisord_cli':this.services={provider:'supervisord_cli',source:supervisorSource(this.configuration.supervisordConfig,allowed??[])};if(options.control)this.control=new SupervisorMachineControl(options.control,this.configuration.supervisordConfig,this.configuration.shutdown);break;
  }
 }
 get permissions(){return {...this.#permissions};}
 get warnings(){return this.#unavailable?['System bus connection unavailable; service tracking and D-Bus actions have no current proof']:Object.entries(this.#permissions).filter(([,value])=>value!==true).map(([action])=>'Initial PolicyKit permission diagnostic unavailable or denied: '+action);}
 async prepare(signal:AbortSignal):Promise<void>{if(!this.bus)return;try{await this.bus.ready(signal);this.#unavailable=false;}catch{signal.throwIfAborted();this.#unavailable=true;return;}const epoch=this.bus.status.connection_epoch+':'+this.bus.status.permission_epoch;if(this.#permissionEpoch===epoch)return;const actions:PolkitAction[]=['org.freedesktop.systemd1.manage-units','org.freedesktop.login1.reboot','org.freedesktop.login1.reboot-multiple-sessions',...this.configuration.shutdown==='halt'?['org.freedesktop.login1.halt','org.freedesktop.login1.halt-multiple-sessions'] as const:['org.freedesktop.login1.power-off','org.freedesktop.login1.power-off-multiple-sessions'] as const];const permissions:Partial<Record<PolkitAction,boolean|'unavailable'>>={};for(const action of actions)try{permissions[action]=await this.bus.permission(action,signal);}catch{signal.throwIfAborted();permissions[action]='unavailable';}this.#permissions=permissions;this.#permissionEpoch=epoch;}
 async installationProperties(signal:AbortSignal):Promise<SystemdProperties>{if(!this.bus)throw new MachineControlError('unavailable','This provider has no D-Bus installation property owner');return this.bus.unitProperties(await this.bus.ownUnit(signal),signal);}
 close():Promise<void>{return this.#closed??=(async()=>{try{await this.control?.close();}finally{await this.bus?.close();}})();}
}
