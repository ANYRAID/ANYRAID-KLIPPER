// Process-owned update status/refresh follows Moonraker1cfb0c41 update_manager.
// GPL-3.0-or-later. No package installation or executable deployment here.
import {createHash} from 'node:crypto';
import {lstat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {ConfigurationError} from './config-source.ts';
import {resolveConfigurationPath} from './config-path.ts';
import type {ConfigurationReader} from './config-reader.ts';
import {DatabaseStore} from './database.ts';
import type {DatabaseNamespace} from './database-namespace.ts';
import type {MoonrakerHttpClient} from './http-client.ts';
import type {EndpointRegistry} from './endpoints.ts';
import {ApiError,type Json} from './rpc.ts';
import {WebDeployment,webRepository,type WebDeploymentConfiguration} from './update-web-deploy.ts';
type UpdateNotification='notify_update_refreshed'|'notify_update_response';
const registrations=new WeakMap<DatabaseStore,Promise<DatabaseNamespace>>();
const namePattern=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
interface Stored extends Record<string,Json>{schema:1;deployments:Record<string,Json>;}
export class UpdateManager {
 readonly #database:DatabaseStore;readonly #http:MoonrakerHttpClient;readonly #reader:ConfigurationReader;
 readonly #blocked:()=>boolean;readonly #notify:(method:UpdateNotification,value:Json)=>void;
 readonly #deployments=new Map<string,WebDeployment>();readonly #auto:boolean;readonly #window:number[];
 readonly #life=new AbortController();readonly #pending=new Set<Promise<unknown>>();readonly #events=new Set<ReturnType<typeof setTimeout>>();
 #namespace:DatabaseNamespace|undefined;#ready=false;#initial=false;#closing=false;#failed=false;#refreshing=false;
 #tail=Promise.resolve();#opening:Promise<void>|undefined;#closed:Promise<void>|undefined;#timer:ReturnType<typeof setTimeout>|undefined;
 readonly #releases:Array<()=>void>=[];#notificationFailures=0;
 constructor(reader:ConfigurationReader,database:DatabaseStore,http:MoonrakerHttpClient,blocked:()=>boolean,notify:(method:UpdateNotification,value:Json)=>void){
  if(!(database instanceof DatabaseStore)||database.status.closed||typeof blocked!=='function'||typeof notify!=='function')throw new ConfigurationError('Update manager requires the process database and activity guard');
  this.#reader=reader;this.#database=database;this.#http=http;this.#blocked=blocked;this.#notify=notify;
  const cfg=reader.section('update_manager');this.#auto=cfg.getBoolean('enable_auto_refresh',{defaultValue:false});this.#window=cfg.getIntList('refresh_window',{defaultValue:[0,5],separator:'-',count:2});
  if(this.#window.some(h=>h<0||h>23)||this.#window[0]===this.#window[1])throw new ConfigurationError('Update refresh window needs two distinct hours0..23');
  const interval=cfg.getInt('refresh_interval',{defaultValue:168,minval:0,maxval:8760})*3600;
  if(cfg.get('client_repo',{defaultValue:null})!==null||cfg.get('client_path',{defaultValue:null})!==null)throw new ConfigurationError('Deprecated update client_repo/client_path options have been removed');
  cfg.getBoolean('enable_repo_debug',{defaultValue:false,deprecate:true});const system=cfg.getBoolean('enable_system_updates',{defaultValue:true});cfg.getBoolean('enable_packagekit',{defaultValue:true});
  const globalChannel=cfg.get('channel',{defaultValue:null});if(globalChannel!==null&&!['stable','beta','dev'].includes(globalChannel))throw new ConfigurationError('Invalid update channel');
  if(system)reader.warn('update_manager: system package provider is not implemented; no system update status or action is claimed');
  reader.warn('update_manager: Node core deployment/update, other deployment types and mutation routes remain unimplemented');
  const reserved=[reader.source.primaryFile,...reader.source.definitionSources().map(source=>source.filename),database.storagePaths.path,...database.storagePaths.backupDirectory?[database.storagePaths.backupDirectory]:[]];
  for(const section of reader.prefixSections('update_manager ')){
   const c=reader.section(section),name=section.slice('update_manager '.length).replace(/^client /u,'');if(!namePattern.test(name))throw new ConfigurationError('Invalid update application name');
   if(['moonraker','klipper'].includes(name)){for(const option of ['channel','pinned_commit','refresh_interval','report_anomalies'])if(c.hasOption(option))c.get(option);continue;}
   if(name==='system'||this.#deployments.has(name))throw new ConfigurationError('Duplicate update application name');
   const type=c.getChoice('type',['web','git_repo','zip','python','executable']);if(type!=='web'){reader.warn('update_manager: deployment type '+type+' is not yet implemented for '+name);continue;}
   const source=c.get('path');if(source.length>4096||/[\0\r\n]/u.test(source))throw new ConfigurationError('Invalid update application path');const target=resolveConfigurationPath(source);if(!isAbsolute(target))throw new ConfigurationError('Update application path must resolve to an absolute directory');
   const repo=c.get('repo').trim().replace(/^\/+|\/+$/gu,'');if(!webRepository(repo))throw new ConfigurationError('Update web repo must be owner/project');
   const requested=c.getChoice('channel',['stable','beta','dev'],{defaultValue:'stable'}) as 'stable'|'beta'|'dev',channel=requested==='dev'?'stable':requested;
   if(requested==='dev')reader.warn('['+section+']: web channel dev is invalid; falling back to stable');
   const persistent=c.getList('persistent_files',{defaultValue:[],separator:','}).map(v=>v.trim().replace(/^\/+|\/+$/gu,''));if(persistent.some(v=>['.version','release_info.json'].includes(v)))throw new ConfigurationError('Web version metadata cannot be persistent');
   const config={name,path:target,repo,channel,channelInvalid:requested==='dev',reportAnomalies:c.getBoolean('report_anomalies',{defaultValue:true}),infoTags:c.getList('info_tags',{defaultValue:[],separator:','}),refreshInterval:c.getInt('refresh_interval',{defaultValue:interval/3600,minval:0,maxval:8760})*3600};
   if(config.infoTags.length>32||config.infoTags.some(t=>t.length>256))throw new ConfigurationError('Update info_tags exceed capacity');
   const value:WebDeploymentConfiguration={...config,configHash:createHash('sha256').update(JSON.stringify({...config,persistent})).digest('hex')};this.#deployments.set(name,new WebDeployment(value,http,reserved));
  }
  if(this.#deployments.size>32)throw new ConfigurationError('Update application capacity exceeded');
 }
 get status(){return {ready:this.#ready,initialRefreshComplete:this.#initial,refreshing:this.#refreshing,pending:this.#pending.size,closing:this.#closing,failed:this.#failed,notificationFailures:this.#notificationFailures};}
 snapshot():Record<string,Json>{this.#active();const versions:Record<string,Json>=Object.create(null);versions.moonraker={};versions.klipper={};for(const [name,app]of this.#deployments)versions[name]=app.status;return {...this.#http.githubApiStats(),version_info:versions,busy:false};}
 #active(){if(!this.#ready||this.#closing||this.#failed)throw new ApiError(503,'Update manager unavailable');}
 start():Promise<void>{if(this.#closing)return Promise.reject(new ApiError(503,'Update manager closed'));return this.#opening??=this.#start();}
 async #start(){
  let registration=registrations.get(this.#database);if(!registration){registration=this.#database.registerLocalNamespace('native_update_manager',{forbidden:true});registrations.set(this.#database,registration);}this.#namespace=await registration;
  this.#life.signal.throwIfAborted();const exists=await this.#namespace.contains('state'),saved=await this.#namespace.get('state');
  if(exists&&(!saved||typeof saved!=='object'||Array.isArray(saved)||saved.schema!==1||!saved.deployments||typeof saved.deployments!=='object'||Array.isArray(saved.deployments)))throw new ApiError(503,'Invalid saved update manager state');
  for(const [name,app]of this.#deployments){this.#life.signal.throwIfAborted();const directory=await lstat(app.config.path);if(!directory.isDirectory()||directory.isSymbolicLink())throw new ConfigurationError('Configured web update path must be a physical directory');app.restore(exists?(saved as Stored).deployments[name]:undefined);await app.initialize(this.#life.signal);}
  this.#life.signal.throwIfAborted();this.#ready=true;
 }
 beginUpdates():void{this.#active();if(this.#timer||this.#initial)return;this.#timer=setTimeout(()=>{this.#timer=undefined;void this.#automatic().catch(()=>{this.#failed=true;});},0);this.#timer.unref();}
 async #automatic(){
  try{
   const hour=new Date().getHours(),[from,to]=this.#window,inside=from<to?hour>=from&&hour<to:hour>=from||hour<to;
   if(!this.#blocked()&&(!this.#initial||inside))await this.#enqueue(undefined,this.#life.signal,false,true);
  }finally{this.#initial=true;if(this.#auto&&!this.#closing){this.#timer=setTimeout(()=>{this.#timer=undefined;void this.#automatic().catch(()=>{this.#failed=true;});},3600000);this.#timer.unref();}}
 }
 async get(params:Readonly<Record<string,Json>>,signal:AbortSignal):Promise<Record<string,Json>>{
  this.#active();const refresh=typeof params.refresh==='string'?params.refresh.toLowerCase():params.refresh;if(Object.keys(params).some(k=>k!=='refresh')||refresh!==undefined&&typeof refresh!=='boolean'&&refresh!=='true'&&refresh!=='false')throw new ApiError(400,'Expected optional refresh boolean');
  if((refresh===true||refresh==='true')&&this.#initial&&!this.#blocked())return this.#enqueue(undefined,signal,true,false);return this.snapshot();
 }
 refresh(params:Readonly<Record<string,Json>>,signal:AbortSignal):Promise<Record<string,Json>>{
  this.#active();if(Object.keys(params).some(k=>k!=='name')||params.name!==undefined&&typeof params.name!=='string')return Promise.reject(new ApiError(400,'Expected optional updater name'));
  const name=params.name as string|undefined;if(name!==undefined&&!this.#deployments.has(name)&&!['moonraker','klipper'].includes(name))return Promise.reject(new ApiError(400,'No updater registered for selected name'));
  if(!this.#initial||this.#blocked())return Promise.reject(new ApiError(503,'Server is busy, cannot perform refresh'));return this.#enqueue(name,signal,false,false);
 }
 #enqueue(name:string|undefined,request:AbortSignal,throttle:boolean,automatic:boolean):Promise<Record<string,Json>>{
  if(this.#pending.size>=16)return Promise.reject(new ApiError(503,'Update refresh queue is full'));
  const signal=AbortSignal.any([request,this.#life.signal]),task=this.#tail.then(async()=>{
   signal.throwIfAborted();this.#active();if(this.#blocked()){if(automatic||throttle)return this.snapshot();throw new ApiError(503,'Server is busy, cannot perform refresh');}
   if(throttle&&Date.now()/1000<Math.max(0,...[...this.#deployments.values()].map(app=>app.lastRefresh))+60)return this.snapshot();
   this.#refreshing=true;let refreshed=name==='moonraker'||name==='klipper';try{
    for(const [id,app]of this.#deployments){signal.throwIfAborted();if((name===undefined||id===name)&&(!automatic||app.needsRefresh())){await app.refresh(signal);refreshed=true;}}
    signal.throwIfAborted();const state:Stored={schema:1,deployments:Object.fromEntries([...this.#deployments].map(([id,app])=>[id,app.storage]))};if(refreshed){await this.#namespace!.insert('state',state);signal.throwIfAborted();this.#event();}return this.snapshot();
   }finally{this.#refreshing=false;}
  });this.#pending.add(task);this.#tail=task.then(()=>{},()=>{});void task.then(()=>this.#pending.delete(task),()=>this.#pending.delete(task));return task;
 }
 #event(){if(this.#closing)return;const timer=setTimeout(()=>{this.#events.delete(timer);if(this.#closing)return;try{this.#notify('notify_update_refreshed',this.snapshot());}catch{this.#notificationFailures++;}},200);this.#events.add(timer);timer.unref();}
 register(registry:EndpointRegistry):()=>void{
  const status=registry.register({endpoint:'/machine/update/status',methods:['GET']},(params,_verb,context)=>this.get(params,context.signal));
  const refresh=registry.register({endpoint:'/machine/update/refresh',methods:['POST']},(params,_verb,context)=>this.refresh(params,context.signal));
  const unavailable=['moonraker','klipper','system','client','full','upgrade','recover','rollback'].map(name=>registry.register({endpoint:'/machine/update/'+name,methods:['POST']},()=>{this.#active();throw new ApiError(501,'Update deployment actions are not implemented; no action was performed');}));
  const release=()=>{for(const fn of [status,refresh,...unavailable])fn();};this.#releases.push(release);return release;
 }
 close():Promise<void>{return this.#closed??=(async()=>{this.#closing=true;clearTimeout(this.#timer);this.#timer=undefined;for(const timer of this.#events)clearTimeout(timer);this.#events.clear();this.#life.abort(new Error('Update manager closed'));for(const release of this.#releases)release();await Promise.allSettled([this.#opening,...this.#pending]);})();}
}
