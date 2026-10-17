// Web-only directory transaction. GPL-3.0-or-later.
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open,lstat,realpath,mkdir,rename,rm,readdir,opendir,chmod,readlink,symlink} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {join,dirname,basename,relative,isAbsolute,sep} from 'node:path';
import {Readable} from 'node:stream';
import {crc32} from 'node:zlib';
import {RandomAccessReader,fromRandomAccessReaderPromise,type ZipFile} from 'yauzl';
import {ApiError} from './rpc.ts';
import {createRequire} from 'node:module';
const MAX_ARCHIVE=128*1024**2,MAX_CONTENT=512*1024**2,MAX_FILE=128*1024**2,MAX_ENTRIES=10000;
const fail=()=>new ApiError(409,'Web transaction identity is inconsistent; manual inspection is required');
const identity=(s:{dev:number;ino:number})=>s.dev+':'+s.ino;
async function id(path:string):Promise<string|undefined>{try{const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink())throw fail();return identity(s);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}}
async function sync(path:string){const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{await h.sync();}finally{await h.close();}}
async function json(path:string):Promise<unknown>{let h;try{h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}try{const s=await h.stat();if(!s.isFile()||s.size>16384)throw fail();return JSON.parse(await h.readFile('utf8'));}finally{await h.close();}}
async function store(path:string,value:unknown){const tmp=path+'.'+randomUUID(),h=await open(tmp,'wx',0o600);try{await h.writeFile(JSON.stringify(value));await h.sync();}finally{await h.close();}await rename(tmp,path);await sync(dirname(path));}
const safeName=(n:unknown):n is string=>typeof n==='string'&&/^(?:stage|old)-[0-9a-f-]{36}$/u.test(n);
interface Backup {name:string;id:string;version:string;repo:string;}
interface Intent {schema:1;target:string;parent:string;old:Backup;candidate:{name:string;id:string};previous:Backup|null;}
function backup(value:unknown):value is Backup{if(!value||typeof value!=='object')return false;const r=value as Backup;return safeName(r.name)&&typeof r.id==='string'&&/^\d+:\d+$/u.test(r.id)&&typeof r.version==='string'&&r.version.length<=4096&&typeof r.repo==='string'&&r.repo.length<=4096;}
/** Every archive read is asynchronous and drained before its descriptor closes. */
class ArchiveReader extends RandomAccessReader {
 readonly reads=new Set<Promise<unknown>>();readonly streams=new Set<Readable>();stopped=false;
 readonly source:FileHandle;readonly signal:AbortSignal;
 constructor(source:FileHandle,signal:AbortSignal){super();this.source=source;this.signal=signal;this.on('error',()=>{});}
 override _readStreamForRange(start:number,end:number):Readable{const self=this;const stream=Readable.from((async function*(){for(let at=start;at<end;){self.signal.throwIfAborted();if(self.stopped)throw Error('Archive closed');const bytes=Buffer.allocUnsafe(Math.min(65536,end-at)),pending=self.source.read(bytes,0,bytes.length,at);self.reads.add(pending);let count:number;try{count=(await pending).bytesRead;}finally{self.reads.delete(pending);}self.signal.throwIfAborted();if(self.stopped||!count)throw Error('Truncated archive');at+=count;yield bytes.subarray(0,count);}})(),{objectMode:false});this.streams.add(stream);stream.on('error',()=>{});stream.once('close',()=>this.streams.delete(stream));return stream;}
 stop(){this.stopped=true;for(const s of this.streams)s.destroy();}
 async drain(){while(this.reads.size)await Promise.allSettled([...this.reads]);}
 override close(callback:(error:Error|null)=>void){void this.drain().then(()=>callback(null),callback);}
}
async function extract(path:string,target:string,size:number,digest:string,signal:AbortSignal,applicationPermissions=false){
 const source=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let reader:ArchiveReader|undefined,zip:ZipFile|undefined,active:Readable|undefined;
 const abort=()=>{active?.destroy(signal.reason instanceof Error?signal.reason:Error('Cancelled'));reader?.stop();};signal.addEventListener('abort',abort,{once:true});
 try{const before=await source.stat({bigint:true});if(!before.isFile()||before.size!==BigInt(size)||size<1||size>MAX_ARCHIVE)throw new ApiError(422,'Web archive size mismatch or exceeds capacity');
  const hash=createHash('sha256');for(let at=0;at<size;){signal.throwIfAborted();const bytes=Buffer.allocUnsafe(Math.min(65536,size-at)),read=await source.read(bytes,0,bytes.length,at);if(!read.bytesRead)throw Error('Truncated archive');hash.update(bytes.subarray(0,read.bytesRead));at+=read.bytesRead;}if(digest&&hash.digest('hex')!==digest.slice(7))throw new ApiError(422,'Web archive digest mismatch');
  reader=new ArchiveReader(source,signal);zip=await fromRandomAccessReaderPromise(reader,size,{lazyEntries:true,autoClose:false,decodeStrings:true,validateEntrySizes:true});zip.on('error',()=>{});if(zip.entryCount>MAX_ENTRIES)throw new ApiError(413,'Web archive entry capacity exceeded');
  const names=new Set<string>(),files=new Set<string>(),directories=new Set<string>();let total=0,count=0,directoryBytes=0;
  for await(const entry of zip.eachEntry()){
   signal.throwIfAborted();const raw=entry.fileName,name=raw.replace(/\/$/u,''),mode=(entry.externalFileAttributes>>>16)&0xf000,isDirectory=raw.endsWith('/');
   directoryBytes+=46+entry.fileNameLength+entry.extraFieldLength+entry.fileCommentLength;
   if(++count>MAX_ENTRIES||directoryBytes>4*1024**2||entry.uncompressedSize>MAX_FILE||(total+=entry.uncompressedSize)>MAX_CONTENT)throw new ApiError(413,'Web archive capacity exceeded');
   if(!name||Buffer.byteLength(name)>1024||/[\\\0:\x00-\x1f]/u.test(name)||name.startsWith('/')||name.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/u.test(p)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(p))||entry.isEncrypted()||![0,8].includes(entry.compressionMethod)||mode!==0&&mode!==(isDirectory?0x4000:0x8000)||isDirectory&&entry.uncompressedSize!==0)throw new ApiError(422,'Unsafe or unsupported Web archive entry');
   const key=name.toLowerCase();if(names.has(key)||!isDirectory&&directories.has(key))throw new ApiError(422,'Duplicate Web archive path');names.add(key);
   const parts=key.split('/');for(let i=1;i<parts.length;i++){const parent=parts.slice(0,i).join('/');if(files.has(parent))throw new ApiError(422,'Conflicting Web archive path');directories.add(parent);}if(isDirectory)directories.add(key);else files.add(key);
   const destination=join(target,...name.split('/'));await mkdir(isDirectory?destination:dirname(destination),{recursive:true,mode:0o755});for(let dir=isDirectory?destination:dirname(destination);dir!==target;dir=dirname(dir))await chmod(dir,0o755);
   if(!isDirectory){const output=await open(destination,'wx',0o600);try{active=await zip.openReadStreamPromise(entry);active.on('error',()=>{});let checksum=0,length=0;for await(const chunk of active){signal.throwIfAborted();const bytes=chunk as Buffer;if(length+bytes.length>entry.uncompressedSize)throw new ApiError(422,'Web member size mismatch');checksum=crc32(bytes,checksum);for(let at=0;at<bytes.length;){const n=(await output.write(bytes,at,bytes.length-at,null)).bytesWritten;if(!n)throw Error('Web write made no progress');at+=n;}length+=bytes.length;}if(length!==entry.uncompressedSize||checksum!==entry.crc32)throw new ApiError(422,'Web member CRC or size mismatch');await output.chmod(applicationPermissions?((entry.externalFileAttributes>>>16)&0o777)||0o644:0o644);await output.sync();}finally{active?.destroy();active=undefined;await output.close();}}
  }
  const after=await source.stat({bigint:true});if((['dev','ino','size','mtimeNs','ctimeNs'] as const).some(k=>before[k]!==after[k]))throw new ApiError(409,'Web archive changed');
 }catch(e){signal.throwIfAborted();if(e instanceof ApiError)throw e;throw new ApiError(422,'Invalid Web archive');}finally{signal.removeEventListener('abort',abort);active?.destroy();zip?.close();reader?.stop();await reader?.drain();await source.close();}
}
/** Bounded copy rejects links/special files. The original installation stays intact. */
async function applicationLink(source:string,root:string){const parts=relative(root,source).split(sep),modules=join(root,'node_modules'),resolved=await realpath(source),part=relative(modules,resolved),link=await readlink(source);if(parts[0]!=='node_modules'||parts.at(-2)!=='.bin'||isAbsolute(link)||isAbsolute(part)||part==='..'||part.startsWith('..'+sep))throw new ApiError(422,'Unsafe application dependency link');return link;}
async function copy(source:string,target:string,signal:AbortSignal,budget={bytes:0,entries:0},applicationLinks=false,root=source){
 signal.throwIfAborted();if(++budget.entries>MAX_ENTRIES)throw new ApiError(413,'Persistent Web data capacity exceeded');const info=await lstat(source,{bigint:true});
 if(info.isSymbolicLink()&&applicationLinks){await symlink(await applicationLink(source,root),target);return;}
 if(info.isSymbolicLink()||!info.isFile()&&!info.isDirectory())throw new ApiError(422,'Persistent Web data must contain regular files and directories');
 if(info.isDirectory()){await mkdir(target,{mode:0o700});for await(const entry of await opendir(source))await copy(join(source,entry.name),join(target,entry.name),signal,budget,applicationLinks,root);await chmod(target,Number(info.mode)&0o777);await sync(target);}
 else{if(info.size>BigInt(MAX_FILE)||(budget.bytes+=Number(info.size))>MAX_CONTENT)throw new ApiError(413,'Persistent Web data capacity exceeded');const input=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let out:FileHandle|undefined;try{out=await open(target,'wx',0o600);const opened=await input.stat({bigint:true});if(opened.dev!==info.dev||opened.ino!==info.ino)throw fail();for(let at=0;at<Number(info.size);){signal.throwIfAborted();const bytes=Buffer.allocUnsafe(Math.min(65536,Number(info.size)-at)),n=(await input.read(bytes,0,bytes.length,at)).bytesRead;if(!n)throw fail();for(let written=0;written<n;){const count=(await out.write(bytes,written,n-written,null)).bytesWritten;if(!count)throw Error('Web copy made no progress');written+=count;}at+=n;}const after=await input.stat({bigint:true});if((['dev','ino','size','mtimeNs','ctimeNs'] as const).some(k=>info[k]!==after[k]))throw new ApiError(409,'Persistent Web data changed during copy');await out.chmod(Number(info.mode)&0o777);await out.sync();}finally{await Promise.all([input.close(),out?.close()]);}}
}
export class WebDirectoryTransaction {
 readonly directory:string;#parent='';#backup:Backup|undefined;#lock:FileHandle|undefined;
 readonly target:string;readonly #applicationPermissions:boolean;
 constructor(target:string,applicationPermissions=false){this.target=target;this.#applicationPermissions=applicationPermissions;this.directory=join(dirname(target),'.anyraid-web-'+createHash('sha256').update(target).digest('hex').slice(0,20));}
 async initialize():Promise<void>{
  if(await realpath(dirname(this.target))!==dirname(this.target))throw fail();this.#parent=(await id(dirname(this.target)))!;
  try{await mkdir(this.directory,{mode:0o700});await sync(dirname(this.target));}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  const info=await lstat(this.directory);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(this.directory)!==this.directory||process.getuid&&info.uid!==process.getuid()||process.platform!=='win32'&&(info.mode&0o077)!==0)throw fail();
  this.#lock=await open(this.directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{const lock=createRequire(import.meta.url)('../../build/sealed-file.node') as {lockDirectory(fd:number):void};lock.lockDirectory(this.#lock.fd);}catch(error){await this.close();throw new ApiError(409,'Web deployment is owned by another process or directory locking is unavailable');}
  const saved=await json(join(this.directory,'backup.json'));if(saved!==undefined&&!backup(saved))throw fail();this.#backup=saved as Backup|undefined;
  const value=await json(join(this.directory,'intent.json'));if(value!==undefined){const intent=value as Intent;if(!intent||intent.schema!==1||intent.target!==this.target||intent.parent!==this.#parent||!backup(intent.old)||!intent.candidate||!safeName(intent.candidate.name)||typeof intent.candidate.id!=='string'||intent.previous!==null&&!backup(intent.previous))throw fail();await this.#recover(intent);}
  if(this.#backup&&await id(join(this.directory,this.#backup.name))!==this.#backup.id)throw fail();
 }
 async close(){const handle=this.#lock;this.#lock=undefined;await handle?.close();}
 get rollback(){return this.#backup?{version:this.#backup.version,repo:this.#backup.repo}:undefined;}
 async stage(signal:AbortSignal):Promise<string>{signal.throwIfAborted();const path=join(this.directory,'stage-'+randomUUID());await mkdir(path,{mode:0o700});return path;}
 async archive(path:string,stage:string,size:number,digest:string,signal:AbortSignal){await extract(path,stage,size,digest,signal,this.#applicationPermissions);}
 async rollbackStage(signal:AbortSignal):Promise<string>{if(!this.#backup||await id(join(this.directory,this.#backup.name))!==this.#backup.id)throw new ApiError(409,'No verified Web rollback is available');const path=join(this.directory,'stage-'+randomUUID());await copy(join(this.directory,this.#backup.name),path,signal,{bytes:0,entries:0},this.#applicationPermissions);return path;}
 async preserve(stage:string,names:readonly string[],signal:AbortSignal){const budget={bytes:0,entries:0};for(const name of names){const source=join(this.target,name);try{await lstat(source);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}await rm(join(stage,name),{recursive:true,force:true});await copy(source,join(stage,name),signal,budget);}}
 async discard(stage:string){if(dirname(stage)!==this.directory||!safeName(basename(stage))||!basename(stage).startsWith('stage-'))throw fail();await rm(stage,{recursive:true,force:true});}
 async publish(stage:string,expected:string,version:string,repo:string,signal:AbortSignal,admit:()=>void|Promise<void>):Promise<void>{
  signal.throwIfAborted();await admit();signal.throwIfAborted();if(await id(dirname(this.target))!==this.#parent||await id(this.target)!==expected||dirname(stage)!==this.directory)throw fail();const candidate=(await id(stage))!;
  await chmod(stage,0o755);await this.#syncTree(stage,this.#applicationPermissions?{bytes:0,entries:0}:undefined);signal.throwIfAborted();await admit();signal.throwIfAborted();if(await id(this.target)!==expected||await id(dirname(this.target))!==this.#parent)throw fail();
  const intent:Intent={schema:1,target:this.target,parent:this.#parent,old:{name:'old-'+randomUUID(),id:expected,version,repo},candidate:{name:basename(stage),id:candidate},previous:this.#backup??null};
  await store(join(this.directory,'intent.json'),intent);
  try{signal.throwIfAborted();await admit();signal.throwIfAborted();if(await id(this.target)!==expected||await id(dirname(this.target))!==this.#parent)throw fail();}catch(error){await this.#recover(intent);throw error;}
  // From this point cancellation waits for a consistent durable directory state.
  await rename(this.target,join(this.directory,intent.old.name));await sync(dirname(this.target));await sync(this.directory);
  await rename(stage,this.target);await sync(dirname(this.target));await sync(this.directory);await this.#recover(intent);
 }
 async #syncTree(path:string,budget?:{bytes:number;entries:number},root=path){
  // Match rollback copy: root, directories, files and links each count once;
  // only regular file contents count toward bytes, with the same file limit.
  if(budget){if(++budget.entries>MAX_ENTRIES)throw new ApiError(413,'Application stage capacity exceeds rollback limits');const info=await lstat(path,{bigint:true});if(info.isSymbolicLink()){await applicationLink(path,root);return;}if(info.isFile()){if(info.size>BigInt(MAX_FILE)||(budget.bytes+=Number(info.size))>MAX_CONTENT)throw new ApiError(413,'Application stage capacity exceeds rollback limits');await sync(path);return;}if(!info.isDirectory())throw new ApiError(422,'Application stage contains an unsupported entry');}
  for(const entry of await readdir(path,{withFileTypes:true}))if(budget||entry.isDirectory())await this.#syncTree(join(path,entry.name),budget,root);await sync(path);
 }
 async #recover(intent:Intent){
  const current=await id(this.target),oldPath=join(this.directory,intent.old.name),stage=join(this.directory,intent.candidate.name),old=await id(oldPath),candidate=await id(stage);
  if(current===intent.old.id&&old===undefined&&(candidate===intent.candidate.id||candidate===undefined)){if(candidate!==undefined)await this.discard(stage);}
  else if(current===undefined&&old===intent.old.id&&candidate===intent.candidate.id){await rename(oldPath,this.target);await sync(dirname(this.target));await sync(this.directory);await this.discard(stage);}
  else if(current===intent.candidate.id&&old===intent.old.id&&candidate===undefined){await store(join(this.directory,'backup.json'),intent.old);this.#backup=intent.old;
   if(intent.previous){const previousPath=join(this.directory,intent.previous.name);const previous=await id(previousPath);if(previous!==undefined){if(previous!==intent.previous.id)throw fail();await rm(previousPath,{recursive:true});}}
  }else throw fail();
  await rm(join(this.directory,'intent.json'));await sync(this.directory);
 }
}
