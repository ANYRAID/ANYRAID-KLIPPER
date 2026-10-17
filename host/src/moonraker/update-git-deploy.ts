// Git deployment adapter follows Moonraker 1cfb0c41 AppDeploy/BaseDeploy.
// GPL-3.0-or-later. Dependency and service configuration is rejected until its
// real product lifecycle is connected; this adapter never executes npm/scripts.
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {ConfigurationError} from './config-source.ts';
import {resolveConfigurationPath} from './config-path.ts';
import type {ConfigurationReader} from './config-reader.ts';
import {GitRepository} from './update-git-repo.ts';
import type {GitRepositoryConfig,GitRepositoryStorage} from './update-git-repo.ts';
import {validateJson,type Json} from './rpc.ts';

export interface GitDeploymentConfiguration extends GitRepositoryConfig {
 infoTags:string[];refreshInterval:number;configHash:string;
 /** Current adapter supports explicit repository-only applications. */
 enableNodeUpdates:false;isSystemService:boolean;managedServices:[];
}
type Operation={action:'update'|'rollback'|'recover';stage:'repository'|'interrupted'};
export interface GitDeploymentStorage extends Record<string,Json> {
 schema:1;last_config_hash:string;last_refresh_time:number;last_error:string;
 repository:Json;operation:Operation|null;
}
export interface GitDeploymentMutationContext {
 signal:AbortSignal;authorize:()=>void|Promise<void>;
 persist:(state:GitDeploymentStorage)=>Promise<void>;
}
const supportedOptions=new Set(['type','path','origin','primary_branch','channel','pinned_commit','refresh_interval','report_anomalies','info_tags','is_system_service','managed_services','enable_node_updates']);

export function parseGitDeploymentConfiguration(reader:ConfigurationReader,section:string,options:{refreshInterval:number;reservedPaths?:readonly string[]}):GitDeploymentConfiguration {
 const c=reader.section(section),name=section.slice('update_manager '.length).replace(/^client /u,'');
 if(!section.startsWith('update_manager ')||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(name)||['moonraker','klipper','system'].includes(name))throw new ConfigurationError('Invalid git update application name');
 // Do not silently consume Python/pip, moved_origin, dependency scripts or
 // service options that the current product has no implementation for.
 if(Object.keys(c.options()).some(option=>!supportedOptions.has(option)))throw new ConfigurationError('Git deployment contains an unsupported configuration option');
 c.getChoice('type',['git_repo']);
 const source=c.get('path');if(source.length>4096||/[\0\r\n]/u.test(source))throw new ConfigurationError('Invalid git deployment path');
 const path=resolveConfigurationPath(source);if(!isAbsolute(path))throw new ConfigurationError('Git deployment path must be absolute');
 const origin=c.get('origin').trim(),primaryBranch=c.get('primary_branch',{defaultValue:'master'}),channel=c.getChoice('channel',['stable','beta','dev'],{defaultValue:'dev'}) as 'stable'|'beta'|'dev';
 const pinned=c.get('pinned_commit',{defaultValue:null}),pinnedCommit=pinned===null?undefined:pinned.toLowerCase();
 const refreshInterval=c.getInt('refresh_interval',{defaultValue:options.refreshInterval/3600,minval:0,maxval:8760})*3600;
 if(!Number.isSafeInteger(refreshInterval)||refreshInterval<0||refreshInterval>8760*3600)throw new ConfigurationError('Invalid Git refresh interval');
 const reportAnomalies=c.getBoolean('report_anomalies',{defaultValue:true}),infoTags=c.getList('info_tags',{defaultValue:[],separator:','});
 if(infoTags.length>32||infoTags.some(value=>value.length>256||!value.isWellFormed()||/[\0\r\n]/u.test(value)))throw new ConfigurationError('Git deployment info_tags exceed capacity');
 const isSystemService=c.getBoolean('is_system_service',{defaultValue:true});
 const managed=c.getList('managed_services',{defaultValue:isSystemService?[name]:[],separator:null});
 if(managed.some(value=>![name,'klipper','moonraker'].includes(value)))throw new ConfigurationError('Git deployment contains an invalid managed service');
 if(managed.length)throw new ConfigurationError('Git managed_services requires the product host lifecycle transfer, which is not implemented');
 if(c.getBoolean('enable_node_updates',{defaultValue:false}))throw new ConfigurationError('Git Node dependency updates require a trusted product bundle pipeline, which is not implemented');
 const value={name,path,origin,primaryBranch,channel,...pinnedCommit===undefined?{}:{pinnedCommit},refreshInterval,reportAnomalies,infoTags,isSystemService,managedServices:[] as [],enableNodeUpdates:false as const,reservedPaths:[...options.reservedPaths??[]]};
 try{new GitRepository(value);}catch{throw new ConfigurationError('Invalid or unsupported Git repository configuration');}
 return {...value,configHash:createHash('sha256').update(JSON.stringify(value)).digest('hex')};
}

export class GitDeployment {
 readonly config:GitDeploymentConfiguration;readonly #repo:GitRepository;readonly #life=new AbortController();
 #saved:GitDeploymentStorage;#tail:Promise<unknown>=Promise.resolve();#closing=false;
 constructor(config:GitDeploymentConfiguration){
  if(config.enableNodeUpdates!==false||!Array.isArray(config.managedServices)||config.managedServices.length||!Number.isSafeInteger(config.refreshInterval)||config.refreshInterval<0||!/^[a-f0-9]{64}$/u.test(config.configHash))throw new ConfigurationError('Unsupported Git deployment lifecycle configuration');
  this.config={...config,infoTags:[...config.infoTags],reservedPaths:[...config.reservedPaths??[]]};this.#repo=new GitRepository(this.config);
  this.#saved={schema:1,last_config_hash:'',last_refresh_time:0,last_error:'',repository:this.#repo.storage as unknown as Json,operation:null};
 }
 get lastRefresh(){return this.#saved.last_refresh_time;}
 needsRefresh(now=Date.now()/1000){return this.#saved.last_config_hash!==this.config.configHash||now>=this.lastRefresh+this.config.refreshInterval;}
 get status():Record<string,Json>{return {...this.#repo.status,configured_type:'git_repo',channel_invalid:false,info_tags:[...this.config.infoTags],last_error:this.#saved.last_error,deployment_state:this.#saved.operation?.stage??'idle'};}
 get storage():GitDeploymentStorage{return structuredClone({...this.#saved,repository:this.#repo.storage as unknown as Json});}
 restore(value:unknown):void{
  if(value===undefined)return;validateJson(value);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid saved Git deployment state');const r=value as GitDeploymentStorage;
  if(r.schema!==1||r.last_config_hash!==''&&r.last_config_hash!==this.config.configHash||typeof r.last_refresh_time!=='number'||!Number.isFinite(r.last_refresh_time)||r.last_refresh_time<0||!['','Git refresh failed','Git deployment action failed'].includes(r.last_error)||!Object.hasOwn(r,'repository')||!Object.hasOwn(r,'operation'))throw Error('Invalid saved Git deployment metadata');
  if(r.operation!==null&&(!r.operation||!['update','rollback','recover'].includes(r.operation.action)||!['repository','interrupted'].includes(r.operation.stage)))throw Error('Invalid saved Git deployment operation');
  this.#repo.restore(r.repository);this.#saved=structuredClone(r);if(this.#saved.operation)this.#saved.operation.stage='interrupted';
 }
 #queue<T>(work:()=>Promise<T>):Promise<T>{if(this.#closing)return Promise.reject(Error('Git deployment closed'));const task=this.#tail.then(work);this.#tail=task.then(()=>{},()=>{});return task;}
 #signal(signal:AbortSignal){return AbortSignal.any([signal,this.#life.signal]);}
 initialize(signal:AbortSignal):Promise<void>{return this.#queue(async()=>{await this.#repo.initialize(this.#signal(signal));});}
 refresh(signal:AbortSignal):Promise<void>{return this.#queue(async()=>{
  const owned=this.#signal(signal);try{await this.#repo.refresh(owned);this.#saved.last_error=this.#repo.lastRefreshSucceeded?'':'Git refresh failed';}catch{owned.throwIfAborted();this.#saved.last_error='Git refresh failed';}
  owned.throwIfAborted();if(this.#saved.last_error===''){this.#saved.last_refresh_time=Date.now()/1000;this.#saved.last_config_hash=this.config.configHash;}
 });}
 update(context:GitDeploymentMutationContext):Promise<boolean>{return this.#mutate('update',context);}
 rollback(context:GitDeploymentMutationContext):Promise<boolean>{return this.#mutate('rollback',context);}
 recover(context:GitDeploymentMutationContext,hard=false,forceDependencyUpdate=false):Promise<void>{
  if(forceDependencyUpdate)return Promise.reject(Error('Forced dependency updates are not implemented for Git deployment'));
  return this.#mutate('recover',context,hard).then(()=>{});
 }
 #mutate(action:Operation['action'],context:GitDeploymentMutationContext,hard=false):Promise<boolean>{return this.#queue(async()=>{
  const signal=this.#signal(context.signal);signal.throwIfAborted();if(this.#saved.operation&&action!=='recover')throw Error('Interrupted Git deployment requires explicit recovery');
  await context.authorize();signal.throwIfAborted();
  const prepared:GitDeploymentStorage={...this.storage,operation:{action,stage:'repository'},last_error:''};await context.persist(prepared);this.#saved=prepared;
  const engineContext={signal,authorize:context.authorize,persist:async(repository:GitRepositoryStorage)=>{const next={...this.#saved,repository:repository as unknown as Json};await context.persist(structuredClone(next));this.#saved=next;}};
  try{
   signal.throwIfAborted();
   const result=action==='update'?await this.#repo.update(engineContext):action==='rollback'?await this.#repo.rollback(engineContext):(await this.#repo.recover(engineContext,hard),true);
   signal.throwIfAborted();const completed:GitDeploymentStorage={...this.storage,last_config_hash:this.config.configHash,last_refresh_time:Date.now()/1000,last_error:'',operation:null};await context.persist(completed);this.#saved=completed;return result;
  }catch(error){const interrupted:GitDeploymentStorage={...this.storage,last_error:'Git deployment action failed',operation:{action,stage:'interrupted'}};this.#saved=interrupted;try{await context.persist(structuredClone(interrupted));}catch{}throw error;}
 });}
 async close():Promise<void>{this.#closing=true;this.#life.abort(Error('Git deployment closed'));await this.#tail;await this.#repo.close();}
}
