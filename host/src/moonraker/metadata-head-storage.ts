import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open,mkdir,opendir,lstat,rename,unlink,type FileHandle} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {PrintSnapshotBudget} from '../gcode/snapshot-budget.ts';
import {validatePublishedReceipt} from '../storage/published-receipt.ts';
import type {MetadataVersion} from './metadata-versions.ts';
const native=createRequire(import.meta.url)(process.env.ANYRAID_SEALED_FILE_ADDON??'../../build/sealed-file.node') as {lockDirectory(fd:number):void};
const digest=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const name=(filename:string)=>'.metadata-head-'+digest(filename)+'.json';
const same=(a:MetadataVersion,b:MetadataVersion)=>a.id===b.id&&a.sequence===b.sequence&&a.filename===b.filename&&a.state===b.state&&a.scanId===b.scanId;
const temporary=/^\.(?:(?:metadata-stage|upload|receipt)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const maxBytes=32768;
/** One checksummed head per filename, under the same exclusive directory lease
 * as legacy publications. Persist data before atomic replacement, then persist
 * the directory before acknowledging the generation. Never delete tombstones. */
export class MetadataHeadStorage {
 readonly #root:FileHandle;readonly #decode:(value:unknown,id:string)=>MetadataVersion;
 readonly #heads=new Map<string,MetadataVersion>();#closed=false;
 readonly #budget=new PrintSnapshotBudget({maxBytes:65536,maxSnapshots:1});
 get staging(){return this.#budget.status;}
 private constructor(root:FileHandle,decode:(value:unknown,id:string)=>MetadataVersion){this.#root=root;this.#decode=decode;}
 #path(entry:string){return `/proc/self/fd/${this.#root.fd}/${entry}`;}
 static async open(directory:string,decode:(value:unknown,id:string)=>MetadataVersion):Promise<MetadataHeadStorage>{
  if(typeof directory!=='string'||!isAbsolute(directory))throw new RangeError('Invalid metadata version directory');
  await mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const root=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{const info=await root.stat();if(info.uid!==process.getuid!()||(info.mode&0o077)!==0)throw new Error('Metadata version directory must be private and owned by service');native.lockDirectory(root.fd);const owner=new MetadataHeadStorage(root,decode);await owner.#recover();return owner;}catch(error){await root.close();throw error;}
 }
 entries():readonly MetadataVersion[]{return [...this.#heads.values()];}
 async #read(entry:string,head=false):Promise<Buffer>{
  const file=await open(this.#path(entry),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const before=await file.stat({bigint:true});if(!before.isFile()||before.uid!==BigInt(process.getuid!())||(before.mode&0o077n)!==0n||before.size>BigInt(maxBytes)||head&&(before.nlink!==1n||(before.mode&0o7777n)!==0o600n))throw new Error('Invalid metadata version storage file');
   const bytes=await file.readFile(),after=await file.stat({bigint:true});if(BigInt(bytes.length)!==before.size||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new Error('Metadata version changed while reading');return bytes;
  }finally{await file.close();}
 }
 #json(bytes:Buffer):unknown{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
 async #head(entry:string):Promise<MetadataVersion>{
  const envelope=this.#json(await this.#read(entry,true)) as {version:number;sha256:string;record:MetadataVersion};
  if(!envelope||Object.keys(envelope).length!==3||envelope.version!==2||typeof envelope.sha256!=='string'||digest(JSON.stringify(envelope.record))!==envelope.sha256)throw new Error('Metadata version head digest mismatch');
  const value=this.#decode(envelope.record,envelope.record?.id);if(name(value.filename)!==entry)throw new Error('Metadata version head filename mismatch');return value;
 }
 async #recover():Promise<void>{
  const legacy:string[]=[],blobs=new Set<string>(),temps:string[]=[],heads=new Map<string,MetadataVersion>(),latest=new Map<string,MetadataVersion>(),sequences=new Map<string,MetadataVersion>();let count=0,bytes=0;
  const accept=(value:MetadataVersion)=>{const duplicate=sequences.get(value.sequence);if(duplicate&&!same(value,duplicate))throw new Error('Conflicting metadata version sequence');sequences.set(value.sequence,value);const old=latest.get(value.filename);if(!old||BigInt(value.sequence)>BigInt(old.sequence))latest.set(value.filename,value);};
  const directory=await opendir(this.#path('.'));
  for await(const entry of directory){
   if(++count>32768)throw new Error('Metadata version recovery entry limit exceeded');
   const info=await lstat(this.#path(entry.name));bytes+=info.size;if(!info.isFile()||info.uid!==process.getuid!()||(info.mode&0o077)!==0||info.size>maxBytes||bytes>256*1024**2)throw new Error('Invalid metadata version recovery entry');
   if(/^\.metadata-head-[a-f0-9]{64}\.json$/.test(entry.name)){const value=await this.#head(entry.name);if(heads.has(value.filename))throw new Error('Duplicate metadata version head');heads.set(value.filename,value);accept(value);}
   else if(/^mv-[1-9][0-9]{0,19}\.json$/.test(entry.name))legacy.push(entry.name);
   else if(/^[a-f0-9]{64}\.gcode$/.test(entry.name))blobs.add(entry.name);
   else if(temporary.test(entry.name))temps.push(entry.name);
   else throw new Error('Unknown metadata version storage entry');
  }
  if(legacy.length>8192)throw new Error('Metadata version recovery limit exceeded');
  // Read and hash ALL legacy authorities before creating heads or reclaiming
  // anything. A partially migrated directory is validated by the same rule.
  for(const entry of legacy){
   const receipt=validatePublishedReceipt(this.#json(await this.#read(entry)),maxBytes),id=entry.slice(0,-5);
   if(receipt.id!==id||receipt.name!=='metadata-version'||receipt.path!==undefined||receipt.preview!==undefined||!blobs.has(receipt.sha256+'.gcode'))throw new Error('Unexpected metadata version receipt');
   const content=await this.#read(receipt.sha256+'.gcode');if(content.length!==receipt.size||digest(content)!==receipt.sha256)throw new Error('Metadata version content digest mismatch');accept(this.#decode(this.#json(content),id));
  }
  if(latest.size>4096)throw new Error('Metadata version file limit exceeded');
  this.#heads.clear();for(const [filename,value] of heads)this.#heads.set(filename,value);
  // Reopening after a process kill does not itself prove a preceding rename
  // crossed a directory sync. Re-establish that barrier before legacy cleanup.
  if(heads.size)await this.#root.sync();
  for(const value of latest.values())if(!heads.has(value.filename)||!same(heads.get(value.filename)!,value))await this.write(value,new AbortController().signal);
  // Every latest legacy authority now has a durable head. Retire receipts
  // before blobs; a crash at either boundary can safely resume migration.
  for(const entry of legacy)await unlink(this.#path(entry));if(legacy.length)await this.#root.sync();
  for(const entry of [...blobs,...temps])await unlink(this.#path(entry));if(blobs.size||temps.length)await this.#root.sync();
 }
 async write(value:MetadataVersion,signal:AbortSignal):Promise<void>{
  if(this.#closed)throw new Error('Metadata version heads are closed');signal.throwIfAborted();
  const previous=this.#heads.get(value.filename),entry=name(value.filename);
  if(previous&&!same(await this.#head(entry),previous))throw new Error('Metadata version head changed outside owner');
  if(!previous){try{await lstat(this.#path(entry));throw new Error('Unexpected metadata version head');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  const body=JSON.stringify(value),bytes=Buffer.from(JSON.stringify({version:2,sha256:digest(body),record:value}));if(bytes.length>maxBytes)throw new Error('Metadata version head size exceeded');
  const temp='.metadata-stage-'+randomUUID(),reservation=this.#budget.reserve(bytes.length);let file:FileHandle|undefined,replaced=false;
  try{
   file=await open(this.#path(temp),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);await file.writeFile(bytes);await file.sync();await file.close();file=undefined;
   signal.throwIfAborted();await rename(this.#path(temp),this.#path(entry));replaced=true;
   // Once replaced, drain the durable commit despite cancellation. Its outcome
   // must not be described as rolled back or followed by destructive cleanup.
   await this.#root.sync();this.#heads.set(value.filename,value);
  }finally{try{await file?.close();if(!replaced)await unlink(this.#path(temp)).catch(error=>{if(error.code!=='ENOENT')throw error;});}finally{reservation.release();}}
 }
 async close():Promise<void>{if(this.#closed)return;this.#closed=true;await this.#root.close();}
}
