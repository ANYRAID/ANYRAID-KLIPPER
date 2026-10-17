// GPL-3.0-or-later. APT behavior derived from Moonraker system_deploy.py,
// commit 1cfb0c41e468645951a371621f06d32777b6107c; independent of HTTP/DBus.
import {randomUUID} from 'node:crypto';
import {AptPackageError,ProcessAptCommandExecutor,aptCommandPath} from './apt-command-executor.ts';
import type {AptCommandExecutor,AptCommandRequest,AptOperationContext,AptErrorCode} from './apt-command-executor.ts';

export const MAX_APT_PACKAGES=256;
export const aptPackageName=(name:unknown):name is string=>typeof name==='string'&&name.length>=2&&name.length<=192&&/^[a-z0-9][a-z0-9+.-]+$/u.test(name);
export interface AptExactTarget {name:string;version:string;}
export type AptMutationState={schema:1;state:'idle'}|{schema:1;state:'pending'|'interrupted';id:string;operation:'install'|'upgrade';packages:string[];startedAt:number;exactTargets?:AptExactTarget[]};
/** Trusted owner supplies durable storage. load/save must finish and report a
 * failed write; save must not resolve before the record is durable. No automatic
 * replay or public clear exists. External reconciliation owns clearing records. */
export interface AptMutationJournal {load():Promise<unknown>;save(state:AptMutationState):Promise<void>;}
export interface AptProviderConfiguration {
 commands:{apt:string;aptGet:string;aptCache:string};
 /** Optional trusted privilege capability, e.g. sudo -n --. envCommand must be
  * absolute; fixed environment is reapplied after crossing that capability. */
 privilege?:{command:string;args:readonly string[];envCommand:string};
 /** Trusted initialization only, never request-supplied. Useful for an isolated
  * Dir::* root; can also contain privileged APT hooks and is therefore authority. */
 aptConfiguration?:Readonly<Record<string,string>>;
 /** Early APT_CONFIG, before host apt.conf.d loading. Required for a fully
  * isolated test root; command-line -o Dir::Etc alone is applied too late. */
 configurationFile?:string;
 journal?:AptMutationJournal;executor?:AptCommandExecutor;maxOutputBytes?:number;
 notify?:(message:string)=>void;
}
export interface AptInstallOptions {timeout?:number;retries?:number;notify?:boolean;}
const IDLE:AptMutationState={schema:1,state:'idle'};
const ENV=Object.freeze({PATH:'/usr/sbin:/usr/bin:/sbin:/bin',HOME:'/nonexistent',LC_ALL:'C',LANG:'C',TERM:'dumb',DEBIAN_FRONTEND:'noninteractive',DEBCONF_NONINTERACTIVE_SEEN:'true',APT_LISTCHANGES_FRONTEND:'none',UCF_FORCE_CONFFOLD:'1'});
function packages(value:readonly string[]):string[]{
 if(!Array.isArray(value)||value.length>MAX_APT_PACKAGES||value.some(name=>!aptPackageName(name)))throw new AptPackageError('invalid','Expected up to 256 bare Debian package names');
 return [...value];
}
// Safe bounded Debian version grammar. This is validation only: APT policy,
// including pin priorities, chooses the candidate; no local version comparison.
export function aptPackageVersion(value:unknown):value is string{
 if(typeof value!=='string'||value.length<1||value.length>256)return false;
 let rest=value;const colon=value.indexOf(':');if(colon!==-1){if(!/^[0-9]+$/u.test(value.slice(0,colon)))return false;rest=value.slice(colon+1);}
 const dash=rest.lastIndexOf('-');if(dash!==-1){if(!/^[A-Za-z0-9+.~]+$/u.test(rest.slice(dash+1)))return false;rest=rest.slice(0,dash);}
 return /^[0-9][A-Za-z0-9.+:~-]*$/u.test(rest);
}
export function parseAptPolicyCandidates(output:string,requested:readonly string[]):AptExactTarget[]{
 const names=packages(requested),expected=new Set(names);if(!expected.size)return [];
 if(Buffer.byteLength(output)>16*1024*1024)throw new AptPackageError('output','APT policy exceeded capacity');
 const rows=new Map<string,{candidate?:string;table:boolean;versions:Set<string>}>();let row:{candidate?:string;table:boolean;versions:Set<string>}|undefined;
 const lines=output.split('\n');if(lines.length>65536)throw new AptPackageError('output','Too many APT policy lines');
 for(const raw of lines){
  if(raw.length>4096)throw new AptPackageError('output','APT policy line exceeded capacity');if(!raw.trim())continue;
  const header=/^([a-z0-9][a-z0-9+.-]+):$/u.exec(raw);
  if(header){if(!expected.has(header[1])||rows.has(header[1]))throw new AptPackageError('output','Unexpected or duplicate APT policy package');row={table:false,versions:new Set()};rows.set(header[1],row);continue;}
  if(!row||!/^\s/u.test(raw))throw new AptPackageError('output','Invalid APT policy header');
  const candidate=/^\s+Candidate:(.*)$/u.exec(raw);if(candidate){const value=candidate[1].trim();if(row.candidate!==undefined||!value)throw new AptPackageError('output','Invalid APT policy candidate');if(value!=='(none)'&&!aptPackageVersion(value))throw new AptPackageError('output','Invalid APT candidate version');row.candidate=value;continue;}
  if(/^\s+Installed:/u.test(raw))continue;
  if(/^\s+Version table:\s*$/u.test(raw)){if(row.table)throw new AptPackageError('output','Duplicate APT policy version table');row.table=true;continue;}
  if(!row.table)throw new AptPackageError('output','Unexpected APT policy field');
  const version=/^\s+(?:\*\*\*\s+)?(\S+)\s+-?[0-9]{1,10}\s*$/u.exec(raw);
  if(version){if(!aptPackageVersion(version[1]))throw new AptPackageError('output','Invalid APT policy table version');row.versions.add(version[1]);}
 }
 return names.map(name=>{const item=rows.get(name);if(!item||item.candidate===undefined||!item.table)throw new AptPackageError('output','APT candidate metadata is incomplete');if(item.candidate==='(none)')throw new AptPackageError('unavailable','APT package has no candidate');if(!item.versions.has(item.candidate))throw new AptPackageError('output','APT candidate is absent from version table');return {name,version:item.candidate};});
}
function state(value:unknown):AptMutationState{
 if(value===null||value===undefined)return {...IDLE};
 if(!value||typeof value!=='object'||Array.isArray(value))throw new AptPackageError('journal','Invalid APT mutation journal');
 const row=value as Record<string,unknown>;
 if(row.schema!==1)throw new AptPackageError('journal','Invalid APT mutation journal schema');
 if(row.state==='idle'&&Object.keys(row).every(key=>['schema','state'].includes(key)))return {...IDLE};
 if(!['pending','interrupted'].includes(String(row.state))||!['install','upgrade'].includes(String(row.operation))||typeof row.id!=='string'||!/^[a-f0-9-]{36}$/u.test(row.id)||typeof row.startedAt!=='number'||!Number.isSafeInteger(row.startedAt)||row.startedAt<0||!Array.isArray(row.packages)||Object.keys(row).some(key=>!['schema','state','id','operation','packages','startedAt','exactTargets'].includes(key)))throw new AptPackageError('journal','Invalid APT mutation journal record');
 const selected=packages(row.packages);if(row.operation==='upgrade'&&selected.length)throw new AptPackageError('journal','Invalid APT upgrade journal');
 let exactTargets:AptExactTarget[]|undefined;
 if(row.exactTargets!==undefined){if(row.operation!=='install'||!Array.isArray(row.exactTargets)||row.exactTargets.length!==selected.length)throw new AptPackageError('journal','Invalid APT exact-target journal');exactTargets=row.exactTargets.map((target,at)=>{if(!target||typeof target!=='object'||Array.isArray(target)||target.name!==selected[at]||!aptPackageVersion(target.version)||Object.keys(target).some(key=>!['name','version'].includes(key)))throw new AptPackageError('journal','Invalid APT exact-target journal');return {name:target.name,version:target.version};});}
 return {schema:1,state:row.state as 'pending'|'interrupted',id:row.id,operation:row.operation as 'install'|'upgrade',packages:selected,startedAt:row.startedAt,...exactTargets?{exactTargets}:{}};
}

/** Parse actual package/archive records rather than upstream's unconditional
 * nonempty-lines[2:], which can discard the first upgradable package. */
export function parseAptUpgradablePackages(output:string):string[]{
 if(Buffer.byteLength(output)>16*1024*1024)throw new AptPackageError('output','APT package listing exceeded capacity');
 const result:string[]=[];
 for(const raw of output.split('\n')){
  const line=raw.trim();if(!line||/^Listing\.\.\./u.test(line)||/^WARNING:/u.test(line))continue;
  const match=/^([^/\s]+)\/\S+\s+\S+\s+\S+(?:\s+.*)?$/u.exec(line);
  if(!match||!aptPackageName(match[1]))throw new AptPackageError('output','Invalid APT package listing');
  result.push(match[1]);if(result.length>65536)throw new AptPackageError('output','Too many APT package records');
 }
 return result;
}
function installOptions(options:AptInstallOptions):Required<AptInstallOptions>{
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['timeout','retries','notify'].includes(key)))throw new AptPackageError('invalid','Invalid APT installation options');
 const timeout=options.timeout??300,retries=options.retries??1,notify=options.notify??false;
 if(!Number.isFinite(timeout)||timeout<=0||timeout>3600||!Number.isInteger(timeout*1000)||typeof notify!=='boolean')throw new AptPackageError('invalid','Invalid APT installation timeout or notify option');
 if(retries!==1)throw new AptPackageError('unsupported','APT install retries must be 1; mutation retry is not supported');return {timeout,retries,notify};
}

/** One operation at a time, no replay queue. The injected executor is borrowed;
 * this owner aborts/drains its requests but closes only its default executor. */
export class AptPackageProvider {
 readonly #config:AptProviderConfiguration;readonly #executor:AptCommandExecutor;readonly #ownsExecutor:boolean;readonly #aptArgs:string[]=[];readonly #env:Readonly<Record<string,string>>;
 #life=new AbortController();#active:Promise<unknown>|undefined;#closing=false;#ready=false;#packages:string[]=[];#lastRefresh:number|null=null;#stale=true;#journal:AptMutationState={...IDLE};#lastError:{operation:string;code:AptErrorCode}|null=null;
 constructor(configuration:AptProviderConfiguration){
  const paths=configuration.commands;if(!paths||![paths.apt,paths.aptGet,paths.aptCache].every(aptCommandPath))throw new AptPackageError('invalid','APT commands must use trusted absolute paths');
  if(configuration.configurationFile!==undefined&&!aptCommandPath(configuration.configurationFile))throw new AptPackageError('invalid','APT configuration file must use a trusted absolute path');
  this.#env=Object.freeze({...ENV,...configuration.configurationFile?{APT_CONFIG:configuration.configurationFile}:{}});
  const privilege=configuration.privilege;if(privilege&&(!aptCommandPath(privilege.command)||!aptCommandPath(privilege.envCommand)||!Array.isArray(privilege.args)||privilege.args.length>32||privilege.args.some(arg=>typeof arg!=='string'||arg.length>4096||/[\0\r\n]/u.test(arg))))throw new AptPackageError('invalid','Invalid trusted APT privilege capability');
  const entries=Object.entries(configuration.aptConfiguration??{});if(entries.length>64||entries.some(([key,value])=>!/^[A-Za-z][A-Za-z0-9:_-]*$/u.test(key)||typeof value!=='string'||value.length>4096||/[\0\r\n]/u.test(value)))throw new AptPackageError('invalid','Invalid trusted APT configuration');
  for(const [key,value] of entries)this.#aptArgs.push('-o',key+'='+value);
  const max=configuration.maxOutputBytes??4*1024*1024;if(!Number.isSafeInteger(max)||max<1||max>16*1024*1024)throw new AptPackageError('invalid','Invalid APT output capacity');
  this.#config={...configuration,commands:{...paths},privilege:privilege?{...privilege,args:[...privilege.args]}:undefined,maxOutputBytes:max};this.#ownsExecutor=!configuration.executor;this.#executor=configuration.executor??new ProcessAptCommandExecutor();
 }
 get status(){return {provider:'apt' as const,initialized:this.#ready,busy:!!this.#active,closing:this.#closing,packageCount:this.#packages.length,packages:[...this.#packages],lastRefresh:this.#lastRefresh,cacheStale:this.#stale,mutation:structuredClone(this.#journal),lastError:this.#lastError?{...this.#lastError}:null};}
 #operate<T>(operation:string,context:AptOperationContext,work:(context:AptOperationContext)=>Promise<T>,initializing=false):Promise<T>{
  if(this.#closing)return Promise.reject(new AptPackageError('closed','APT provider is closed'));if(this.#active)return Promise.reject(new AptPackageError('busy','APT provider is busy'));if(!initializing&&!this.#ready)return Promise.reject(new AptPackageError('unavailable','APT provider is not initialized'));
  const ctx={...context,signal:AbortSignal.any([context.signal,this.#life.signal])};
  const task=(async()=>{try{await this.#admit(ctx);const result=await work(ctx);this.#lastError=null;return result;}catch(error){const failure=error instanceof AptPackageError?error:new AptPackageError(ctx.signal.aborted?'aborted':'failed','APT operation failed');this.#lastError={operation,code:failure.code};if(['refresh','get_packages','install'].includes(operation))this.#stale=true;throw failure;}})();
  this.#active=task;void task.finally(()=>{if(this.#active===task)this.#active=undefined;}).catch(()=>{});return task;
 }
 async #admit(context:AptOperationContext):Promise<void>{if(context.signal.aborted)throw new AptPackageError('aborted','APT operation was cancelled');try{await context.authorize();}catch{throw new AptPackageError('authorization','APT operation authorization denied');}if(context.signal.aborted)throw new AptPackageError('aborted','APT operation was cancelled');}
 async #run(command:string,args:readonly string[],timeoutMs:number,context:AptOperationContext,effect:AptCommandRequest['effect']='query',notify=false):Promise<string>{
  await this.#admit(context);let executable=command,argv=[...this.#aptArgs,...args];
  if(effect!=='query'&&this.#config.privilege){const privilege=this.#config.privilege;executable=privilege.command;argv=[...privilege.args,privilege.envCommand,'-i',...Object.entries(this.#env).map(([key,value])=>key+'='+value),command,...argv];}
  const result=await this.#executor.run({command:executable,args:argv,env:this.#env,timeoutMs,maxOutputBytes:this.#config.maxOutputBytes!,effect,signal:context.signal,authorize:context.authorize,onOutput:notify?context.onOutput:undefined});
  await this.#admit(context);return result.stdout;
 }
 initialize(context:AptOperationContext):Promise<void>{return this.#operate('initialize',context,async ctx=>{
  if(this.#ready)return;
  for(const command of Object.values(this.#config.commands))await this.#run(command,['--version'],60000,ctx);
  if(this.#config.journal){let loaded:unknown;try{loaded=await this.#config.journal.load();}catch{throw new AptPackageError('journal','APT mutation journal could not be loaded');}this.#journal=state(loaded);if(this.#journal.state==='pending'){this.#journal={...this.#journal,state:'interrupted'};await this.#save(this.#journal);}}
  await this.#admit(ctx);this.#ready=true;
 },true);}
 async #query(context:AptOperationContext):Promise<string[]>{return parseAptUpgradablePackages(await this.#run(this.#config.commands.apt,['list','--upgradable'],60000,context));}
 getPackages(context:AptOperationContext):Promise<string[]>{return this.#operate('get_packages',context,async ctx=>{const found=await this.#query(ctx);await this.#admit(ctx);this.#packages=found;this.#stale=false;return [...found];});}
 async #refresh(context:AptOperationContext,notify:boolean):Promise<void>{await this.#run(this.#config.commands.aptGet,['update'],600000,context,'cache',notify);}
 refreshPackages(context:AptOperationContext,notify=false):Promise<string[]>{
  if(typeof notify!=='boolean')return Promise.reject(new AptPackageError('invalid','APT notify must be boolean'));
  return this.#operate('refresh',context,async ctx=>{await this.#refresh(ctx,notify);const found=await this.#query(ctx);await this.#admit(ctx);this.#packages=found;this.#lastRefresh=Date.now();this.#stale=false;return [...found];});
 }
 async #resolve(requested:string[],context:AptOperationContext):Promise<string[]>{
  this.#config.notify?.('Resolving packages...');if(!requested.length)return [];
  const expression=requested.map(name=>'^'+name.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')+'$').join('|');
  const output=await this.#run(this.#config.commands.aptCache,['search','--names-only',expression],600000,context),found=new Set<string>();
  for(const line of output.split('\n')){const trimmed=line.trim();if(trimmed){const name=trimmed.split(/\s/u)[0];if(aptPackageName(name))found.add(name);}}
  return requested.filter(name=>found.has(name));
 }
 resolvePackages(requested:readonly string[],context:AptOperationContext):Promise<string[]>{let selected:string[];try{selected=packages(requested);}catch(error){return Promise.reject(error);}return this.#operate('resolve',context,ctx=>this.#resolve(selected,ctx));}
 async #exactTargets(selected:string[],context:AptOperationContext):Promise<AptExactTarget[]>{
  const output=await this.#run(this.#config.commands.aptCache,['policy',...new Set(selected)],600000,context);return parseAptPolicyCandidates(output,selected);
 }
 async #save(value:AptMutationState):Promise<void>{try{await this.#config.journal!.save(structuredClone(value));}catch{throw new AptPackageError('journal','APT mutation journal could not be persisted');}}
 #canMutate(){if(!this.#config.journal)throw new AptPackageError('unavailable','APT mutation requires a trusted durable journal');if(this.#journal.state!=='idle')throw new AptPackageError('interrupted','APT mutation requires external reconciliation');}
 async #mutate(operation:'install'|'upgrade',selected:string[],timeoutMs:number,notify:boolean,context:AptOperationContext,exactTargets?:AptExactTarget[]):Promise<void>{
  this.#canMutate();await this.#admit(context);
  const pending:AptMutationState={schema:1,state:'pending',id:randomUUID(),operation,packages:[...selected],startedAt:Date.now(),...exactTargets?{exactTargets:structuredClone(exactTargets)}:{}};
  try{await this.#save(pending);}catch(error){this.#journal={...pending,state:'interrupted'};throw error;}
  this.#journal=pending;let executed=false;
  try{
   await this.#admit(context);
   // Record dispatch independently of success: nonzero exit can partially apply
   // dpkg changes, and completion persistence/authorization can also be lost.
   // Exact candidates are captured before intent and never reselected after
   // dispatch. If the cache changes, APT must fail rather than select a sibling.
   const action=operation==='install'?['install','--yes','--no-remove',...exactTargets!.map(target=>target.name+'='+target.version)]:['upgrade','--yes'];
   let executable=this.#config.commands.aptGet,argv=[...this.#aptArgs,'-o','Dpkg::Use-Pty=0','-o','Dpkg::Options::=--force-confdef','-o','Dpkg::Options::=--force-confold',...action];
   if(this.#config.privilege){const privilege=this.#config.privilege;argv=[...privilege.args,privilege.envCommand,'-i',...Object.entries(this.#env).map(([key,value])=>key+'='+value),executable,...argv];executable=privilege.command;}
   let result;try{result=await this.#executor.run({command:executable,args:argv,env:this.#env,timeoutMs,maxOutputBytes:this.#config.maxOutputBytes!,effect:operation,signal:context.signal,authorize:context.authorize,onOutput:notify?context.onOutput:undefined});executed=true;}catch(error){executed=!(error instanceof AptPackageError)||error.dispatched;throw error;}
   if(result.exitCode!==0)throw new AptPackageError('failed','APT mutation failed',true);await this.#admit(context);
   await this.#save(IDLE);await this.#admit(context);this.#journal={...IDLE};this.#stale=true;
  }catch(error){
   if(executed){this.#journal={...pending,state:'interrupted'};try{await this.#save(this.#journal);}catch{}throw new AptPackageError('interrupted','APT mutation outcome requires external reconciliation',true);}
   try{await this.#save(IDLE);this.#journal={...IDLE};}catch{this.#journal={...pending,state:'interrupted'};throw new AptPackageError('journal','Unexecuted APT intent could not be cleared');}
   throw error;
  }
 }
 installPackages(requested:readonly string[],context:AptOperationContext,options:AptInstallOptions={}):Promise<string[]>{
  let selected:string[],settings:Required<AptInstallOptions>;try{selected=packages(requested);settings=installOptions(options);}catch(error){return Promise.reject(error);}
  return this.#operate('install',context,async ctx=>{this.#canMutate();await this.#refresh(ctx,settings.notify);const resolved=await this.#resolve(selected,ctx);if(!resolved.length){this.#config.notify?.('No packages detected');return [];}const targets=await this.#exactTargets(resolved,ctx);await this.#mutate('install',resolved,settings.timeout*1000,settings.notify,ctx,targets);return [...resolved];});
 }
 upgradeSystem(context:AptOperationContext):Promise<void>{return this.#operate('upgrade',context,async ctx=>{this.#canMutate();await this.#mutate('upgrade',[],3600000,true,ctx);});}
 async close():Promise<void>{this.#closing=true;this.#life.abort();await Promise.allSettled(this.#active?[this.#active]:[]);if(this.#ownsExecutor)await this.#executor.close?.();}
}
