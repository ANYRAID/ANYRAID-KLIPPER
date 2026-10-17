// Process-owned updates follow Moonraker1cfb0c41 update_manager.
// GPL-3.0-or-later. Core and other deployment providers remain unavailable.
import {createHash} from 'node:crypto';
import {dirname,join,isAbsolute,relative,sep} from 'node:path';
import {MaintenanceGate,MaintenanceBusyError,type MaintenanceLease} from '../operations/maintenance-gate.ts';
import type {ProductHostControl} from '../runtime/product-host-control.ts';
import type {ManagedServiceProgress} from './update-managed-services.ts';
import {SystemPackageDeployment,type SystemPackageRuntime,type SystemPackageContext} from './system-package-deployment.ts';
import {ConfigurationError} from './config-source.ts';
import {resolveConfigurationPath} from './config-path.ts';
import type {ConfigurationReader} from './config-reader.ts';
import {DatabaseStore} from './database.ts';
import type {DatabaseNamespace} from './database-namespace.ts';
import type {MoonrakerHttpClient} from './http-client.ts';
import type {EndpointRegistry} from './endpoints.ts';
import {ApiError,authorizedContext,type Json} from './rpc.ts';
import {WebDeployment,webRepository,type WebDeploymentConfiguration} from './update-web-deploy.ts';
import {GitDeployment,parseGitDeploymentConfiguration,type GitDeploymentConfiguration,type GitDeploymentStorage,type GitNodeRuntime} from './update-git-deploy.ts';
import {NetApplication,parseNetApplicationConfiguration,type NetApplicationConfiguration,type NetApplicationStorage} from './update-net-application.ts';
import type {SystemDependencyFacts} from './application-dependencies.ts';
type UpdateNotification='notify_update_refreshed'|'notify_update_response';
const registrations=new WeakMap<DatabaseStore,Promise<DatabaseNamespace>>();
const namePattern=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
type DeploymentConfiguration=WebDeploymentConfiguration|GitDeploymentConfiguration|NetApplicationConfiguration;
const netConfiguration=(c:DeploymentConfiguration):c is NetApplicationConfiguration=>'applicationType' in c&&c.applicationType!==undefined;
const overlaps=(a:string,b:string)=>{const p=relative(a,b);return p===''||!isAbsolute(p)&&p!=='..'&&!p.startsWith('..'+sep);};
const deploymentLocations=(c:DeploymentConfiguration)=>[c.path,join(dirname(c.path),'origin' in c?'.anyraid-git-'+createHash('sha256').update(c.path).digest('hex'):(netConfiguration(c)&&c.applicationType==='executable'?'.anyraid-exec-':'.anyraid-web-')+createHash('sha256').update(c.path).digest('hex').slice(0,20)),...('origin' in c&&c.enableNodeUpdates?[join(dirname(c.path),'.anyraid-node-'+createHash('sha256').update(c.path).digest('hex'))]:[])];
const booleanParameter=(value:Json|undefined,name:string)=>{if(value===undefined)return false;if(value===true||value==='true')return true;if(value===false||value==='false')return false;throw new ApiError(400,'Expected '+name+' boolean');};
interface Stored extends Record<string,Json>{schema:1;deployments:Record<string,Json>;}
export interface UpdateMaintenance {gate:()=>MaintenanceGate;assertIdle:()=>void|Promise<void>;processGate?:()=>MaintenanceGate;control?:ProductHostControl;systemDependencyFacts?:(signal:AbortSignal)=>Promise<SystemDependencyFacts>;}
export class UpdateManager {
 readonly #database:DatabaseStore;readonly #http:MoonrakerHttpClient;readonly #reader:ConfigurationReader;
 readonly #blocked:()=>boolean;readonly #notify:(method:UpdateNotification,value:Json)=>void;
 readonly #deployments=new Map<string,WebDeployment|GitDeployment|NetApplication>();readonly #unsupported=new Map<string,string>();readonly #auto:boolean;readonly #window:number[];
 readonly #life=new AbortController();readonly #pending=new Set<Promise<unknown>>();readonly #events=new Set<ReturnType<typeof setTimeout>>();
 #namespace:DatabaseNamespace|undefined;#storedDeployments:Record<string,Json>=Object.create(null);#ready=false;#initial=false;#closing=false;#failed=false;#refreshing=false;
 #tail=Promise.resolve();#opening:Promise<void>|undefined;#closed:Promise<void>|undefined;#timer:ReturnType<typeof setTimeout>|undefined;
 readonly #releases:Array<()=>void>=[];#notificationFailures=0;#updating:string|undefined;readonly #maintenance:UpdateMaintenance;
 readonly #system:SystemPackageDeployment;#systemFence:{process:MaintenanceGate;processLease:MaintenanceLease;gate:MaintenanceGate;lease:MaintenanceLease}|undefined;#fullPlan:Json=null;readonly #nativeAdmission=new Set<()=>void>();
 constructor(reader:ConfigurationReader,database:DatabaseStore,http:MoonrakerHttpClient,blocked:()=>boolean,notify:(method:UpdateNotification,value:Json)=>void,maintenance?:UpdateMaintenance,nodeRuntime?:GitNodeRuntime,systemRuntime?:SystemPackageRuntime){
  if(!(database instanceof DatabaseStore)||database.status.closed||typeof blocked!=='function'||typeof notify!=='function')throw new ConfigurationError('Update manager requires the process database and activity guard');
  const fallback=new MaintenanceGate();this.#maintenance=maintenance??{gate:()=>fallback,assertIdle:()=>{if(blocked())throw new ApiError(503,'Printer is busy');}};this.#reader=reader;this.#database=database;this.#http=http;this.#blocked=blocked;this.#notify=notify;
  const cfg=reader.section('update_manager');this.#auto=cfg.getBoolean('enable_auto_refresh',{defaultValue:false});this.#window=cfg.getIntList('refresh_window',{defaultValue:[0,5],separator:'-',count:2});
  if(this.#window.some(h=>h<0||h>23)||this.#window[0]===this.#window[1])throw new ConfigurationError('Update refresh window needs two distinct hours0..23');
  const interval=cfg.getInt('refresh_interval',{defaultValue:168,minval:0,maxval:8760})*3600;
  if(cfg.get('client_repo',{defaultValue:null})!==null||cfg.get('client_path',{defaultValue:null})!==null)throw new ConfigurationError('Deprecated update client_repo/client_path options have been removed');
  cfg.getBoolean('enable_repo_debug',{defaultValue:false,deprecate:true});const system=cfg.getBoolean('enable_system_updates',{defaultValue:true}),packagekit=cfg.getBoolean('enable_packagekit',{defaultValue:true});this.#system=new SystemPackageDeployment(database,{enabled:system,packagekit,refreshInterval:interval,runtime:systemRuntime});
  const globalChannel=cfg.get('channel',{defaultValue:null});if(globalChannel!==null&&!['stable','beta','dev'].includes(globalChannel))throw new ConfigurationError('Invalid update channel');
  reader.warn('update_manager: Node core deployment/update and Python deployment remain unimplemented');
  const reserved=[reader.source.primaryFile,...reader.source.definitionSources().map(source=>source.filename),database.storagePaths.path,...database.storagePaths.backupDirectory?[database.storagePaths.backupDirectory]:[]];
  const configurations=new Map<string,DeploymentConfiguration>();
  const add=(config:DeploymentConfiguration)=>{for(const previous of configurations.values())for(const a of deploymentLocations(previous))for(const b of deploymentLocations(config))if(overlaps(a,b)||overlaps(b,a))throw new ConfigurationError('Update installation and control paths cannot overlap');configurations.set(config.name,config);};
  for(const section of reader.prefixSections('update_manager ')){
   const c=reader.section(section),name=section.slice('update_manager '.length).replace(/^client /u,'');if(!namePattern.test(name))throw new ConfigurationError('Invalid update application name');
   if(['moonraker','klipper'].includes(name)){for(const option of ['channel','pinned_commit','refresh_interval','report_anomalies'])if(c.hasOption(option))c.get(option);continue;}
   if(name==='system'||configurations.has(name))throw new ConfigurationError('Duplicate update application name');
   const type=c.getChoice('type',['web','git_repo','zip','python','executable']);if(type==='git_repo'){add(parseGitDeploymentConfiguration(reader,section,{refreshInterval:interval,reservedPaths:reserved}));continue;}if(type==='zip'||type==='executable'){add(parseNetApplicationConfiguration(reader,section,interval));continue;}if(type!=='web'){this.#unsupported.set(name,String(type));reader.warn('update_manager: deployment type '+type+' is not yet implemented for '+name);continue;}
   const source=c.get('path');if(source.length>4096||/[\0\r\n]/u.test(source))throw new ConfigurationError('Invalid update application path');const target=resolveConfigurationPath(source);if(!isAbsolute(target))throw new ConfigurationError('Update application path must resolve to an absolute directory');
   const repo=c.get('repo').trim().replace(/^\/+|\/+$/gu,'');if(!webRepository(repo))throw new ConfigurationError('Update web repo must be owner/project');
   const requested=c.getChoice('channel',['stable','beta','dev'],{defaultValue:'stable'}) as 'stable'|'beta'|'dev',channel=requested==='dev'?'stable':requested;
   if(requested==='dev')reader.warn('['+section+']: web channel dev is invalid; falling back to stable');
   const persistent=c.getList('persistent_files',{defaultValue:[],separator:','}).map(v=>v.trim().replace(/^\/+|\/+$/gu,''));if(persistent.length>64||persistent.some(v=>!v||v==='.'||v==='..'||v.includes('/')||v.includes(String.fromCharCode(92))||/[\0\r\n:]/u.test(v)||v.length>255||['.version','release_info.json'].includes(v.toLowerCase()))||new Set(persistent.map(v=>v.toLowerCase())).size!==persistent.length)throw new ConfigurationError('persistent_files must contain distinct top-level names excluding version metadata');
   const config={name,path:target,repo,channel,channelInvalid:requested==='dev',reportAnomalies:c.getBoolean('report_anomalies',{defaultValue:true}),infoTags:c.getList('info_tags',{defaultValue:[],separator:','}),refreshInterval:c.getInt('refresh_interval',{defaultValue:interval/3600,minval:0,maxval:8760})*3600};
   if(config.infoTags.length>32||config.infoTags.some(t=>t.length>256))throw new ConfigurationError('Update info_tags exceed capacity');
   const value:WebDeploymentConfiguration={...config,persistentFiles:persistent,configHash:createHash('sha256').update(JSON.stringify({...config,persistent})).digest('hex')};add(value);
  }
  if(configurations.size>32)throw new ConfigurationError('Update application capacity exceeded');
  for(const [name,config]of configurations){const protectedPaths=[...reserved,...[...configurations].flatMap(([id,value])=>id===name?[]:deploymentLocations(value))];this.#deployments.set(name,'origin' in config?new GitDeployment({...config,reservedPaths:protectedPaths},nodeRuntime):netConfiguration(config)?new NetApplication(config,http,protectedPaths,{node:nodeRuntime,dependencyFacts:this.#maintenance.systemDependencyFacts}):new WebDeployment(config,http,protectedPaths));}
 }
 get status(){return {ready:this.#ready,initialRefreshComplete:this.#initial,refreshing:this.#refreshing,updating:this.#updating??null,pending:this.#pending.size,closing:this.#closing,failed:this.#failed,notificationFailures:this.#notificationFailures};}
 get systemBlocked(){return this.#system.mutationBlocked;}
 /** Wait and take producer activity in one synchronous stack. Journal success
  * alone never wakes acquisition while the maintenance lease still drains. */
 acquireNativeActivity(request:AbortSignal):Promise<()=>void>{const signal=AbortSignal.any([request,this.#life.signal]);return new Promise((resolve,reject)=>{let settled=false;const done=()=>{settled=true;this.#nativeAdmission.delete(attempt);signal.removeEventListener('abort',attempt);},attempt=()=>{if(settled)return;if(signal.aborted){done();reject(signal.reason);return;}if(this.systemBlocked||this.#systemFence||this.#updating)return;const gate=this.#maintenance.processGate?.()??this.#maintenance.gate();try{const release=gate.activity();done();resolve(release);}catch(error){if(!(error instanceof MaintenanceBusyError)){done();reject(error);}}};this.#nativeAdmission.add(attempt);signal.addEventListener('abort',attempt,{once:true});attempt();});}
 #nativeAdmissionChanged(){for(const attempt of this.#nativeAdmission)attempt();}
 snapshot():Record<string,Json>{this.#active();const versions:Record<string,Json>=Object.create(null);versions.moonraker={};versions.klipper={};if(this.#system.enabled||this.systemBlocked)versions.system=this.#system.status;for(const [name,app]of this.#deployments)versions[name]=app.status;return {...this.#http.githubApiStats(),version_info:versions,busy:this.#updating!==undefined||this.systemBlocked,full_plan:this.#fullPlan};}
 #active(){if(!this.#ready||this.#closing||this.#failed)throw new ApiError(503,'Update manager unavailable');}
 start():Promise<void>{if(this.#closing)return Promise.reject(new ApiError(503,'Update manager closed'));return this.#opening??=this.#start();}
 async #start(){
  let registration=registrations.get(this.#database);if(!registration){registration=this.#database.registerLocalNamespace('native_update_manager',{forbidden:true});registrations.set(this.#database,registration);}this.#namespace=await registration;
  this.#life.signal.throwIfAborted();const exists=await this.#namespace.contains('state'),saved=await this.#namespace.get('state');
  if(exists&&(!saved||typeof saved!=='object'||Array.isArray(saved)||saved.schema!==1||!saved.deployments||typeof saved.deployments!=='object'||Array.isArray(saved.deployments)))throw new ApiError(503,'Invalid saved update manager state');
  this.#storedDeployments=exists?structuredClone((saved as Stored).deployments):Object.create(null);
  await this.#system.initialize(this.#life.signal);if(this.systemBlocked)this.#holdSystemFence();this.#fullPlan=await this.#namespace.get('full_plan');
  for(const [name,value]of Object.entries(this.#storedDeployments))if(!this.#deployments.has(name)&&value&&typeof value==='object'&&!Array.isArray(value)&&(value.operation||value.repository&&typeof value.repository==='object'&&!Array.isArray(value.repository)&&value.repository.transaction))throw new ApiError(503,'Interrupted deployment requires its original configuration');
  for(const [name,app]of this.#deployments){this.#life.signal.throwIfAborted();app.restore(exists?(saved as Stored).deployments[name]:undefined);await app.initialize(this.#life.signal);}
  this.#life.signal.throwIfAborted();this.#ready=true;
 }
 beginUpdates():void{this.#active();if(this.#timer||this.#initial)return;this.#timer=setTimeout(()=>{this.#timer=undefined;void this.#automatic().catch(()=>{this.#failed=true;});},0);this.#timer.unref();}
 async #automatic(){
  try{
   const hour=new Date().getHours(),[from,to]=this.#window,inside=from<to?hour>=from&&hour<to:hour>=from||hour<to;
   if(!this.#blocked()&&(!this.#initial||inside))await this.#enqueue(undefined,this.#life.signal,false,true);
  }catch(error){if(!this.systemBlocked)throw error;}finally{this.#initial=true;if(this.#auto&&!this.#closing){this.#timer=setTimeout(()=>{this.#timer=undefined;void this.#automatic().catch(()=>{this.#failed=true;});},3600000);this.#timer.unref();}}
 }
 async get(params:Readonly<Record<string,Json>>,signal:AbortSignal,authorize:()=>void|Promise<void>=()=>{}):Promise<Record<string,Json>>{
  this.#active();const refresh=typeof params.refresh==='string'?params.refresh.toLowerCase():params.refresh;if(Object.keys(params).some(k=>k!=='refresh')||refresh!==undefined&&typeof refresh!=='boolean'&&refresh!=='true'&&refresh!=='false')throw new ApiError(400,'Expected optional refresh boolean');
  if((refresh===true||refresh==='true')&&this.#initial&&!this.#blocked())return this.#enqueue(undefined,signal,true,false,authorize);return this.snapshot();
 }
 refresh(params:Readonly<Record<string,Json>>,signal:AbortSignal,authorize:()=>void|Promise<void>=()=>{}):Promise<Record<string,Json>>{
  this.#active();if(Object.keys(params).some(k=>k!=='name')||params.name!==undefined&&typeof params.name!=='string')return Promise.reject(new ApiError(400,'Expected optional updater name'));
  const name=params.name as string|undefined;if(name!==undefined&&!this.#deployments.has(name)&&!['moonraker','klipper',...this.#system.enabled?['system']:[]].includes(name))return Promise.reject(new ApiError(400,'No updater registered for selected name'));
  if(!this.#initial||this.#blocked())return Promise.reject(new ApiError(503,'Server is busy, cannot perform refresh'));return this.#enqueue(name,signal,false,false,authorize);
 }
 #enqueue(name:string|undefined,request:AbortSignal,throttle:boolean,automatic:boolean,authorize:()=>void|Promise<void>=()=>{}):Promise<Record<string,Json>>{
  if(this.#pending.size>=16)return Promise.reject(new ApiError(503,'Update refresh queue is full'));
  const signal=AbortSignal.any([request,this.#life.signal]),task=this.#tail.then(async()=>{
   signal.throwIfAborted();this.#active();if(this.#blocked()){if(automatic||throttle)return this.snapshot();throw new ApiError(503,'Server is busy, cannot perform refresh');}
   if(throttle&&Date.now()/1000<Math.max(this.#system.lastRefresh,...[...this.#deployments.values()].map(app=>app.lastRefresh))+60)return this.snapshot();
   this.#refreshing=true;let refreshed=name==='moonraker'||name==='klipper';try{
    if((name===undefined||name==='system')&&this.#system.enabled&&(!automatic||this.#system.needsRefresh())){if(automatic&&(!this.#system.status.available||this.systemBlocked)){}else try{await this.#systemMaintenance(signal,authorize,context=>this.#system.refresh(context));refreshed=true;}catch(error){if(!automatic||!(error instanceof ApiError&&[409,503].includes(error.status)))throw error;}}
    for(const [id,app]of this.#deployments){signal.throwIfAborted();if((name===undefined||id===name)&&(!automatic||app.needsRefresh())){await app.refresh(signal);refreshed=true;}}
    signal.throwIfAborted();if(refreshed){await this.#storeState();signal.throwIfAborted();this.#event();}return this.snapshot();
   }finally{this.#refreshing=false;}
  });this.#pending.add(task);this.#tail=task.then(()=>{},()=>{});void task.then(()=>this.#pending.delete(task),()=>this.#pending.delete(task));return task;
 }
 deploy(params:Readonly<Record<string,Json>>,request:AbortSignal,rollback:boolean,authorize:()=>void|Promise<void>=()=>{},afterResponse?:((callback:(sent:boolean)=>void)=>void)):Promise<string>{
  return this.#deploy(params,request,rollback?'rollback':'update',authorize,afterResponse);
 }
 recover(params:Readonly<Record<string,Json>>,request:AbortSignal,authorize:()=>void|Promise<void>=()=>{},afterResponse?:((callback:(sent:boolean)=>void)=>void)):Promise<string>{return this.#deploy(params,request,'recover',authorize,afterResponse);}
 #deploy(params:Readonly<Record<string,Json>>,request:AbortSignal,action:'update'|'rollback'|'recover',authorize:()=>void|Promise<void>,afterResponse?:((callback:(sent:boolean)=>void)=>void)):Promise<string>{
  if(this.systemBlocked)return Promise.reject(new ApiError(409,'System reconciliation blocks deployment changes'));
  this.#active();if(Object.keys(params).some(k=>!['name',...action==='recover'?['hard','update_deps']:[]].includes(k))||typeof params.name!=='string')return Promise.reject(new ApiError(400,'Expected updater name and supported action parameters'));const name=params.name,app=this.#deployments.get(name);if(!app)return Promise.reject(new ApiError(400,'No updater registered for selected name'));
  let hard=false,updateDeps=false;try{if(action==='recover'){hard=booleanParameter(params.hard,'hard');updateDeps=booleanParameter(params.update_deps,'update_deps');}}catch(error){return Promise.reject(error);}
  if(action==='recover'&&!(app instanceof GitDeployment))return Promise.reject(new ApiError(501,'Recovery is not implemented for this deployment type'));
  if(updateDeps&&app instanceof GitDeployment&&!app.config.enableNodeUpdates)return Promise.reject(new ApiError(501,'Forced dependency updates require enable_node_updates; no action was performed'));
  if(!this.#initial||this.#blocked()||this.#updating||this.#pending.size)return Promise.reject(new ApiError(503,'Server is busy, cannot perform update'));
  const response=Promise.withResolvers<string>(),owned=new AbortController(),cancel=()=>owned.abort(request.reason),stop=()=>owned.abort(this.#life.signal.reason);request.addEventListener('abort',cancel,{once:true});this.#life.signal.addEventListener('abort',stop,{once:true});if(request.aborted)cancel();if(this.#life.signal.aborted)stop();
  const signal=owned.signal,task=this.#tail.then(async()=>{
   signal.throwIfAborted();this.#active();if(this.#blocked())throw new ApiError(503,'Printer is busy');
   const initial=this.#maintenance.gate(),process=this.#maintenance.processGate?.();let processLease:MaintenanceLease|undefined,deviceLease:MaintenanceLease|undefined,gate=initial;
   try{if(process)processLease=process.acquireLease();if(initial!==process)deviceLease=initial.acquireLease();}catch(e){processLease?.release();if(e instanceof MaintenanceBusyError)throw new ApiError(409,e.message);throw e;}
   const lease=()=>gate===process?processLease:deviceLease;
   const current=()=>{signal.throwIfAborted();if(gate!==this.#maintenance.gate()||!gate.owns(lease())||this.#blocked())throw new ApiError(409,'Printer maintenance admission changed');};
   const admit=async()=>{current();await authorize();current();await this.#maintenance.assertIdle();current();};
   const proc=Date.now(),notify=(message:string,complete=false)=>{if(this.#closing)return;try{this.#notify('notify_update_response',{message,application:name,proc_id:proc,complete});}catch{this.#notificationFailures++;}};
   const label=app instanceof GitDeployment?'Git application':app instanceof NetApplication?'Application':'Web client';
   this.#updating=name;try{await admit();notify(label+' '+action+' started');
    let restartServices:((persist:(progress:ManagedServiceProgress)=>Promise<void>)=>Promise<void>)|undefined;
    if((app instanceof GitDeployment||app instanceof NetApplication)&&app.config.managedServices.length){
     const control=this.#maintenance.control;if(!control||!process||!processLease)throw new ApiError(503,'Managed services require the process control and maintenance owner');const plan=control.planMaintenanceServices(app.config.managedServices);if(plan.some(item=>item.retirement==='process')&&!afterResponse)throw new ApiError(503,'Process restart requires a real response handoff');
     restartServices=async persist=>{
      const progress:ManagedServiceProgress={schema:1,state:'running',next:0,entries:plan.map(item=>({...structuredClone(item),state:'planned',request_id:null}))};await persist(structuredClone(progress));
      for(let i=0;i<progress.entries.length;i++){
       const entry=progress.entries[i]!;await admit();notify('Restarting managed service '+entry.aliases.join(', '));let finish:((sent:boolean)=>void)|undefined;
       const originalLease=lease()!;const handle=control.requestMaintenanceAction(entry.action,originalLease,entry.retirement==='process'?callback=>{finish=callback;if(signal.aborted)finish(false);}:undefined,async(record,associationSignal)=>{associationSignal.throwIfAborted();signal.throwIfAborted();entry.request_id=record.request_id;entry.state='queued';progress.state=entry.retirement==='process'?'awaiting_response':'running';await persist(structuredClone(progress));associationSignal.throwIfAborted();signal.throwIfAborted();});
       const cancelControl=()=>finish?.(false);signal.addEventListener('abort',cancelControl,{once:true});if(signal.aborted)cancelControl();
       if(gate===process)processLease=undefined;else deviceLease=undefined;
       let admitted=false;try{await handle.admission;admitted=true;
        if(entry.retirement==='process'){
         // Durable association precedes exposing the real response callback.
         request.removeEventListener('abort',cancel);afterResponse!(sent=>finish!(sent));response.resolve('ok');
        }
       }catch(error){finish?.(false);const outcome=await handle.completion;signal.removeEventListener('abort',cancelControl);if(gate===process)processLease=outcome.lease;else deviceLease=outcome.lease;entry.state=outcome.operation?.state==='interrupted'?'interrupted':'failed';progress.state=entry.state;await persist(structuredClone(progress)).catch(()=>{});throw error;}
       const outcome=await handle.completion;signal.removeEventListener('abort',cancelControl);if(gate===process)processLease=outcome.lease;else deviceLease=outcome.lease;
       entry.state=outcome.operation?.state==='succeeded'?'succeeded':outcome.operation?.state==='interrupted'?'interrupted':'failed';progress.state=entry.state==='succeeded'?'running':entry.state;progress.next=entry.state==='succeeded'?i+1:i;await persist(structuredClone(progress));
       if(!admitted||outcome.failure||entry.state!=='succeeded')throw new ApiError(500,'Managed service control did not complete successfully; inspect its durable receipt');
       if(outcome.fenced){if(!processLease||!process.owns(processLease)||this.#maintenance.gate()!==process)throw new ApiError(409,'Retired service requires confirmed process maintenance continuity');gate=process;}
      }
      progress.state='complete';await persist(structuredClone(progress));
     };
    }
    if(app instanceof GitDeployment){const context={signal,authorize:admit,persist:async(state:GitDeploymentStorage)=>{await this.#storeState(name,state);},restartServices};if(action==='recover')await app.recover(context,hard,updateDeps);else if(action==='rollback')await app.rollback(context);else await app.update(context);}
    else if(app instanceof NetApplication)await app.mutate(action==='rollback',{signal,authorize:admit,persist:async(state:NetApplicationStorage)=>{await this.#storeState(name,state);},restartServices,installSystemPackages:(names,context)=>this.#system.installPackages(names,{...context,notify})});
    else await app.deploy(action==='rollback',signal,admit,notify);
    await this.#storeState();notify(label+' '+action+' complete',true);this.#event();return 'ok';
   }catch(error){notify(label+' '+action+' failed',true);throw error;}finally{await this.#system.drain();if(this.systemBlocked&&!this.#systemFence){const owner=process??gate,ownedLease=process?processLease:deviceLease,current=this.#maintenance.gate(),currentLease=current===process?processLease:deviceLease;if(ownedLease&&currentLease&&owner.owns(ownedLease)&&current.owns(currentLease)){this.#systemFence={process:owner,processLease:ownedLease,gate:current,lease:currentLease};processLease=deviceLease=undefined;}}this.#updating=undefined;deviceLease?.release();processLease?.release();this.#nativeAdmissionChanged();}
  });this.#pending.add(task);this.#tail=task.then(()=>{},()=>{});void task.then(value=>{this.#pending.delete(task);response.resolve(value);},error=>{this.#pending.delete(task);response.reject(error);}).finally(()=>{request.removeEventListener('abort',cancel);this.#life.signal.removeEventListener('abort',stop);});return response.promise;
 }
 async #storeState(name?:string,candidate?:GitDeploymentStorage|NetApplicationStorage){const deployments={...this.#storedDeployments,...Object.fromEntries([...this.#deployments].map(([id,app])=>[id,id===name?candidate!:app.storage]))};const state:Stored={schema:1,deployments};await this.#namespace!.insert('state',state);this.#storedDeployments=structuredClone(deployments);}
 #holdSystemFence(){
  if(this.#systemFence)return this.#systemFence;const gate=this.#maintenance.gate(),process=this.#maintenance.processGate?.()??gate;let processLease:MaintenanceLease|undefined;
  try{processLease=process.acquireLease();const lease=gate===process?processLease:gate.acquireLease();return this.#systemFence={process,processLease,gate,lease};}catch(error){processLease?.release();throw new ApiError(409,'Printer activity blocks system maintenance');}
 }
 #releaseSystemFence(){const fence=this.#systemFence;this.#systemFence=undefined;fence?.lease.release();if(fence?.gate!==fence?.process)fence?.processLease.release();this.#nativeAdmissionChanged();}
 async #systemMaintenance<T>(signal:AbortSignal,authorize:()=>void|Promise<void>,work:(context:SystemPackageContext)=>Promise<T>,notify?:(message:string)=>void):Promise<T>{
  const fence=this.#holdSystemFence(),current=()=>{signal.throwIfAborted();this.#life.signal.throwIfAborted();const gate=this.#maintenance.gate();if(!fence.process.owns(fence.processLease)||gate!==fence.gate&&gate!==fence.process||!gate.owns(gate===fence.process?fence.processLease:fence.lease)||this.#blocked())throw new ApiError(409,'System maintenance admission changed');};
  const admit=async()=>{current();await authorize();current();await this.#maintenance.assertIdle();current();};
  try{await admit();return await work({signal,authorize:admit,notify});}
  finally{await this.#system.drain();if(!this.systemBlocked)this.#releaseSystemFence();}
 }
 #systemQueue<T>(request:AbortSignal,authorize:()=>void|Promise<void>,work:(context:SystemPackageContext)=>Promise<T>):Promise<T>{
  this.#active();if(this.#updating||this.#pending.size||this.#blocked())return Promise.reject(new ApiError(503,'Server is busy, cannot perform system maintenance'));
  const signal=AbortSignal.any([request,this.#life.signal]),task=this.#tail.then(()=>this.#systemMaintenance(signal,authorize,work));this.#pending.add(task);this.#tail=task.then(()=>{},()=>{});void task.finally(()=>this.#pending.delete(task)).catch(()=>{});return task;
 }
 system(params:Readonly<Record<string,Json>>,request:AbortSignal,authorize:()=>void|Promise<void>=()=>{}):Promise<string>{
  if(Object.keys(params).length)return Promise.reject(new ApiError(400,'System update accepts no parameters'));if(!this.#system.enabled)return Promise.reject(new ApiError(404,'System updater is disabled'));if(!this.#initial)return Promise.reject(new ApiError(503,'Initial refresh is incomplete'));
  return this.#systemQueue(request,authorize,async context=>{this.#updating='system';const proc=Date.now(),notify=(message:string,complete=false)=>{if(!this.#closing)try{this.#notify('notify_update_response',{message,application:'system',proc_id:proc,complete});}catch{this.#notificationFailures++;}};
   try{notify('System package update started');await this.#system.update({...context,notify});notify('Package update finished',true);this.#event();return 'ok';}catch(error){notify('System package update failed; inspect durable receipt',true);throw error;}finally{this.#updating=undefined;}
  });
 }
 inspectSystem(request:AbortSignal,authorize:()=>void|Promise<void>):Promise<Record<string,Json>>{return this.#systemQueue(request,authorize,context=>this.#system.inspect(context));}
 reconcileSystem(params:Readonly<Record<string,Json>>,request:AbortSignal,authorize:()=>void|Promise<void>,actor:()=>string|null):Promise<string>{return this.#systemQueue(request,authorize,async context=>{await this.#system.reconcile(params,actor(),context);this.#event();return 'ok';});}
 /** Complete inventory is checked before the first package/client mutation.
  * Core deployment supplies its real executors in the following integration;
  * this batch never claims a partial client/system plan is full success. */
 full(params:Readonly<Record<string,Json>>,request:AbortSignal,authorize:()=>void|Promise<void>):Promise<string>{
  if(Object.keys(params).length)return Promise.reject(new ApiError(400,'Full update accepts no parameters'));
  return this.#systemQueue(request,authorize,async context=>{await context.authorize();const steps=[...this.#system.enabled?[{name:'system',capable:this.#system.status.available===true&&!this.systemBlocked}]:[],...[...this.#deployments].map(([name])=>({name,capable:true})),{name:'klipper',capable:false},{name:'moonraker',capable:false}],missing=steps.filter(step=>!step.capable).map(step=>step.name),plan={schema:1,id:'full-'+Date.now(),state:'preflight_blocked',steps,missing};
   for(const [name,type]of this.#unsupported){steps.splice(steps.length-2,0,{name,capable:false});missing.push(name);}await this.#namespace!.insert('full_plan',plan);this.#fullPlan=plan;await context.authorize();throw new ApiError(409,'Full update requires all planned core deployment capabilities; no update action was performed',{missing,plan});});
 }
 #event(){if(this.#closing)return;const timer=setTimeout(()=>{this.#events.delete(timer);if(this.#closing)return;try{this.#notify('notify_update_refreshed',this.snapshot());}catch{this.#notificationFailures++;}},200);this.#events.add(timer);timer.unref();}
 register(registry:EndpointRegistry):()=>void{
  const status=registry.register({endpoint:'/machine/update/status',methods:['GET']},(params,_verb,context)=>this.get(params,context.signal,async()=>{authorizedContext(context,await context.authorize('machine.update.refresh',params));}));
  const refresh=registry.register({endpoint:'/machine/update/refresh',methods:['POST']},(params,_verb,context)=>this.refresh(params,context.signal,async()=>{authorizedContext(context,await context.authorize('machine.update.refresh',params));}));
  const client=registry.register({endpoint:'/machine/update/client',methods:['POST']},(params,_verb,context)=>this.deploy(params,context.signal,false,async()=>{authorizedContext(context,await context.authorize('machine.update.client',params));},context.afterResponse));
  const rollback=registry.register({endpoint:'/machine/update/rollback',methods:['POST']},(params,_verb,context)=>this.deploy(params,context.signal,true,async()=>{authorizedContext(context,await context.authorize('machine.update.rollback',params));},context.afterResponse));
  const recover=registry.register({endpoint:'/machine/update/recover',methods:['POST']},(params,_verb,context)=>this.recover(params,context.signal,async()=>{authorizedContext(context,await context.authorize('machine.update.recover',params));},context.afterResponse));
  const system=registry.register({endpoint:'/machine/update/system',methods:['POST']},(params,_verb,context)=>this.system(params,context.signal,async()=>{authorizedContext(context,await context.authorize('machine.update.system',params));}));
  const full=registry.register({endpoint:'/machine/update/full',methods:['POST']},(params,_verb,context)=>this.full(params,context.signal,async()=>{authorizedContext(context,await context.authorize('machine.update.full',params));}));
  const reconcile=registry.register({endpoint:'/machine/update/reconcile',methods:['GET','POST']},(params,verb,context)=>{let actor:string|null=null;const authorize=async()=>{actor=authorizedContext(context,await context.authorize('machine.update.reconcile',params)).user?.username??null;};if(verb==='GET'){if(Object.keys(params).length)throw new ApiError(400,'Reconciliation inspection accepts no parameters');return this.inspectSystem(context.signal,authorize);}return this.reconcileSystem(params,context.signal,authorize,()=>actor);});
  const unavailable=['moonraker','klipper','upgrade'].map(name=>registry.register({endpoint:'/machine/update/'+name,methods:['POST']},()=>{this.#active();throw new ApiError(501,'Update deployment actions are not implemented; no action was performed');}));
  const release=()=>{for(const fn of [status,refresh,client,rollback,recover,system,full,reconcile,...unavailable])fn();};this.#releases.push(release);return release;
 }
 close():Promise<void>{return this.#closed??=(async()=>{this.#closing=true;clearTimeout(this.#timer);this.#timer=undefined;for(const timer of this.#events)clearTimeout(timer);this.#events.clear();this.#life.abort(new Error('Update manager closed'));for(const release of this.#releases)release();await Promise.allSettled([this.#opening,...this.#pending]);try{await Promise.all([this.#system.close(),...[...this.#deployments.values()].filter((app):app is GitDeployment|NetApplication=>app instanceof GitDeployment||app instanceof NetApplication).map(app=>app.close())]);}finally{this.#releaseSystemFence();}})();}
}
