// Read-only web deployment status follows pinned Moonraker net_deploy.py.
// GPL-3.0-or-later. Installation/update capabilities are deliberately separate.
import {constants} from 'node:fs';
import {access,lstat,open,realpath} from 'node:fs/promises';
import {dirname,join,relative,isAbsolute,sep} from 'node:path';
import {homedir} from 'node:os';
import type {Json} from './rpc.ts';
import type {MoonrakerHttpClient} from './http-client.ts';

export interface WebDeploymentConfiguration {
 name:string;path:string;repo:string;channel:'stable'|'beta';channelInvalid:boolean;
 reportAnomalies:boolean;infoTags:string[];refreshInterval:number;configHash:string;
}
export interface WebDeploymentStorage extends Record<string,Json> {
 last_refresh_time:number;last_config_hash:string;version:string;remote_version:string;
 rollback_version:string;rollback_repo:string;last_error:string;dl_info:[string,string,number];
 repo:string;directory_identity:string;
}
export const webRepository=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)&&!value.split('/').some(part=>part==='.'||part==='..');
const text=(value:unknown,max=4096):value is string=>typeof value==='string'&&value.length<=max&&value.isWellFormed()&&!/[\0\r\n]/u.test(value);
async function readMetadata(root:string,name:string,signal:AbortSignal):Promise<string|undefined>{
 let fd;try{fd=await open(join(root,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 try{const before=await fd.stat({bigint:true});if(!before.isFile()||before.size>65536n)throw Error('Invalid web version metadata');const bytes=Buffer.alloc(65537);let at=0;while(at<bytes.length){signal.throwIfAborted();const read=await fd.read(bytes,at,bytes.length-at,null);if(!read.bytesRead)break;at+=read.bytesRead;}if(at>65536)throw Error('Web version metadata exceeds capacity');const after=await fd.stat({bigint:true});if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw Error('Web version metadata changed during read');return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,at));}finally{await fd.close();}
}
export class WebDeployment {
 readonly config:WebDeploymentConfiguration;readonly #http:MoonrakerHttpClient;readonly #reserved:readonly string[];
 #repo:string;#valid=false;#warnings:string[]=[];#anomalies:string[]=[];
 #saved:WebDeploymentStorage={last_refresh_time:0,last_config_hash:'',version:'?',remote_version:'?',rollback_version:'?',rollback_repo:'?',last_error:'',dl_info:['?','?',0],repo:'',directory_identity:''};
 constructor(config:WebDeploymentConfiguration,http:MoonrakerHttpClient,reserved:readonly string[]=[]){this.config=config;this.#repo=config.repo;this.#http=http;this.#reserved=[...reserved];}
 restore(value:unknown):void{
  if(value===undefined)return;if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid saved web update state');const row=value as Record<string,unknown>;
  for(const key of ['version','remote_version','rollback_version','rollback_repo','last_error','last_config_hash','repo','directory_identity'])if(!text(row[key]))throw Error('Invalid saved web update text');
  if(typeof row.last_refresh_time!=='number'||!Number.isFinite(row.last_refresh_time)||row.last_refresh_time<0||!Array.isArray(row.dl_info)||row.dl_info.length!==3||!text(row.dl_info[0])||!text(row.dl_info[1])||!Number.isSafeInteger(row.dl_info[2])||(row.dl_info[2] as number)<0)throw Error('Invalid saved web update metadata');
  if(row.last_config_hash===this.config.configHash)this.#saved=structuredClone(value) as WebDeploymentStorage;
 }
 get lastRefresh(){return this.#saved.last_refresh_time;}
 needsRefresh(now=Date.now()/1000){return this.#saved.last_config_hash!==this.config.configHash||now>=this.lastRefresh+this.config.refreshInterval;}
 get storage():WebDeploymentStorage{return structuredClone(this.#saved);}
 get status():Record<string,Json>{const [owner,repo]=this.#repo.split('/');return {channel:this.config.channel,debug_enabled:false,channel_invalid:this.config.channelInvalid,is_valid:this.#valid,configured_type:'web',info_tags:[...this.config.infoTags],name:this.config.name,repo_name:repo,owner,version:this.#saved.version,remote_version:this.#saved.remote_version,rollback_version:this.#saved.rollback_version,last_error:this.#saved.last_error,warnings:[...this.#warnings],anomalies:this.config.reportAnomalies?[...this.#anomalies]:[]};}
 async initialize(signal:AbortSignal):Promise<void>{await this.#validate(signal);}
 async #validate(signal:AbortSignal):Promise<void>{
  this.#valid=false;this.#warnings=[];this.#anomalies=[];this.#repo=this.config.repo;this.#saved.version='?';
  const root=this.config.path;signal.throwIfAborted();
  try{
   const contains=(parent:string,child:string)=>{const part=relative(parent,child);return part===''||!isAbsolute(part)&&part!=='..'&&!part.startsWith('..'+sep);};
   for(const reserved of this.#reserved){let canonical=reserved;try{canonical=await realpath(reserved);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(contains(root,canonical)||contains(canonical,root)){this.#warnings.push('Location at option path overlaps a reserved process path.');throw Error('Reserved web deployment path');}}
   const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(root)!==root)throw Error('Location at option path is not a physical directory');await access(root,constants.W_OK);
   for(let parent=root;;parent=dirname(parent)){if(parent===homedir())break;try{await lstat(join(parent,'.git'));this.#warnings.push('Location at option path is within a git repo.');throw Error('Web deployment is within a git repo');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(dirname(parent)===parent)break;}
   const release=await readMetadata(root,'release_info.json',signal);
   if(release!==undefined){
    const value:unknown=JSON.parse(release);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid release info');const row=value as Record<string,unknown>;
    if(!text(row.project_owner)||!row.project_owner||!text(row.project_name)||!row.project_name)throw Error('Invalid release repository fields');const detected=row.project_owner+'/'+row.project_name;
    if(!webRepository(detected)||!text(row.version)||row.asset_name!==undefined&&!text(row.asset_name))throw Error('Invalid release info fields');
    this.#saved.version=row.version;this.#valid=true;this.#detectedRepo(detected);this.#asset=typeof row.asset_name==='string'?row.asset_name:undefined;
   }else{
    this.#asset=undefined;const version=await readMetadata(root,'.version',signal);if(version!==undefined){if(!text(version.trim()))throw Error('Invalid web version');this.#saved.version=version.trim();}
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
 #asset:string|undefined;
 #invalidateRemote(){this.#saved.remote_version='?';this.#saved.dl_info=['?','?',0];this.#saved.rollback_version='?';this.#saved.rollback_repo='?';this.#saved.last_refresh_time=0;}
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
    const row=asset&&typeof asset==='object'?asset as Record<string,unknown>:{},url=row.browser_download_url??'?',type=row.content_type??'?',size=row.size??0;
    if(!text(url)||!text(type)||!Number.isSafeInteger(size)||(size as number)<0)throw Error('Invalid remote release asset');this.#saved.remote_version=version;this.#saved.dl_info=[url,type,size as number];
   }
   this.#saved.last_error='';
  }catch{signal.throwIfAborted();this.#saved.last_error='Unable to refresh GitHub release metadata';}
  this.#markRefresh();
 }
 #markRefresh(){this.#saved.last_refresh_time=Date.now()/1000;this.#saved.last_config_hash=this.config.configHash;}
}
