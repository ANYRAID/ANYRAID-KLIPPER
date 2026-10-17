import dbus from 'dbus-native';
import net from 'node:net';
import {open,lstat} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {MachineControlError} from './machine-control.ts';
import type {ServiceSnapshot} from './system-services.ts';
import {packageKitName,packageKitInterface,packageKitActions,packageKitCall,packageKitId,packageKitBits,PackageKitError,type PackageKitAction,type PackageKitRequest,type PackageKitPackage,type PackageKitHooks,type PackageKitProgress} from './packagekit-protocol.ts';

type Bus=ReturnType<typeof dbus.createClient>;
const systemd='org.freedesktop.systemd1',manager='/org/freedesktop/systemd1',properties='org.freedesktop.DBus.Properties';
const unitPattern=/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,239}\.service$/u;
const objectPath=/^\/(?:[A-Za-z0-9_]+\/)*[A-Za-z0-9_]*$/u;
const uniqueName=/^:[0-9]+\.[0-9]+$/u;
const allowedDefault=(unit:string)=>/^(?:moonraker|klipper)(?:[_-]?\d+)?\.service$/u.test(unit)||unit==='anyraid-node-product-host.service';
export interface SystemBusOptions {
 /** Trusted composition only. The default is the fixed system Unix socket;
  * tests supply a private real daemon path. No address string or executable. */
 socket?:string;allowedUnits?:readonly string[];
}
export class SystemBusActionUncertain extends MachineControlError {
 readonly outcome='unknown';
 constructor(){super('command','System bus action was submitted but its result is unconfirmed; do not replay');}
}
export type SystemdProperties={generation:number;path:string;values:Record<string,unknown>;identity:{connection:number;owner:number;revision:number}};
export type PolkitAction='org.freedesktop.systemd1.manage-units'|'org.freedesktop.login1.power-off'|'org.freedesktop.login1.power-off-multiple-sessions'|'org.freedesktop.login1.halt'|'org.freedesktop.login1.halt-multiple-sessions'|'org.freedesktop.login1.reboot'|'org.freedesktop.login1.reboot-multiple-sessions';
const selectedProperties=new Set(['Id','LoadState','ActiveState','SubState','MainPID','FragmentPath','Description','User','Group','ExecStart','WorkingDirectory','EnvironmentFiles','SupplementaryGroups','After','Requires']);
/** One process owns the connection. Facades borrow it; only final process
 * closure or a rejected configuration generation closes this owner. */
export class SystemBusOwner {
 readonly #socket:string;readonly #allowed:Set<string>;readonly #abort=new AbortController();
 #bus:Bus|undefined;#opening:Promise<void>|undefined;#retired:Promise<void>|undefined;#closing:Promise<void>|undefined;
 #transportClosed=true;#connectionEpoch=0;#ownerEpoch=new Map<string,number>();#owners=new Map<string,string>();#unitPaths=new Set<string>();#closeConnection:(()=>Promise<void>)|undefined;
 #subscription:{key:string;promise:Promise<void>}|undefined;#installationRevision=new Map<string,number>();#generation=0;#ownUnit:string|undefined;#pending=new Set<Promise<unknown>>();#observers=new Set<()=>void>();#matched=new Set<string>();#matching=new Map<string,Promise<void>>();#packageSignals=new Set<(message:Record<string,unknown>)=>void>();#packagePaths=new Set<string>();
 constructor(options:SystemBusOptions={}){
  if(!options||typeof options!=='object'||Object.keys(options).some(k=>!['socket','allowedUnits'].includes(k)))throw new TypeError('Invalid system bus options');
  const socket=options.socket??'/run/dbus/system_bus_socket';
  if(typeof socket!=='string'||!isAbsolute(socket)||resolve(socket)!==socket||!socket.isWellFormed()||/[\0\r\n]/u.test(socket)||Buffer.byteLength(socket)>100)throw new TypeError('System bus requires one canonical Unix socket path');
  if(options.allowedUnits!==undefined&&(!Array.isArray(options.allowedUnits)||options.allowedUnits.length>64||options.allowedUnits.some(u=>typeof u!=='string'||!unitPattern.test(u))||new Set(options.allowedUnits).size!==options.allowedUnits.length))throw new TypeError('Invalid system bus service catalogue');
  this.#socket=socket;this.#allowed=new Set(options.allowedUnits??[]);
 }
 installationCurrent(proof:SystemdProperties){return this.status.ready&&proof.identity.connection===this.#connectionEpoch&&proof.identity.owner===(this.#ownerEpoch.get(systemd)??0)&&proof.identity.revision===(this.#installationRevision.get(proof.path)??0)&&this.#unitPaths.has(proof.path);}
 get generation(){return this.#generation;}
 get status(){return {generation:this.#generation,connection_epoch:this.#connectionEpoch,permission_epoch:this.#ownerEpoch.get('org.freedesktop.PolicyKit1')??0,ready:!!this.#bus?.name&&!this.#abort.signal.aborted,closed:this.#abort.signal.aborted,pending:this.#pending.size,transport_closed:this.#transportClosed};}
 observeInvalidation(observer:()=>void){this.#observers.add(observer);return ()=>{this.#observers.delete(observer);};}
 #invalidate(){this.#generation++;this.#ownUnit=undefined;for(const observer of this.#observers)try{observer();}catch{}}
 #track<T>(promise:Promise<T>):Promise<T>{this.#pending.add(promise);void promise.then(()=>this.#pending.delete(promise),()=>this.#pending.delete(promise));return promise;}
 #retireConnection(bus:Bus,closeConnection:()=>Promise<void>):Promise<void>{
  if(this.#bus!==bus)return this.#retired??Promise.resolve();this.#bus=undefined;this.#opening=undefined;this.#matched.clear();this.#matching.clear();this.#unitPaths.clear();this.#installationRevision.clear();this.#owners.clear();this.#subscription=undefined;this.#connectionEpoch++;this.#invalidate();this.#retired=closeConnection();return this.#retired;
 }
 async ready(signal:AbortSignal):Promise<number>{
  signal.throwIfAborted();this.#abort.signal.throwIfAborted();
  if(!this.#opening){const opening=this.#connect().catch(error=>{if(this.#opening===opening)this.#opening=undefined;throw error;});this.#opening=opening;}
  await this.#opening;signal.throwIfAborted();this.#abort.signal.throwIfAborted();if(!this.#bus?.name)throw new MachineControlError('unavailable','System bus Hello is not ready');return this.#generation;
 }
 async #connect(){
  await this.#retired;this.#abort.signal.throwIfAborted();const socket=await lstat(this.#socket);
  if(!socket.isSocket()||socket.isSymbolicLink()||socket.uid!==0&&socket.uid!==process.getuid!())throw new MachineControlError('unavailable','System bus socket identity rejected');
  this.#abort.signal.throwIfAborted();const transport=net.createConnection({path:this.#socket}),transportClosed=Promise.withResolvers<void>();this.#transportClosed=false;transport.once('close',()=>{this.#transportClosed=true;transportClosed.resolve();});transport.on('error',()=>{});
  let bus:Bus;try{bus=dbus.createClient({stream:transport,authMethods:['EXTERNAL'],direct:true,reconnect:false,returnBigInt:true,variants:'wrap',maxMessageSize:1048576,timeout:2000});}catch(error){transport.destroy();await transportClosed.promise;throw error;}
  let closing:Promise<void>|undefined;const closeConnection=()=>closing??=(async()=>{let libraryClose:Promise<void>|undefined;try{libraryClose=Promise.resolve(bus.close());}finally{transport.destroy();await transportClosed.promise;}await libraryClose;})();this.#closeConnection=closeConnection;this.#bus=bus;this.#connectionEpoch++;this.#generation++;
  const disconnected=()=>{void this.#retireConnection(bus,closeConnection).catch(()=>{});};
  bus.on('error',disconnected);bus.connection.on('end',disconnected);
  bus.connection.on('message',(value:unknown)=>this.#signal(bus,value));
  try{
   // The library's automatic Hello can throw from an asynchronous callback.
   // Own the explicit Hello promise and retire its connection on any failure.
   const name:unknown=await this.#wire(bus,{destination:'org.freedesktop.DBus',path:'/org/freedesktop/DBus',interface:'org.freedesktop.DBus',member:'Hello',signature:'',body:[]},this.#abort.signal,'org.freedesktop.DBus');
   this.#abort.signal.throwIfAborted();if(this.#bus!==bus||typeof name!=='string'||!uniqueName.test(name))throw new MachineControlError('unavailable','Invalid system bus unique name');bus.name=name;
   for(const name of [systemd,'org.freedesktop.PolicyKit1','org.freedesktop.login1'])await this.#match(bus,`type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${name}'`);
  }catch(error){if(this.#bus===bus){this.#bus=undefined;this.#matched.clear();this.#matching.clear();this.#unitPaths.clear();this.#installationRevision.clear();this.#owners.clear();this.#subscription=undefined;this.#connectionEpoch++;this.#invalidate();}this.#retired=closeConnection();await this.#retired;throw error;}
 }
 #wire(bus:Bus,message:Parameters<Bus['invoke']>[0],signal:AbortSignal,sender:string):Promise<unknown>{
  const signatures:Record<string,string>={Hello:'s',Introspect:'s',GetNameOwner:'s',AddMatch:'',RemoveMatch:'',Subscribe:'',GetUnit:'o',GetUnitByPID:'o',GetAll:'a{sv}',Get:'v',ListUnitsFiltered:'a(ssssssouso)',CheckAuthorization:'(bba{ss})',StartUnit:'o',StopUnit:'o',RestartUnit:'o',PowerOff:'',Halt:'',Reboot:'',CreateTransaction:'o',GetUpdates:'',Resolve:'',RefreshCache:'',InstallPackages:'',UpdatePackages:'',Cancel:''};
  const expected=message.member?signatures[message.member]:undefined;if(expected===undefined)return Promise.reject(new MachineControlError('not_allowed','Unknown typed bus method'));
  return new Promise((resolve,reject)=>{bus.invoke(message,{signal,timeout:2000},function(this:{message?:dbus.Message}|undefined,error,...values){
   const reply=this?.message;
   if(error){if(reply&&reply.sender!==sender&&reply.sender!=='org.freedesktop.DBus')reject(new MachineControlError('identity','Untrusted bus error sender'));else reject(error);return;}
   if(!reply||reply.type!==2||reply.sender!==sender||(reply.signature??'')!==expected){reject(new MachineControlError('identity','Untrusted bus reply sender or signature'));return;}
   resolve(values.length===1?values[0]:values);
  });});
 }
 async #match(bus:Bus,rule:string){if(this.#matched.has(rule))return;let registration=this.#matching.get(rule);if(!registration){registration=(async()=>{await this.#wire(bus,{destination:'org.freedesktop.DBus',path:'/org/freedesktop/DBus',interface:'org.freedesktop.DBus',member:'AddMatch',signature:'s',body:[rule]},this.#abort.signal,'org.freedesktop.DBus');if(this.#bus!==bus)throw new MachineControlError('identity','System bus changed during subscription');this.#matched.add(rule);})();this.#matching.set(rule,registration);const owned=registration;void registration.then(()=>{if(this.#matching.get(rule)===owned)this.#matching.delete(rule);},()=>{if(this.#matching.get(rule)===owned)this.#matching.delete(rule);});}await registration;}
 async #subscribe(signal:AbortSignal){
  await this.ready(signal);const bus=this.#bus!,owner=await this.#owner(bus,systemd,signal),key=this.#connectionEpoch+':'+(this.#ownerEpoch.get(systemd)??0)+':'+owner;
  if(this.#subscription?.key!==key){const promise=(async()=>{await this.#match(bus,`type='signal',sender='${systemd}',interface='${properties}',member='PropertiesChanged'`);await this.#invoke(systemd,manager,systemd+'.Manager','Subscribe','',[],this.#abort.signal,false,undefined,true);if(this.#bus!==bus||key!==this.#connectionEpoch+':'+(this.#ownerEpoch.get(systemd)??0)+':'+this.#owners.get(systemd))throw new MachineControlError('identity','Systemd subscription owner changed');})();const subscription={key,promise};this.#subscription=subscription;void promise.catch(()=>{if(this.#subscription===subscription)this.#subscription=undefined;});}
  await this.#subscription.promise;signal.throwIfAborted();
 }
 async #owner(bus:Bus,name:string,signal:AbortSignal):Promise<string>{
  const existing=this.#owners.get(name);if(existing)return existing;const epoch=this.#ownerEpoch.get(name)??0,connection=this.#connectionEpoch;
  const owner:unknown=await this.#wire(bus,{destination:'org.freedesktop.DBus',path:'/org/freedesktop/DBus',interface:'org.freedesktop.DBus',member:'GetNameOwner',signature:'s',body:[name]},AbortSignal.any([signal,this.#abort.signal]),'org.freedesktop.DBus');
  if(this.#bus!==bus||connection!==this.#connectionEpoch||epoch!==(this.#ownerEpoch.get(name)??0)||typeof owner!=='string'||!uniqueName.test(owner))throw new MachineControlError('identity','Service bus owner changed');this.#owners.set(name,owner);return owner;
 }
 #signal(bus:Bus,value:unknown){
  if(this.#bus!==bus||!value||typeof value!=='object')return;const message=value as Record<string,unknown>;
  if(message.type!==4||!Array.isArray(message.body))return;
  if(message.sender==='org.freedesktop.DBus'&&message.path==='/org/freedesktop/DBus'&&message.interface==='org.freedesktop.DBus'&&message.member==='NameOwnerChanged'&&message.body.length===3&&[systemd,'org.freedesktop.PolicyKit1','org.freedesktop.login1',packageKitName].includes(String(message.body[0]))){
   const [name,old,next]=message.body;if(typeof name!=='string'||typeof old!=='string'||typeof next!=='string'||old!==''&&!uniqueName.test(old)||next!==''&&!uniqueName.test(next))return;
   this.#ownerEpoch.set(name,(this.#ownerEpoch.get(name)??0)+1);if(next)this.#owners.set(name,next);else this.#owners.delete(name);if(name===systemd){this.#unitPaths.clear();this.#installationRevision.clear();this.#subscription=undefined;}this.#invalidate();return;
  }
  for(const listener of this.#packageSignals)listener(message);
  if(message.interface===properties&&message.member==='PropertiesChanged'&&message.sender===this.#owners.get(systemd)&&typeof message.path==='string'&&this.#unitPaths.has(message.path)){
   const [iface,changed,invalidated]=message.body;const valid=(iface===systemd+'.Unit'||iface===systemd+'.Service')&&changed&&typeof changed==='object'&&!Array.isArray(changed)&&Array.isArray(invalidated)&&invalidated.every(key=>typeof key==='string');
   if(!valid||[...Object.keys(changed as object),...invalidated as string[]].some(key=>selectedProperties.has(key)&&!['ActiveState','SubState'].includes(key)))this.#installationRevision.set(message.path,(this.#installationRevision.get(message.path)??0)+1);
   this.#invalidate();
  }
 }
 async #invoke(destination:string,path:string,iface:string,member:string,signature:string,body:unknown[],signal:AbortSignal,mutation=false,expected?:number,revisionIndependent=false):Promise<unknown>{
  return this.#track((async()=>{
   const generation=await this.ready(signal),bus=this.#bus!,connection=this.#connectionEpoch,owner=await this.#owner(bus,destination,signal);const ownerEpoch=this.#ownerEpoch.get(destination)??0;
   if(expected!==undefined&&generation!==expected)throw new MachineControlError('identity','System bus proof generation changed');
   signal.throwIfAborted();this.#abort.signal.throwIfAborted();if(this.#bus!==bus||this.#generation!==generation)throw new MachineControlError('identity','System bus generation changed before submission');
   // No await between the final checks and submission. After this boundary
   // Abort/timeout/disconnect cannot mean the OS action was not executed.
   let submitted=false;
   try{const pending=this.#wire(bus,{destination:owner,path,interface:iface,member,signature,body},AbortSignal.any([signal,this.#abort.signal]),owner);submitted=true;const result:unknown=await Promise.resolve(pending);if(this.#bus!==bus||this.#connectionEpoch!==connection||ownerEpoch!==(this.#ownerEpoch.get(destination)??0)||!mutation&&!revisionIndependent&&this.#generation!==generation)throw new MachineControlError('identity','System bus changed while waiting for reply');return result;}
   catch(error){if(mutation&&submitted)throw new SystemBusActionUncertain();throw error;}
  })());
 }
 async #path(member:'GetUnit'|'GetUnitByPID',signature:'s'|'u',body:unknown[],signal:AbortSignal){const value=await this.#invoke(systemd,manager,systemd+'.Manager',member,signature,body,signal);if(typeof value!=='string'||!objectPath.test(value))throw new MachineControlError('unit','Invalid systemd unit path');return value;}
 async #properties(path:string,iface:string,signal:AbortSignal){
  const value=await this.#invoke(systemd,path,properties,'GetAll','s',[iface],signal);if(!value||typeof value!=='object'||Array.isArray(value))throw new MachineControlError('unit','Invalid systemd properties');
  const selected:Record<string,unknown>=Object.create(null);for(const [key,item] of Object.entries(value))if(selectedProperties.has(key)){if(!item||typeof item!=='object'||!('signature' in item)||!('value' in item))throw new MachineControlError('unit','Invalid systemd property variant');selected[key]=item.value;}return selected;
 }
 async ownUnit(signal:AbortSignal):Promise<string>{
  await this.#subscribe(signal);
  const generation=await this.ready(signal),path=await this.#path('GetUnitByPID','u',[process.pid],signal),values=await this.#properties(path,systemd+'.Unit',signal);
  if(generation!==this.#generation||typeof values.Id!=='string'||!unitPattern.test(values.Id)||values.LoadState!=='loaded')throw new MachineControlError('identity','Current process systemd identity is unavailable');this.#ownUnit=values.Id;return values.Id;
 }
 async unitProperties(unit:string,signal:AbortSignal):Promise<SystemdProperties>{
  if(!unitPattern.test(unit))throw new MachineControlError('unit','Invalid service unit');await this.#subscribe(signal);const generation=await this.ready(signal),path=await this.#path('GetUnit','s',[unit],signal),bus=this.#bus!;
  // One well-known sender rule survives owner replacement; received messages
  // still require the resolved unique sender and a subscribed unit path.
  if(!this.#unitPaths.has(path)&&this.#unitPaths.size>=65)throw new MachineControlError('unit','Service subscriptions exceed capacity');
  this.#unitPaths.add(path);await this.#match(bus,`type='signal',sender='${systemd}',interface='${properties}',member='PropertiesChanged'`);
  const base=await this.#properties(path,systemd+'.Unit',signal),service=await this.#properties(path,systemd+'.Service',signal);
  if(generation!==this.#generation||base.Id!==unit||service.Id!==undefined&&service.Id!==unit)throw new MachineControlError('identity','Service identity or generation changed');return {generation,path,values:{...base,...service},identity:{connection:this.#connectionEpoch,owner:this.#ownerEpoch.get(systemd)??0,revision:this.#installationRevision.get(path)??0}};
 }
 async snapshot(signal:AbortSignal,nativeCombined=false):Promise<ServiceSnapshot>{
  const generation=await this.ready(signal);let own:string|undefined;try{own=await this.ownUnit(signal);}catch(error){if(!(error instanceof MachineControlError&&error.code==='identity')&&!(error instanceof dbus.DBusError&&error.dbusName==='org.freedesktop.systemd1.NoUnitForPID'))throw error;}
  const list=await this.#invoke(systemd,manager,systemd+'.Manager','ListUnitsFiltered','as',[['loaded']],signal);
  if(!Array.isArray(list)||list.length>4096)throw new MachineControlError('unit','Invalid service list');const units=new Set<string>(own?[own]:[]);
  for(const row of list){if(!Array.isArray(row)||row.length!==10||typeof row[0]!=='string')throw new MachineControlError('unit','Invalid service list row');if(unitPattern.test(row[0])&&(allowedDefault(row[0])||this.#allowed.has(row[0])))units.add(row[0]);}
  if(units.size>64)throw new MachineControlError('unit','Service catalogue exceeds capacity');const states:ServiceSnapshot['service_state']={};
  for(const unit of [...units].sort()){const {values}=await this.unitProperties(unit,signal);if(values.LoadState!=='loaded')continue;if(typeof values.ActiveState!=='string'||typeof values.SubState!=='string'||![values.ActiveState,values.SubState].every(s=>/^[a-z][a-z0-9-]{0,63}$/u.test(s)))throw new MachineControlError('unit','Invalid service state');states[unit.slice(0,-8)]={active_state:values.ActiveState,sub_state:values.SubState};}
  if(generation!==this.#generation)throw new MachineControlError('identity','Service snapshot invalidated while reading');return {provider:'systemd_dbus',available_services:Object.keys(states),service_state:states,instance_ids:{moonraker:own?.slice(0,-8)??'',klipper:nativeCombined&&own?own.slice(0,-8):''}};
 }
 async permission(action:PolkitAction,signal:AbortSignal):Promise<boolean>{
  if(!['org.freedesktop.systemd1.manage-units','org.freedesktop.login1.power-off','org.freedesktop.login1.power-off-multiple-sessions','org.freedesktop.login1.halt','org.freedesktop.login1.halt-multiple-sessions','org.freedesktop.login1.reboot','org.freedesktop.login1.reboot-multiple-sessions'].includes(action))throw new MachineControlError('not_allowed','Unknown machine Polkit action');
  return this.#permission(action,signal);
 }
 async packageKitPermission(action:PackageKitAction,signal:AbortSignal):Promise<boolean>{if(!packageKitActions.includes(action))throw new MachineControlError('not_allowed','Unknown package Polkit action');return this.#permission(action,signal);}
 async #permission(action:string,signal:AbortSignal):Promise<boolean>{
  const file=await open('/proc/self/stat','r');let text:string;try{const buffer=Buffer.alloc(65537),{bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead===buffer.length)throw new Error('Process identity exceeds capacity');text=buffer.subarray(0,bytesRead).toString();}finally{await file.close();}
  const index=text.lastIndexOf(')'),start=text.slice(index+2).trim().split(/\s+/u)[19];if(index<0||!start||!/^\d+$/u.test(start))throw new MachineControlError('identity','Invalid process start time');
  const result=await this.#invoke('org.freedesktop.PolicyKit1','/org/freedesktop/PolicyKit1/Authority','org.freedesktop.PolicyKit1.Authority','CheckAuthorization','(sa{sv})sa{ss}us',[['unix-process',{pid:new dbus.Variant('u',process.pid),'start-time':new dbus.Variant('t',BigInt(start))}],action,{},0,''],signal);
  if(!Array.isArray(result)||result.length!==3||typeof result[0]!=='boolean'||typeof result[1]!=='boolean')throw new MachineControlError('unavailable','Invalid authorization reply');return result[0];
 }
 /** Trusted package consumer only; no arbitrary destination, flags or method.
  * Subscriptions precede submission; a method reply alone is never completion. */
 packageKit(request:PackageKitRequest,signal:AbortSignal,hooks:PackageKitHooks={},timeoutMs=600000):Promise<PackageKitPackage[]>{
  const call=packageKitCall(request);if(call.mutation&&(typeof hooks.beforeSubmit!=='function'||typeof hooks.submitted!=='function'))throw new TypeError('PackageKit mutation requires durable owner hooks');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000)throw new TypeError('Invalid PackageKit deadline');
  return this.#track(this.#packageTransaction(request,call,signal,hooks,timeoutMs));
 }
 async #packageReady(signal:AbortSignal){await this.ready(signal);await this.#match(this.#bus!,`type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${packageKitName}'`);signal.throwIfAborted();}
 async packageKitAvailable(signal:AbortSignal):Promise<void>{await this.#packageReady(signal);const xml=await this.#invoke(packageKitName,'/org/freedesktop/PackageKit','org.freedesktop.DBus.Introspectable','Introspect','',[],signal);if(typeof xml!=='string'||Buffer.byteLength(xml)>1048576||!/<interface\s+name\s*=\s*['"]org\.freedesktop\.PackageKit['"]/u.test(xml))throw new PackageKitError('interface-unavailable');}
 async #packageTransaction(request:PackageKitRequest,call:ReturnType<typeof packageKitCall>,signal:AbortSignal,hooks:PackageKitHooks,timeoutMs:number):Promise<PackageKitPackage[]>{
  const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new PackageKitError('timeout','unknown')),timeoutMs);timer.unref();
  const active=AbortSignal.any([signal,this.#abort.signal,deadline.signal]),finished=Promise.withResolvers<void>();void finished.promise.catch(()=>{});
  let bus:Bus|undefined,path:string|undefined,transactionSender:string|undefined,submitted=false,terminal=false,errorCode:string|undefined,remove:()=>void=()=>{},listener:((message:Record<string,unknown>)=>void)|undefined,association:Promise<void>|undefined;const rules:string[]=[],result:PackageKitPackage[]=[];let bytes=0,signals=0,notifications=0,lastNotify=-Infinity;
  const abort=()=>finished.reject(new PackageKitError('cancelled','unknown'));active.addEventListener('abort',abort,{once:true});
  try{
   await this.#packageReady(active);bus=this.#bus!;const connection=this.#connectionEpoch,owner=await this.#owner(bus,packageKitName,active),epoch=this.#ownerEpoch.get(packageKitName)??0,permission=this.#ownerEpoch.get('org.freedesktop.PolicyKit1')??0;
   const current=()=>this.#bus===bus&&connection===this.#connectionEpoch&&epoch===(this.#ownerEpoch.get(packageKitName)??0)&&owner===this.#owners.get(packageKitName)&&permission===(this.#ownerEpoch.get('org.freedesktop.PolicyKit1')??0);
   transactionSender=owner;remove=this.observeInvalidation(()=>{if(!current())finished.reject(new PackageKitError('owner-changed','unknown'));});
   if(call.mutation){const action=request.method==='RefreshCache'?packageKitActions[0]:request.method==='InstallPackages'?packageKitActions[1]:packageKitActions[2];if(!await this.packageKitPermission(action,active))throw new PackageKitError('permission-denied');if(!current())throw new PackageKitError('owner-changed');}
   const value=await this.#wire(bus,{destination:owner,path:'/org/freedesktop/PackageKit',interface:packageKitName,member:'CreateTransaction',signature:'',body:[]},active,owner);
   if(typeof value!=='string'||!/^\/[0-9]+_[A-Za-z0-9_]+$/u.test(value)||value.length>200||!current()||this.#packagePaths.has(value)||this.#packagePaths.size>=4)throw new PackageKitError('transaction-identity');path=value;this.#packagePaths.add(path);
   listener=message=>{
    if(!submitted||!current()||message.sender!==owner||message.path!==path||terminal)return;
    const body=message.body as unknown[];if(++signals>32768){finished.reject(new PackageKitError('signal-capacity','unknown'));return;}
    try{
     if(message.interface===packageKitInterface){
      switch(message.member){
       case 'Package':if(message.signature!=='uss'||body.length!==3||!Number.isInteger(body[0])||!packageKitId(body[1])||typeof body[2]!=='string'||!body[2].isWellFormed()||Buffer.byteLength(body[2])>8192)throw new PackageKitError('invalid-package','unknown');bytes+=Buffer.byteLength(body[1])+Buffer.byteLength(body[2]);if(result.length>=4096||bytes>4*1024*1024)throw new PackageKitError('result-capacity','unknown');result.push({info:body[0] as number,package_id:body[1],summary:body[2]});break;
       case 'ErrorCode':if(message.signature!=='us'||body.length!==2||!Number.isInteger(body[0])||typeof body[1]!=='string'||Buffer.byteLength(body[1])>8192)throw new PackageKitError('invalid-error','unknown');errorCode='error-'+String(body[0]);break;
       case 'Finished':if(message.signature!=='uu'||body.length!==2||!body.every(v=>Number.isInteger(v)))throw new PackageKitError('invalid-finished','unknown');terminal=true;if(body[0]!==packageKitBits.success||errorCode)finished.reject(new PackageKitError(errorCode??'exit-'+String(body[0])));else finished.resolve();break;
      }
     }else if(message.interface===properties&&message.member==='PropertiesChanged'){
      if(message.signature!=='sa{sv}as'||body.length!==3||body[0]!==packageKitInterface||!body[1]||typeof body[1]!=='object'||Array.isArray(body[1])||!Array.isArray(body[2])||body[2].some(v=>typeof v!=='string'))throw new PackageKitError('invalid-progress','unknown');
      const progress:PackageKitProgress={};for(const [key,v] of Object.entries(body[1])){if(!['Percentage','Status','Speed','DownloadSizeRemaining'].includes(key))continue;const variant=v as {signature?:string;value?:unknown};if(key==='Percentage'||key==='Status'){if(variant?.signature!=='u'||!Number.isInteger(variant.value)||Number(variant.value)<0||key==='Percentage'&&Number(variant.value)>101)throw new PackageKitError('invalid-progress','unknown');if(key==='Percentage')progress.percentage=Number(variant.value);else progress.status=Number(variant.value);}else{if(variant?.signature!=='t'||typeof variant.value!=='bigint'||variant.value<0n)throw new PackageKitError('invalid-progress','unknown');if(key==='Speed')progress.speed=String(variant.value);else progress.download_remaining=String(variant.value);}}
      if(hooks.progress&&notifications<256&&performance.now()-lastNotify>=100){notifications++;lastNotify=performance.now();try{hooks.progress(progress);}catch{}}
     }
    }catch(error){finished.reject(error);}
   };this.#packageSignals.add(listener);
   for(const iface of [packageKitInterface,properties]){const rule=`type='signal',sender='${owner}',path='${path}',interface='${iface}'`;await this.#match(bus,rule);rules.push(rule);}
   active.throwIfAborted();if(!current())throw new PackageKitError('owner-changed');
   if(hooks.beforeSubmit){association=Promise.resolve().then(()=>hooks.beforeSubmit!({path:path!,connection,owner:epoch,sender:owner},active));await Promise.race([association,finished.promise]);}
   active.throwIfAborted();if(!current())throw new PackageKitError('owner-changed');
   // The callback is synchronous: no await between the final checks and wire submission.
   hooks.submitted?.();const reply=this.#wire(bus,{destination:owner,path,interface:packageKitInterface,member:request.method,signature:call.signature,body:call.body},active,owner);submitted=true;
   await Promise.all([reply,finished.promise]);if(!current())throw new PackageKitError('owner-changed','unknown');return result;
  }catch(error){if(error instanceof PackageKitError&&terminal)throw error;throw new PackageKitError(error instanceof PackageKitError?error.code:active.aborted?'cancelled':'transport',call.mutation&&submitted?'unknown':'failed');}
  finally{
   clearTimeout(timer);active.removeEventListener('abort',abort);remove();if(listener)this.#packageSignals.delete(listener);
   // An accepted DB write is owned and drained, even after the admission deadline.
   if(association)await Promise.allSettled([association]);
   if(bus&&this.#bus===bus&&path&&submitted&&!terminal){try{if(transactionSender&&transactionSender===this.#owners.get(packageKitName))await this.#wire(bus,{destination:transactionSender,path,interface:packageKitInterface,member:'Cancel',signature:'',body:[]},this.#abort.signal,transactionSender);}catch{}}
   for(const rule of rules){if(bus&&this.#bus===bus)try{await this.#wire(bus,{destination:'org.freedesktop.DBus',path:'/org/freedesktop/DBus',interface:'org.freedesktop.DBus',member:'RemoveMatch',signature:'s',body:[rule]},this.#abort.signal,'org.freedesktop.DBus');}catch{await this.#retireConnection(bus,this.#closeConnection!);break;}this.#matched.delete(rule);}
   if(path)this.#packagePaths.delete(path);
  }
 }
 async serviceAction(unit:string,action:'start'|'stop'|'restart',generation:number,signal:AbortSignal):Promise<void>{
  if(!unitPattern.test(unit)||!['start','stop','restart'].includes(action)||unit!==this.#ownUnit&&!allowedDefault(unit)&&!this.#allowed.has(unit))throw new MachineControlError('not_allowed','Service action is outside the trusted catalogue');
  const member={start:'StartUnit',stop:'StopUnit',restart:'RestartUnit'}[action];await this.#invoke(systemd,manager,systemd+'.Manager',member,'ss',[unit,'replace'],signal,true,generation);
 }
 async loginAvailable(signal:AbortSignal):Promise<boolean>{try{const xml=await this.#invoke('org.freedesktop.login1','/org/freedesktop/login1','org.freedesktop.DBus.Introspectable','Introspect','',[],signal);if(typeof xml!=='string'||Buffer.byteLength(xml)>1048576)throw new MachineControlError('unavailable','Invalid login manager introspection');return /<interface\s+name\s*=\s*['"]org\.freedesktop\.login1\.Manager['"]\s*>/u.test(xml);}catch(error){if(error instanceof dbus.DBusError&&['org.freedesktop.DBus.Error.NameHasNoOwner','org.freedesktop.DBus.Error.ServiceUnknown','org.freedesktop.DBus.Error.UnknownObject','org.freedesktop.DBus.Error.UnknownInterface'].includes(error.dbusName??''))return false;throw error;}}
 async power(action:'reboot'|'poweroff'|'halt',generation:number,signal:AbortSignal):Promise<void>{
  if(!['reboot','poweroff','halt'].includes(action))throw new MachineControlError('not_allowed','Invalid power action');const member={reboot:'Reboot',poweroff:'PowerOff',halt:'Halt'}[action];await this.#invoke('org.freedesktop.login1','/org/freedesktop/login1','org.freedesktop.login1.Manager',member,'b',[false],signal,true,generation);
 }
 async virtualization(signal:AbortSignal):Promise<string>{const value=await this.#invoke(systemd,manager,properties,'Get','ss',[systemd+'.Manager','Virtualization'],signal);if(!value||typeof value!=='object'||!('value' in value)||typeof value.value!=='string')throw new MachineControlError('container','Invalid virtualization state');return value.value;}
 close():Promise<void>{return this.#closing??=(async()=>{this.#abort.abort(new MachineControlError('unavailable','System bus owner closed'));this.#invalidate();await this.#opening?.catch(()=>{});const bus=this.#bus;this.#bus=undefined;if(bus)await this.#closeConnection?.();await this.#retired;await Promise.allSettled([...this.#pending]);this.#observers.clear();})();}
}
