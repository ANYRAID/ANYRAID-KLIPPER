// Git deployment adapter follows Moonraker 1cfb0c41 AppDeploy/BaseDeploy.
// GPL-3.0-or-later. Generic applications use isolated script-free npm before
// managed services; trusted product rebuilds and native/scripts remain separate.
import {createHash,randomUUID} from 'node:crypto';
import {isAbsolute,join,dirname} from 'node:path';
import {access} from 'node:fs/promises';
import {NodeDependencyTransaction,NodeDependencyError,nodeDependenciesNeedUpdate,type NodeDependencyOptions,type NodeRootMigration} from './node-dependency-transaction.ts';
import {ConfigurationError} from './config-source.ts';
import {resolveConfigurationPath} from './config-path.ts';
import type {ConfigurationReader} from './config-reader.ts';
import {GitRepository} from './update-git-repo.ts';
import type {GitRepositoryConfig,GitRepositoryStorage} from './update-git-repo.ts';
import {validateJson,type Json} from './rpc.ts';
import {managedServiceProgress,serviceProgressJson,type ManagedServiceProgress} from './update-managed-services.ts';

export interface GitDeploymentConfiguration extends GitRepositoryConfig {
 infoTags:string[];refreshInterval:number;configHash:string;
 /** Generic lock-driven production dependencies; no product rebuild implied. */
 enableNodeUpdates:boolean;isSystemService:boolean;managedServices:string[];
}
export type GitNodeRuntime=Omit<NodeDependencyOptions,'source'|'reservedPaths'|'npmPath'>&{npmPath?:string};
type Operation={id?:string;action:'update'|'rollback'|'recover';stage:'repository'|'dependencies'|'services'|'awaiting_response'|'interrupted';services?:Json;service_acknowledgement?:{receipt_id:string;fingerprint:string};dependencies?:{stage:'capturing'|'captured'|'repository'|'cleaning'|'preparing'|'installed';beforeCommit:string|null;rollbackTarget:string|null;manifestKey:string|null};migration?:NodeRootMigration};
export interface GitDeploymentStorage extends Record<string,Json> {
 schema:1;last_config_hash:string;last_refresh_time:number;last_error:string;
 repository:Json;operation:Operation|null;
}
export interface GitDeploymentMutationContext {
 signal:AbortSignal;authorize:()=>void|Promise<void>;
 persist:(state:GitDeploymentStorage)=>Promise<void>;
 restartServices?:(persist:(progress:ManagedServiceProgress)=>Promise<void>)=>Promise<void>;
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
 const managedServices=[name,'klipper','moonraker'].filter((service,index,choices)=>choices.indexOf(service)===index&&managed.includes(service));
 const enableNodeUpdates=c.getBoolean('enable_node_updates',{defaultValue:false});
 const value={name,path,origin,primaryBranch,channel,...pinnedCommit===undefined?{}:{pinnedCommit},refreshInterval,reportAnomalies,infoTags,isSystemService,managedServices,enableNodeUpdates,reservedPaths:[...options.reservedPaths??[]]};
 try{new GitRepository(value);}catch{throw new ConfigurationError('Invalid or unsupported Git repository configuration');}
 return {...value,configHash:createHash('sha256').update(JSON.stringify(value)).digest('hex')};
}

export class GitDeployment {
 readonly config:GitDeploymentConfiguration;readonly #repo:GitRepository;readonly #life=new AbortController();
 readonly #nodeRuntime:GitNodeRuntime;#node:NodeDependencyTransaction|undefined;
 #saved:GitDeploymentStorage;#tail:Promise<unknown>=Promise.resolve();#closing=false;
 constructor(config:GitDeploymentConfiguration,nodeRuntime:GitNodeRuntime={}){
  if(typeof config.enableNodeUpdates!=='boolean'||!Array.isArray(config.managedServices)||config.managedServices.length>3||config.managedServices.some(name=>![config.name,'klipper','moonraker'].includes(name))||new Set(config.managedServices).size!==config.managedServices.length||!Number.isSafeInteger(config.refreshInterval)||config.refreshInterval<0||!/^[a-f0-9]{64}$/u.test(config.configHash))throw new ConfigurationError('Unsupported Git deployment lifecycle configuration');
  this.#nodeRuntime={...nodeRuntime};
  this.config={...config,managedServices:[...config.managedServices],infoTags:[...config.infoTags],reservedPaths:[...config.reservedPaths??[]]};this.#repo=new GitRepository(this.config);
  this.#saved={schema:1,last_config_hash:'',last_refresh_time:0,last_error:'',repository:this.#repo.storage as unknown as Json,operation:null};
 }
 get lastRefresh(){return this.#saved.last_refresh_time;}
 needsRefresh(now=Date.now()/1000){return this.#saved.last_config_hash!==this.config.configHash||now>=this.lastRefresh+this.config.refreshInterval;}
 get status():Record<string,Json>{return {...this.#repo.status,configured_type:'git_repo',channel_invalid:false,info_tags:[...this.config.infoTags],last_error:this.#saved.last_error,deployment_state:this.#saved.operation?.stage??'idle',operation_id:this.#saved.operation?.id??null,service_acknowledgement:this.#saved.operation?.service_acknowledgement as unknown as Json??null,last_service_reconciliation:this.#saved.last_service_reconciliation??null,service_progress:this.#saved.operation?.services??null,dependency_progress:this.#saved.operation?.dependencies??null};}
 get storage():GitDeploymentStorage{return structuredClone({...this.#saved,repository:this.#repo.storage as unknown as Json});}
 /** Acknowledgement does not change the unknown service outcomes. */
 get skipsAcknowledgedServiceReplay(){return !!this.#saved.operation?.service_acknowledgement;}
 serviceReconciliationCandidate(){const operation=this.#saved.operation;if(!operation||operation.stage!=='interrupted'||!operation.id||operation.service_acknowledgement||!managedServiceProgress(operation.services)||!operation.services.entries.some(entry=>['queued','interrupted'].includes(entry.state)))throw Error('No unknown service batch requires reconciliation');return {operation:structuredClone(operation),config_hash:this.config.configHash,fingerprint:createHash('sha256').update(JSON.stringify([this.config.configHash,operation])).digest('hex')};}
 async acknowledgeServiceResult(operationId:string,fingerprint:string,receiptId:string,context:GitDeploymentMutationContext){return this.#queue(async()=>{const candidate=this.serviceReconciliationCandidate();if(candidate.operation.id!==operationId||candidate.fingerprint!==fingerprint||!/^app-receipt-[a-f0-9-]{36}$/u.test(receiptId))throw Error('Application reconciliation identity changed');context.signal.throwIfAborted();await context.authorize();context.signal.throwIfAborted();const next={...this.storage,operation:{...candidate.operation,service_acknowledgement:{receipt_id:receiptId,fingerprint}}};await context.persist(next);this.#saved=next;});}
 restore(value:unknown):void{
  if(value===undefined)return;validateJson(value);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid saved Git deployment state');const r=value as GitDeploymentStorage;
  if(r.schema!==1||r.last_config_hash!==''&&r.last_config_hash!==this.config.configHash||typeof r.last_refresh_time!=='number'||!Number.isFinite(r.last_refresh_time)||r.last_refresh_time<0||!['','Git refresh failed','Git deployment action failed'].includes(r.last_error)||!Object.hasOwn(r,'repository')||!Object.hasOwn(r,'operation'))throw Error('Invalid saved Git deployment metadata');
  if(r.operation!==null&&(!r.operation||!['update','rollback','recover'].includes(r.operation.action)||!['repository','dependencies','services','awaiting_response','interrupted'].includes(r.operation.stage)||r.operation.services!==undefined&&!managedServiceProgress(r.operation.services)))throw Error('Invalid saved Git deployment operation');
  if(r.operation?.dependencies){const d=r.operation.dependencies;if(!this.config.enableNodeUpdates||!['capturing','captured','repository','cleaning','preparing','installed'].includes(d.stage)||d.beforeCommit!==null&&!/^[a-f0-9]{40,64}$/u.test(d.beforeCommit)||d.rollbackTarget!==null&&!/^[a-f0-9]{40,64}$/u.test(d.rollbackTarget)||d.manifestKey!==null&&!/^[a-f0-9]{64}$/u.test(d.manifestKey))throw Error('Invalid saved Git dependency operation');}
  if(r.operation?.migration){const m=r.operation.migration;if(!this.config.enableNodeUpdates||![m.oldRoot,m.oldGit,m.newRoot,m.newGit].every(v=>typeof v==='string'&&/^\d+:\d+$/u.test(v))||typeof m.oldPath!=='string'||dirname(dirname(m.oldPath))!==dirname(this.config.path)||!m.oldPath.endsWith('/original'))throw Error('Invalid saved Git dependency migration');}
  if(r.operation?.id!==undefined&&!/^app-(?:[a-f0-9-]{36}|[a-f0-9]{64})$/u.test(r.operation.id))throw Error('Invalid application operation ID');
  const ack=r.operation?.service_acknowledgement;if(ack&&(!/^app-receipt-[a-f0-9-]{36}$/u.test(ack.receipt_id)||!/^[a-f0-9]{64}$/u.test(ack.fingerprint)))throw Error('Invalid service acknowledgement');
  this.#repo.restore(r.repository);this.#saved=structuredClone(r);if(this.#saved.operation){this.#saved.operation.id??='app-'+createHash('sha256').update(JSON.stringify([this.config.configHash,r.operation])).digest('hex');this.#saved.operation.stage='interrupted';if(managedServiceProgress(this.#saved.operation.services)){this.#saved.operation.services.state='interrupted';for(const entry of this.#saved.operation.services.entries)if(entry.state==='queued')entry.state='interrupted';}}
 }
 #queue<T>(work:()=>Promise<T>):Promise<T>{if(this.#closing)return Promise.reject(Error('Git deployment closed'));const task=this.#tail.then(work);this.#tail=task.then(()=>{},()=>{});return task;}
 #signal(signal:AbortSignal){return AbortSignal.any([signal,this.#life.signal]);}
 initialize(signal:AbortSignal):Promise<void>{return this.#queue(async()=>{signal=this.#signal(signal);await this.#repo.initialize(signal);if(this.config.enableNodeUpdates){let npm=this.#nodeRuntime.npmPath;if(!npm){for(const path of [join(dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js'),join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js')])try{await access(path);npm=path;break;}catch{}}if(!npm)throw Error('Node updates require a trusted npm CLI installation');this.#node=new NodeDependencyTransaction({...this.#nodeRuntime,npmPath:npm,source:{kind:'git-application',path:this.config.path},reservedPaths:this.config.reservedPaths});await this.#node.initialize(signal,this.#saved.operation?.migration);}});}
 refresh(signal:AbortSignal):Promise<void>{return this.#queue(async()=>{
  const owned=this.#signal(signal);try{await this.#repo.refresh(owned);this.#saved.last_error=this.#repo.lastRefreshSucceeded?'':'Git refresh failed';}catch{owned.throwIfAborted();this.#saved.last_error='Git refresh failed';}
  owned.throwIfAborted();if(this.#saved.last_error===''){this.#saved.last_refresh_time=Date.now()/1000;this.#saved.last_config_hash=this.config.configHash;}
 });}
 update(context:GitDeploymentMutationContext):Promise<boolean>{return this.#mutate('update',context);}
 rollback(context:GitDeploymentMutationContext):Promise<boolean>{return this.#mutate('rollback',context);}
 recover(context:GitDeploymentMutationContext,hard=false,forceDependencyUpdate=false):Promise<void>{
  if(forceDependencyUpdate&&!this.config.enableNodeUpdates)return Promise.reject(Error('Forced dependency updates require enable_node_updates'));
  return this.#mutate('recover',context,hard,forceDependencyUpdate).then(()=>{});
 }
 #mutate(action:Operation['action'],context:GitDeploymentMutationContext,hard=false,force=false):Promise<boolean>{return this.#queue(async()=>{
  const signal=this.#signal(context.signal);signal.throwIfAborted();if(this.#saved.operation&&action!=='recover')throw Error('Interrupted Git deployment requires explicit recovery');
  if(this.config.managedServices.length&&!context.restartServices&&!(action==='recover'&&this.skipsAcknowledgedServiceReplay))throw Error('Managed services require the trusted product lifecycle');
  if(action==='recover'&&!this.skipsAcknowledgedServiceReplay&&managedServiceProgress(this.#saved.operation?.services)&&this.#saved.operation!.services.entries.some(entry=>entry.state==='queued'||entry.state==='interrupted'))throw Error('Managed service result is unknown; inspect the recorded control request before recovery, no service replay');
  await context.authorize();signal.throwIfAborted();
  const prior=this.#saved.operation,skipServiceReplay=action==='recover'&&this.skipsAcknowledgedServiceReplay;const prepared:GitDeploymentStorage={...this.storage,operation:{...prior,id:prior?.id??'app-'+randomUUID(),action,stage:'repository'},last_error:''};await context.persist(prepared);this.#saved=prepared;
  const save=async(operation:Operation)=>{const next={...this.storage,operation};await context.persist(next);this.#saved=next;};
  const nodeContext={signal,authorize:context.authorize};
  const engineContext={signal,authorize:context.authorize,persist:async(repository:GitRepositoryStorage)=>{let operation=this.#saved.operation!;const t=repository.transaction;if(this.#node&&t?.action==='recover'&&t.backup&&t.newIdentity){operation={...operation,migration:{oldRoot:t.oldIdentity.root,oldGit:t.oldIdentity.git,oldPath:join(t.backup,'original'),newRoot:t.newIdentity.root,newGit:t.newIdentity.git}};}const next={...this.#saved,operation,repository:repository as unknown as Json};await context.persist(structuredClone(next));this.#saved=next;}};
  try{
   signal.throwIfAborted();
   let before=null as Awaited<ReturnType<NodeDependencyTransaction['captureManifest']>>;
   if(this.#node){
    if(action==='recover'){
     if(prior?.migration)await this.#node.rebindAfterGitRecovery(nodeContext,prior.migration);
     try{await this.#node.reconcile(nodeContext);}catch(error){if(!(error instanceof NodeDependencyError)||!['recovery_manifest_mismatch','recovery_identity'].includes(error.code))throw error;await this.#node.cancelPreparationForRecovery(nodeContext);}
     before=await this.#node.acceptCurrent(nodeContext)?await this.#node.checkpoint(nodeContext):await this.#node.recordedManifest(signal);
    }else{
     await save({...this.#saved.operation!,dependencies:{stage:'capturing',beforeCommit:/^[a-f0-9]{40,64}$/u.test(String(this.#repo.status.current_hash))?String(this.#repo.status.current_hash):null,rollbackTarget:this.#repo.storage.rollback?.commit??null,manifestKey:null}});
     before=await this.#node.checkpoint(nodeContext);if(!before?.treeIdentity)throw Error('Node updates require an existing matching dependency tree; explicit recover update_deps is required');
    }
    await save({...this.#saved.operation!,dependencies:{stage:'captured',beforeCommit:this.#saved.operation?.dependencies?.beforeCommit??(/^[a-f0-9]{40,64}$/u.test(String(this.#repo.status.current_hash))?String(this.#repo.status.current_hash):null),rollbackTarget:this.#repo.storage.rollback?.commit??null,manifestKey:before?.key??null}});
   }
   let result=action==='update'?await this.#repo.update(engineContext):action==='rollback'?await this.#repo.rollback(engineContext):(await this.#repo.recover(engineContext,hard),true);
   if(this.#node){
    await save({...this.#saved.operation!,stage:'dependencies',dependencies:{...this.#saved.operation!.dependencies!,stage:'repository',rollbackTarget:this.#repo.storage.rollback?.commit??null}});
    if(this.#saved.operation!.migration&&await this.#node.rebindAfterGitRecovery(nodeContext,this.#saved.operation!.migration))before=null;
    if(!force&&await this.#node.acceptCurrent(nodeContext)){/* Same locked tree already matches this Git target. */}
    else if(action==='rollback'){await this.#node.rollback(nodeContext);result=true;}
    else{
     // Latest Git rollback target and pre-change manifest are durable before
     // removing dependencies that no longer belong to that rollback target.
     const rebuild=hard||!!this.#saved.operation!.migration;const after=await this.#node.captureManifest(signal);if(!after)throw Error('Node update requires a lockfile at the Git target');if(!rebuild&&!nodeDependenciesNeedUpdate(before,after,force))throw Error('Dependencies do not match; explicit recover update_deps is required');
     await save({...this.#saved.operation!,dependencies:{...this.#saved.operation!.dependencies!,stage:'preparing'}});
     if(await this.#node.prepare(before,nodeContext,force||rebuild,true)){
      // Keep the older backup until real npm preparation has durably succeeded.
      await save({...this.#saved.operation!,dependencies:{...this.#saved.operation!.dependencies!,stage:'cleaning'}});await this.#node.discardBackup(nodeContext);await this.#node.commit(nodeContext);result=true;
     }
    }
    await save({...this.#saved.operation!,dependencies:{...this.#saved.operation!.dependencies!,stage:'installed'}});
   }
   if(result&&this.config.managedServices.length&&!skipServiceReplay)await context.restartServices!(async progress=>{const next:GitDeploymentStorage={...this.storage,operation:{...this.#saved.operation,action,stage:progress.state==='awaiting_response'?'awaiting_response':'services',services:serviceProgressJson(progress)}};await context.persist(next);this.#saved=next;});
   signal.throwIfAborted();const completed:GitDeploymentStorage={...this.storage,...skipServiceReplay?{last_service_reconciliation:{...prior!.service_acknowledgement!,operation_id:prior!.id!,services:prior!.services!,recovery:'repository_dependencies_only',service_result:'unconfirmed',service_replay:'skipped_acknowledged'}}:{},last_config_hash:this.config.configHash,last_refresh_time:Date.now()/1000,last_error:'',operation:null};await context.persist(completed);this.#saved=completed;return result;
  }catch(error){const interrupted:GitDeploymentStorage={...this.storage,last_error:'Git deployment action failed',operation:{...this.#saved.operation,action,stage:'interrupted'}};this.#saved=interrupted;try{await context.persist(structuredClone(interrupted));}catch{}throw error;}
 });}
 async close():Promise<void>{this.#closing=true;this.#life.abort(Error('Git deployment closed'));await this.#tail;await this.#node?.close();await this.#repo.close();}
}
