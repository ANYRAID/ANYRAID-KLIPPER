// Single executable + release_info transaction. GPL-3.0-or-later.
// The containing application directory and every other entry remain in place.
import {constants} from 'node:fs';
import {open,lstat,realpath,mkdir,readdir,rename,rm,chmod} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {join,dirname,basename} from 'node:path';
import {ApiError} from './rpc.ts';
const MAX=128*1024**2;
export const executableAssetName=(name:unknown):name is string=>typeof name==='string'&&name.length<=255&&/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/u.test(name)&&!['release_info.json','.','..'].includes(name.toLowerCase())&&!/[. ]$/u.test(name)&&!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name);
const fail=()=>new ApiError(409,'Executable transaction identity is inconsistent; inspect the durable operation before retrying');
const identity=(s:{dev:bigint;ino:bigint})=>`${s.dev}:${s.ino}`;
interface FileIdentity {id:string;sha256:string;mode:number;size:number;}
interface Pair {binary:FileIdentity;metadata:FileIdentity;}
interface Backup {name:string;id:string;version:string;repo:string;asset:string;files:Pair;}
interface Intent {schema:1;target:string;parent:string;root:string;before:Pair;old:Backup;candidate:{name:string;id:string;files:Pair};previous:Backup|null;}
const same=(a:FileIdentity|undefined,b:FileIdentity)=>!!a&&a.id===b.id&&a.sha256===b.sha256&&a.mode===b.mode&&a.size===b.size;
const pairSame=(a:Pair,b:Pair)=>same(a.binary,b.binary)&&same(a.metadata,b.metadata);
const privateName=(s:unknown):s is string=>typeof s==='string'&&/^(?:old|stage)-[a-f0-9-]{36}$/u.test(s);
const validFile=(v:unknown):v is FileIdentity=>!!v&&typeof v==='object'&&/^\d+:\d+$/u.test((v as FileIdentity).id)&&/^[a-f0-9]{64}$/u.test((v as FileIdentity).sha256)&&Number.isSafeInteger((v as FileIdentity).size)&&(v as FileIdentity).size>=0&&(v as FileIdentity).size<=MAX&&Number.isSafeInteger((v as FileIdentity).mode)&&(v as FileIdentity).mode>=0&&(v as FileIdentity).mode<=0o777;
const validPair=(v:unknown):v is Pair=>!!v&&typeof v==='object'&&validFile((v as Pair).binary)&&validFile((v as Pair).metadata);
const validBackup=(v:unknown):v is Backup=>!!v&&typeof v==='object'&&privateName((v as Backup).name)&&/^\d+:\d+$/u.test((v as Backup).id)&&typeof(v as Backup).version==='string'&&(v as Backup).version.length<=4096&&typeof(v as Backup).repo==='string'&&(v as Backup).repo.length<=4096&&executableAssetName((v as Backup).asset)&&validPair((v as Backup).files);
async function directory(path:string):Promise<string>{const info=await lstat(path,{bigint:true});if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path)throw fail();return identity(info);}
async function sync(path:string){const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{await fd.sync();}finally{await fd.close();}}
async function read(path:string,signal:AbortSignal,max=MAX,copyTo?:string):Promise<{identity:FileIdentity;bytes?:Buffer}>{
 signal.throwIfAborted();const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let output:FileHandle|undefined;
 try{const before=await fd.stat({bigint:true});if(!before.isFile()||before.size>BigInt(max))throw fail();if(copyTo)output=await open(copyTo,'wx',0o600);const hash=createHash('sha256'),chunks:Buffer[]=[];let total=0;
  while(total<Number(before.size)){signal.throwIfAborted();const buffer=Buffer.allocUnsafe(Math.min(65536,Number(before.size)-total)),n=(await fd.read(buffer,0,buffer.length,total)).bytesRead;if(!n)throw fail();const bytes=buffer.subarray(0,n);hash.update(bytes);if(max===65536)chunks.push(Buffer.from(bytes));if(output){let at=0;while(at<n){const written=(await output.write(bytes,at,n-at,null)).bytesWritten;if(!written)throw fail();at+=written;}}total+=n;}
  const after=await fd.stat({bigint:true});if((['dev','ino','size','mtimeNs','ctimeNs','mode'] as const).some(key=>before[key]!==after[key]))throw fail();if(output){await output.chmod(Number(before.mode)&0o777);await output.sync();}return {identity:{id:identity(before),sha256:hash.digest('hex'),mode:Number(before.mode)&0o777,size:total},...max===65536?{bytes:Buffer.concat(chunks)}:{}};
 }finally{await Promise.all([fd.close(),output?.close()]);}
}
async function pair(path:string,asset:string,signal:AbortSignal):Promise<Pair>{return {binary:(await read(join(path,asset),signal)).identity,metadata:(await read(join(path,'release_info.json'),signal,65536)).identity};}
async function json(path:string):Promise<unknown>{try{return JSON.parse((await read(path,new AbortController().signal,65536)).bytes!.toString('utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}}
async function store(path:string,value:unknown){const temporary=path+'.'+randomUUID(),fd=await open(temporary,'wx',0o600);try{await fd.writeFile(JSON.stringify(value));await fd.sync();}finally{await fd.close();}await rename(temporary,path);await sync(dirname(path));}
export class ExecutableFileTransaction {
 readonly target:string;readonly directory:string;#root='';#parent='';#lock:FileHandle|undefined;#backup:Backup|undefined;
 constructor(target:string){this.target=target;this.directory=join(dirname(target),'.anyraid-exec-'+createHash('sha256').update(target).digest('hex').slice(0,20));}
 async initialize(){if(this.#lock)throw fail();this.#parent=await directory(dirname(this.target));this.#root=await directory(this.target);await mkdir(this.directory,{mode:0o700}).catch(e=>{if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;});const info=await lstat(this.directory);if(info.isSymbolicLink()||!info.isDirectory()||await realpath(this.directory)!==this.directory||process.getuid&&info.uid!==process.getuid()||(info.mode&0o077)!==0)throw fail();
  const lock=await open(this.directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{(createRequire(import.meta.url)('../../build/sealed-file.node') as {lockDirectory(fd:number):void}).lockDirectory(lock.fd);this.#lock=lock;}catch{await lock.close();throw fail();}
  const saved=await json(join(this.directory,'backup.json'));if(saved!==undefined&&!validBackup(saved))throw fail();this.#backup=saved as Backup|undefined;const value=await json(join(this.directory,'intent.json'));
  if(value!==undefined){const intent=value as Intent;if(!intent||intent.schema!==1||intent.target!==this.target||intent.root!==this.#root||intent.parent!==this.#parent||!validPair(intent.before)||!validBackup(intent.old)||!intent.candidate||!privateName(intent.candidate.name)||!/^\d+:\d+$/u.test(intent.candidate.id)||!validPair(intent.candidate.files)||intent.previous!==null&&!validBackup(intent.previous))throw fail();await this.#recover(intent);}
  if(this.#backup)await this.#verifyBackup(this.#backup);await sync(dirname(this.target));
 }
 async close(){const lock=this.#lock;this.#lock=undefined;await lock?.close();}
 get rollback(){return this.#backup?{version:this.#backup.version,repo:this.#backup.repo}:undefined;}
 async stage(signal:AbortSignal){signal.throwIfAborted();if(!this.#lock)throw fail();const path=join(this.directory,'stage-'+randomUUID());await mkdir(path,{mode:0o700});return path;}
 async prepare(download:string,stage:string,size:number,digest:string,asset:string,metadata:Record<string,unknown>,signal:AbortSignal){
  this.#stage(stage);if(!executableAssetName(asset)||!Number.isSafeInteger(size)||size<1||size>MAX)throw fail();const copied=await read(download,signal,MAX,join(stage,asset));if(copied.identity.size!==size||digest&&copied.identity.sha256!==digest.slice(7))throw new ApiError(422,'Executable download size or digest mismatch');await chmod(join(stage,asset),0o755);await sync(join(stage,asset));const fd=await open(join(stage,'release_info.json'),'wx',0o644);try{const bytes=JSON.stringify(metadata);if(Buffer.byteLength(bytes)>65536)throw fail();await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}await sync(stage);
 }
 async #verifyBackup(backup:Backup){const path=join(this.directory,backup.name);if(await directory(path)!==backup.id||!pairSame(await pair(path,backup.asset,new AbortController().signal),backup.files))throw fail();return path;}
 async rollbackStage(signal:AbortSignal){if(!this.#backup)throw new ApiError(409,'No verified executable rollback is available');const old=await this.#verifyBackup(this.#backup),stage=await this.stage(signal);await read(join(old,this.#backup.asset),signal,MAX,join(stage,this.#backup.asset));await read(join(old,'release_info.json'),signal,65536,join(stage,'release_info.json'));await sync(stage);return stage;}
 async preserve(_stage:string,_names:readonly string[],signal:AbortSignal){signal.throwIfAborted();}
 #stage(path:string){if(!this.#lock||dirname(path)!==this.directory||!privateName(basename(path))||!basename(path).startsWith('stage-'))throw fail();}
 async discard(path:string){this.#stage(path);await rm(path,{recursive:true,force:true});}
 async publish(stage:string,expected:string,version:string,repo:string,signal:AbortSignal,admit:()=>void|Promise<void>){
  this.#stage(stage);signal.throwIfAborted();await admit();signal.throwIfAborted();if(expected!==this.#root||await directory(this.target)!==expected||await directory(dirname(this.target))!==this.#parent)throw fail();const metadata=await json(join(stage,'release_info.json')) as Record<string,unknown>;if(!metadata||!executableAssetName(metadata.asset_name))throw fail();const asset=metadata.asset_name,entries=await readdir(stage);if(entries.length!==2||!entries.includes(asset)||!entries.includes('release_info.json'))throw fail();
  const oldMetadata=await json(join(this.target,'release_info.json')) as Record<string,unknown>;if(!oldMetadata||oldMetadata.asset_name!==asset||oldMetadata.version!==version||oldMetadata.project_owner+'/'+oldMetadata.project_name!==repo)throw fail();const before=await pair(this.target,asset,signal),name='old-'+randomUUID(),oldPath=join(this.directory,name);await mkdir(oldPath,{mode:0o700});
  await read(join(this.target,asset),signal,MAX,join(oldPath,asset));await read(join(this.target,'release_info.json'),signal,65536,join(oldPath,'release_info.json'));await sync(oldPath);
  if(!pairSame(before,await pair(this.target,asset,signal)))throw fail();const intent:Intent={schema:1,target:this.target,parent:this.#parent,root:this.#root,before,old:{name,id:await directory(oldPath),version,repo,asset,files:await pair(oldPath,asset,signal)},candidate:{name:basename(stage),id:await directory(stage),files:await pair(stage,asset,signal)},previous:this.#backup??null};await store(join(this.directory,'intent.json'),intent);
  try{signal.throwIfAborted();await admit();signal.throwIfAborted();if(await directory(this.target)!==expected||await directory(dirname(this.target))!==this.#parent||!pairSame(before,await pair(this.target,asset,signal)))throw fail();}catch(error){await this.#recover(intent);throw error;}
  // Once the first file moves, cancellation drains this pair to one durable
  // version. Reopen only repairs files; application services are never replayed.
  await rename(join(stage,asset),join(this.target,asset));await sync(this.target);await sync(stage);await rename(join(stage,'release_info.json'),join(this.target,'release_info.json'));await sync(this.target);await sync(stage);await this.#recover(intent);
 }
 async #recover(intent:Intent){
  if(await directory(this.target)!==intent.root||await directory(dirname(this.target))!==intent.parent)throw fail();const asset=intent.old.asset,stage=join(this.directory,intent.candidate.name);const stageId=await directory(stage).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;});if(stageId!==undefined&&stageId!==intent.candidate.id)throw fail();let current=await pair(this.target,asset,new AbortController().signal);
  if(pairSame(current,intent.before)){await this.#verifyBackup(intent.old);await rm(join(this.directory,'intent.json'));await sync(this.directory);if(stageId)await this.discard(stage);await rm(join(this.directory,intent.old.name),{recursive:true});}
  else{
   await this.#verifyBackup(intent.old);if(same(current.binary,intent.candidate.files.binary)&&same(current.metadata,intent.before.metadata)){if(!stageId||!same((await read(join(stage,'release_info.json'),new AbortController().signal,65536)).identity,intent.candidate.files.metadata))throw fail();await rename(join(stage,'release_info.json'),join(this.target,'release_info.json'));await sync(this.target);await sync(stage);current=await pair(this.target,asset,new AbortController().signal);}
   if(!pairSame(current,intent.candidate.files))throw fail();await store(join(this.directory,'backup.json'),intent.old);this.#backup=intent.old;await rm(join(this.directory,'intent.json'));await sync(this.directory);
   if(intent.previous){await this.#verifyBackup(intent.previous);await rm(join(this.directory,intent.previous.name),{recursive:true});}if(stageId)await this.discard(stage);
  }
  await sync(this.directory);
 }
}
