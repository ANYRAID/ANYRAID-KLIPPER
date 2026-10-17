// Web deployment follows pinned Moonraker net_deploy.py.
// GPL-3.0-or-later. Directory transactions preserve a local rollback.
import {constants} from 'node:fs';
import {access,lstat,open,realpath} from 'node:fs/promises';
import {dirname,join,relative,isAbsolute,sep} from 'node:path';
import {homedir} from 'node:os';
import {ApiError,type Json} from './rpc.ts';
import {WebDirectoryTransaction} from './update-web-transaction.ts';
import {ExecutableFileTransaction,executableAssetName} from './update-executable-transaction.ts';
import type {MoonrakerHttpClient} from './http-client.ts';

export interface WebDeploymentConfiguration {
 name:string;path:string;repo:string;applicationType?:'zip'|'executable';channel:'stable'|'beta';channelInvalid:boolean;
 reportAnomalies:boolean;infoTags:string[];refreshInterval:number;configHash:string;persistentFiles?:string[];
}
export interface WebDeploymentStorage extends Record<string,Json> {
 last_refresh_time:number;last_config_hash:string;version:string;remote_version:string;
 rollback_version:string;rollback_repo:string;last_error:string;dl_info:[string,string,number];
 repo:string;directory_identity:string;asset_digest:string;local_asset_identity:string;
}
export const webRepository=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)&&!value.split('/').some(part=>part==='.'||part==='..');
const text=(value:unknown,max=4096):value is string=>typeof value==='string'&&value.length<=max&&value.isWellFormed()&&!/[\0\r\n]/u.test(value);
export async function readMetadata(root:string,name:string,signal:AbortSignal):Promise<string|undefined>{
 let fd;try{fd=await open(join(root,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 try{const before=await fd.stat({bigint:true});if(!before.isFile()||before.size>65536n)throw Error('Invalid web version metadata');const bytes=Buffer.alloc(65537);let at=0;while(at<bytes.length){signal.throwIfAborted();const read=await fd.read(bytes,at,bytes.length-at,null);if(!read.bytesRead)break;at+=read.bytesRead;}if(at>65536)throw Error('Web version metadata exceeds capacity');const after=await fd.stat({bigint:true});if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw Error('Web version metadata changed during read');return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,at));}finally{await fd.close();}
}
export class WebDeployment {
 readonly config:WebDeploymentConfiguration;readonly #http:MoonrakerHttpClient;readonly #reserved:readonly string[];readonly #transaction:WebDirectoryTransaction|ExecutableFileTransaction;
 #repo:string;#valid=false;#warnings:string[]=[];#anomalies:string[]=[];
 #saved:WebDeploymentStorage={last_refresh_time:0,last_config_hash:'',version:'?',remote_version:'?',rollback_version:'?',rollback_repo:'?',last_error:'',dl_info:['?','?',0],repo:'',directory_identity:'',asset_digest:'',local_asset_identity:''};
 constructor(config:WebDeploymentConfiguration,http:MoonrakerHttpClient,reserved:readonly string[]=[]){this.config=config;this.#repo=config.repo;this.#http=http;this.#reserved=[...reserved];this.#transaction=config.applicationType==='executable'?new ExecutableFileTransaction(config.path):new WebDirectoryTransaction(config.path,config.applicationType==='zip');}
 restore(value:unknown):void{
  if(value===undefined)return;if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid saved web update state');const row=value as Record<string,unknown>;
  for(const key of ['version','remote_version','rollback_version','rollback_repo','last_error','last_config_hash','repo','directory_identity'])if(!text(row[key]))throw Error('Invalid saved web update text');
  if(typeof row.last_refresh_time!=='number'||!Number.isFinite(row.last_refresh_time)||row.last_refresh_time<0||!Array.isArray(row.dl_info)||row.dl_info.length!==3||!text(row.dl_info[0])||!text(row.dl_info[1])||!Number.isSafeInteger(row.dl_info[2])||(row.dl_info[2] as number)<0)throw Error('Invalid saved web update metadata');
  if(row.asset_digest!==undefined&&(typeof row.asset_digest!=='string'||row.asset_digest!==''&&!/^sha256:[0-9a-f]{64}$/u.test(row.asset_digest)))throw Error('Invalid saved web digest');
  if(row.local_asset_identity!==undefined&&!text(row.local_asset_identity))throw Error('Invalid executable identity');
  if(row.last_config_hash===this.config.configHash)this.#saved={...structuredClone(value) as WebDeploymentStorage,asset_digest:(row.asset_digest as string|undefined)??'',local_asset_identity:(row.local_asset_identity as string|undefined)??''};
 }
 get lastRefresh(){return this.#saved.last_refresh_time;}
 needsRefresh(now=Date.now()/1000){return this.#saved.last_config_hash!==this.config.configHash||now>=this.lastRefresh+this.config.refreshInterval;}
 get storage():WebDeploymentStorage{return structuredClone(this.#saved);}
 get status():Record<string,Json>{const [owner,repo]=this.#repo.split('/');return {channel:this.config.channel,debug_enabled:false,channel_invalid:this.config.channelInvalid,is_valid:this.#valid,configured_type:this.config.applicationType??'web',info_tags:[...this.config.infoTags],name:this.config.name,repo_name:repo,owner,version:this.#saved.version,remote_version:this.#saved.remote_version,rollback_version:this.#saved.rollback_version,last_error:this.#saved.last_error,warnings:[...this.#warnings],anomalies:this.config.reportAnomalies?[...this.#anomalies]:[]};}
 async initialize(signal:AbortSignal):Promise<void>{try{await this.#validateLocation();}catch{await this.#validate(signal);return;}try{await this.#transaction.initialize();}finally{await this.#transaction.close();}await this.#validate(signal);const rollback=this.#transaction.rollback;if(rollback){this.#saved.rollback_version=rollback.version;this.#saved.rollback_repo=rollback.repo;}}
 async #validateLocation():Promise<void>{const root=this.config.path;if(await realpath(dirname(root))!==dirname(root))throw Error('Web parent is not canonical');
   const contains=(parent:string,child:string)=>{const part=relative(parent,child);return part===''||!isAbsolute(part)&&part!=='..'&&!part.startsWith('..'+sep);};
   for(const reserved of this.#reserved){let canonical=reserved;try{canonical=await realpath(reserved);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(contains(root,canonical)||contains(canonical,root)||contains(this.#transaction.directory,canonical)||contains(canonical,this.#transaction.directory)){this.#warnings.push('Location at option path overlaps a reserved process path.');throw Error('Reserved web deployment path');}}
   for(let parent=root;;parent=dirname(parent)){if(parent===homedir())break;try{await lstat(join(parent,'.git'));this.#warnings.push('Location at option path is within a git repo.');throw Error('Web deployment is within a git repo');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(dirname(parent)===parent)break;}
 }
 async #validate(signal:AbortSignal):Promise<void>{
  this.#valid=false;this.#warnings=[];this.#anomalies=[];this.#repo=this.config.repo;this.#saved.version='?';this.#release=undefined;this.#saved.local_asset_identity='';
  const root=this.config.path;signal.throwIfAborted();
  try{
   await this.#validateLocation();const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(root)!==root)throw Error('Location at option path is not a physical directory');await access(root,constants.W_OK);
   const release=await readMetadata(root,'release_info.json',signal);
   if(release!==undefined){
    const value:unknown=JSON.parse(release);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid release info');const row=value as Record<string,unknown>;
    if(!text(row.project_owner)||!row.project_owner||!text(row.project_name)||!row.project_name)throw Error('Invalid release repository fields');const detected=row.project_owner+'/'+row.project_name;
    if(!webRepository(detected)||!text(row.version)||row.asset_name!==undefined&&!text(row.asset_name))throw Error('Invalid release info fields');
    if(this.config.applicationType==='executable'){if(!executableAssetName(row.asset_name))throw Error('Executable release info requires a safe asset_name');const binary=await lstat(join(root,row.asset_name),{bigint:true});if(!binary.isFile()||binary.isSymbolicLink()||binary.size>128n*1024n**2n)throw Error('Invalid executable installation');this.#saved.local_asset_identity=[binary.dev,binary.ino,binary.size,binary.mtimeNs,binary.ctimeNs,binary.mode].join(':');}
    this.#release=row;this.#saved.version=row.version;this.#valid=true;this.#detectedRepo(detected);this.#asset=typeof row.asset_name==='string'?row.asset_name:undefined;
   }else{
    if(this.config.applicationType)throw Error('Application requires release_info.json');this.#asset=undefined;const version=await readMetadata(root,'.version',signal);if(version!==undefined){if(!text(version.trim()))throw Error('Invalid web version');this.#saved.version=version.trim();}
    for(const name of ['manifest.json','manifest.webmanifest']){const manifest=await readMetadata(root,name,signal);if(manifest===undefined)continue;let row:unknown;try{row=JSON.parse(manifest);}catch{continue;}const nameValue=row&&typeof row==='object'&&!Array.isArray(row)?(row as Record<string,unknown>).name:undefined;
     if(typeof nameValue!=='string')continue;const project=nameValue.toLowerCase(),owner=project==='mainsail'?'mainsail-crew':project==='fluidd'?'fluidd-core':undefined;if(owner){this.#detectedRepo(owner+'/'+project);this.#valid=true;break;}
    }
   }
   const after=await lstat(root);if(info.dev!==after.dev||info.ino!==after.ino||after.isSymbolicLink())throw Error('Web deployment directory changed');
   const identity=String(info.dev)+':'+String(info.ino);if(this.#saved.repo!==this.#repo||this.#saved.directory_identity!==identity){this.#invalidateRemote();this.#saved.repo=this.#repo;this.#saved.directory_identity=identity;}
   if(this.#valid&&this.#saved.rollback_version==='?'){this.#saved.rollback_version=this.#saved.version;this.#saved.rollback_repo=this.#repo;}
  }catch{signal.throwIfAborted();this.#valid=false;this.#invalidateRemote();this.#warnings.push('Unable to read valid web installation metadata.');}
  if(!this.#valid)this.#warnings.push('Failed to validate installation');
 }
 #asset:string|undefined;#release:Record<string,unknown>|undefined;
 #invalidateRemote(){this.#saved.remote_version='?';this.#saved.dl_info=['?','?',0];this.#saved.asset_digest='';this.#saved.rollback_version='?';this.#saved.rollback_repo='?';this.#saved.last_refresh_time=0;}
 #detectedRepo(detected:string):void{if(this.#repo.toLowerCase()!==detected.toLowerCase())this.#anomalies.push('Configured repo does not match detected repo; using detected version.');this.#repo=detected;}
 async refresh(signal:AbortSignal):Promise<void>{
  await this.#validate(signal);signal.throwIfAborted();
  if(this.#valid)try{
   const resource='repos/'+this.#repo+'/releases'+(this.config.channel==='stable'?'/latest':'?per_page=1');
   const response=await this.#http.githubApiRequest(resource,{attempts:3,retryPauseTime:0.5,requestTimeout:15,maxBodyBytes:1048576,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});signal.throwIfAborted();
   if(response.statusCode===304&&!response.content.length)return this.#markRefresh();
   response.raiseForStatus();const decoded:unknown=response.json(),result=Array.isArray(decoded)?decoded[0]:decoded;
   if(result&&typeof result==='object'&&!Array.isArray(result)){
    const release=result as Record<string,unknown>,version=release.tag_name||release.name||'?';if(!text(version))throw Error('Invalid remote release version');
    const assets=Array.isArray(release.assets)?release.assets:[],asset=(this.#asset?assets.find(v=>v&&typeof v==='object'&&(v as Record<string,unknown>).name===this.#asset):undefined)??assets[0]??{};
    if(this.config.applicationType==='executable'&&(!asset||typeof asset!=='object'||(asset as Record<string,unknown>).name!==this.#asset))throw Error('Executable release asset_name is absent from the release');
    const row=asset&&typeof asset==='object'?asset as Record<string,unknown>:{},url=row.browser_download_url??'?',type=row.content_type??'?',size=row.size??0;
    if(!text(url)||!text(type)||!Number.isSafeInteger(size)||(size as number)<0)throw Error('Invalid remote release asset');if(row.digest!==undefined&&row.digest!==null&&(typeof row.digest!=='string'||!/^sha256:[0-9a-f]{64}$/u.test(row.digest)))throw Error('Unsupported remote asset digest');this.#saved.remote_version=version;this.#saved.dl_info=[url,type,size as number];this.#saved.asset_digest=typeof row.digest==='string'?row.digest:'';
   }
   this.#saved.last_error='';
  }catch{signal.throwIfAborted();this.#saved.last_error='Unable to refresh GitHub release metadata';}
  this.#markRefresh();
 }
 async deploy(rollback:boolean,signal:AbortSignal,admit:()=>void|Promise<void>,notify:(message:string)=>void,beforePublish?:(stage:string,rollback:boolean)=>Promise<void>):Promise<boolean>{
  await this.#validateLocation();try{await this.#transaction.initialize();return await this.#deploy(rollback,signal,admit,notify,beforePublish);}finally{await this.#transaction.close();}
 }
 async #deploy(rollback:boolean,signal:AbortSignal,admit:()=>void|Promise<void>,notify:(message:string)=>void,beforePublish?: (stage:string,rollback:boolean)=>Promise<void>):Promise<boolean>{
  const expectedAsset=this.#saved.local_asset_identity,expected=this.#saved.directory_identity,remote=this.#saved.remote_version,download=[...this.#saved.dl_info] as [string,string,number],digest=this.#saved.asset_digest,selectedRepo=this.#saved.repo;
  await this.#validate(signal);if(!this.#valid||this.#saved.directory_identity!==expected||this.#saved.local_asset_identity!==expectedAsset||this.#saved.repo!==selectedRepo||!rollback&&(this.#saved.remote_version!==remote||this.#saved.last_config_hash!==this.config.configHash))throw new ApiError(409,'Web installation identity or selected release changed or is invalid');
  const oldVersion=this.#saved.version,repo=this.#repo,previous=this.#transaction.rollback;
  if(rollback&&!previous)throw new ApiError(409,'No verified Web rollback is available');
  const version=rollback?previous!.version:remote;if(!rollback&&version===oldVersion)return false;if(version==='?')throw new ApiError(409,'Web update metadata is unavailable');
  if(rollback&&previous!.repo!==repo)throw new ApiError(409,'Web rollback repository differs from the installation');
  let stage:string|undefined,committing=false;
  try{
   if(rollback){notify('Preparing local rollback');stage=await this.#transaction.rollbackStage(signal);}
   else{
    const [url,type,size]=download;let parsed:URL;try{parsed=new URL(url);}catch{throw new ApiError(409,'Invalid Web download URL');}if(!['https:','http:'].includes(parsed.protocol)||parsed.username||parsed.password||size<1||size>128*1024**2)throw new ApiError(409,'Invalid Web download metadata');
    stage=await this.#transaction.stage(signal);const archive=stage+'.zip';
    try{notify('Downloading Web release');await this.#http.downloadFile(url,type,{destinationPath:archive,downloadSize:size,maxBodyBytes:128*1024**2,requestTimeout:180,signal,progress:(percent,total,received)=>notify('Downloading: '+percent+'% ('+received+' / '+total+' bytes)')});if(this.#transaction instanceof ExecutableFileTransaction)await this.#transaction.prepare(archive,stage,size,digest,this.#asset!,{...this.#release!,version},signal);else await this.#transaction.archive(archive,stage,size,digest,signal);}finally{await import('node:fs/promises').then(fs=>fs.rm(archive,{force:true}));}
   }
   await this.#transaction.preserve(stage,this.config.persistentFiles??[],signal);
   const candidate=new WebDeployment({...this.config,path:stage},this.#http);await candidate.#validate(signal);
   if(!candidate.#valid||candidate.#saved.version!==version||candidate.#repo.toLowerCase()!==repo.toLowerCase())throw new ApiError(422,'Web release metadata does not match the selected version and repository');
   await beforePublish?.(stage,rollback);signal.throwIfAborted();
   notify('Publishing release');
   await this.#validate(signal);if(!this.#valid||this.#saved.directory_identity!==expected||this.#saved.local_asset_identity!==expectedAsset||this.#saved.version!==oldVersion||this.#repo!==repo)throw new ApiError(409,'Web installation changed before publication');
   committing=true;await this.#transaction.publish(stage,expected,oldVersion,repo,signal,admit);stage=undefined;
   const saved={remote_version:remote,dl_info:download,asset_digest:digest,last_refresh_time:this.#saved.last_refresh_time,last_config_hash:this.#saved.last_config_hash};
   await this.#validate(new AbortController().signal);Object.assign(this.#saved,saved);this.#saved.rollback_version=oldVersion;this.#saved.rollback_repo=repo;this.#saved.last_error='';return true;
  }catch(error){this.#saved.last_error='Web deployment failed';throw error;}finally{if(stage&&!committing)await this.#transaction.discard(stage);}
 }
 #markRefresh(){this.#saved.last_refresh_time=Date.now()/1000;this.#saved.last_config_hash=this.config.configHash;}
}
