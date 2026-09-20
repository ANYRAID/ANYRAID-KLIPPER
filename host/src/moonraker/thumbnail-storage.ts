import {randomUUID,createHash} from 'node:crypto';
import {PublishedPrintFiles} from '../storage/published-files.ts';
import {sealedBuffer} from '../storage/sealed-buffer.ts';
import {PrintSnapshotBudget} from '../gcode/snapshot-budget.ts';
import type {ThumbnailImage} from './thumbnail-images.ts';
import {FileMetadataStore,type MetadataTicket} from './file-metadata.ts';
import type {Json} from './rpc.ts';
const MAX_IMAGES=65,MAX_CONTENT=8*1024**2,MAX_HEADER=64*1024,MAX_BUNDLE=12+MAX_HEADER+MAX_CONTENT;
export class ThumbnailStorageBusyError extends Error {constructor(){super('Thumbnail storage operation limit exceeded');}}
interface Member {width:number;height:number;format:'png'|'jpg';miniature:boolean;offset:number;size:number;sha256:string;}
interface Bundle {bytes:Buffer;start:number;members:Member[];}
const idCheck=(id:string)=>{if(typeof id!=='string'||!/^thumb-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw new TypeError('Invalid thumbnail bundle identifier');};
function validMember(m:Member){return m&&Number.isSafeInteger(m.width)&&Number.isSafeInteger(m.height)&&m.width>0&&m.height>0&&m.width<=2048&&m.height<=2048&&m.width*m.height<=4*1024**2&&['png','jpg'].includes(m.format)&&typeof m.miniature==='boolean'&&Number.isSafeInteger(m.size)&&m.size>0&&m.size<=MAX_CONTENT&&typeof m.sha256==='string'&&/^[a-f0-9]{64}$/.test(m.sha256);}
function encode(images:readonly ThumbnailImage[]):Bundle{
 if(!Array.isArray(images)||!images.length||images.length>MAX_IMAGES)throw new RangeError('Invalid thumbnail bundle images');let offset=0;
 const members=images.map(image=>{if(!image||!Buffer.isBuffer(image.bytes))throw new TypeError('Invalid thumbnail bytes');if(!image.bytes.length||image.bytes.length>MAX_CONTENT-offset)throw new RangeError('Thumbnail bundle content limit exceeded');const member:Member={width:image.width,height:image.height,format:image.format,miniature:image.miniature,offset,size:image.bytes.length,sha256:'0'.repeat(64)};if(!validMember(member))throw new RangeError('Invalid thumbnail bundle member');offset+=member.size;if(offset>MAX_CONTENT)throw new RangeError('Thumbnail bundle content limit exceeded');return member;});
 const header=Buffer.from(JSON.stringify({version:1,members}));if(header.length>MAX_HEADER)throw new RangeError('Thumbnail bundle header limit exceeded');
 const result=Buffer.allocUnsafe(12+header.length+offset);result.write('ATHUMB01',0,'ascii');result.writeUInt32BE(header.length,8);header.copy(result,12);let position=12+header.length;for(const image of images){image.bytes.copy(result,position);position+=image.bytes.length;}for(const member of members)member.sha256=createHash('sha256').update(result.subarray(12+header.length+member.offset,12+header.length+member.offset+member.size)).digest('hex');const finalHeader=Buffer.from(JSON.stringify({version:1,members}));if(finalHeader.length!==header.length)throw new Error('Thumbnail header size invariant failed');finalHeader.copy(result,12);return {bytes:result,start:12+header.length,members};
}
function decode(bytes:Buffer):Bundle{
 if(bytes.length<12||bytes.length>MAX_BUNDLE||!bytes.subarray(0,8).equals(Buffer.from('ATHUMB01')))throw new Error('Invalid thumbnail bundle');const length=bytes.readUInt32BE(8);if(length<1||length>MAX_HEADER||12+length>bytes.length)throw new Error('Invalid thumbnail bundle header');
 const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(12,12+length)));if(value?.version!==1||!Array.isArray(value.members)||!value.members.length||value.members.length>MAX_IMAGES)throw new Error('Invalid thumbnail bundle manifest');
 let offset=0;for(const member of value.members as Member[]){if(!validMember(member)||member.offset!==offset)throw new Error('Invalid thumbnail member bounds');offset+=member.size;if(offset>MAX_CONTENT)throw new Error('Thumbnail bundle content limit exceeded');}
 if(12+length+offset!==bytes.length)throw new Error('Thumbnail bundle size mismatch');for(const member of value.members as Member[])if(createHash('sha256').update(bytes.subarray(12+length+member.offset,12+length+member.offset+member.size)).digest('hex')!==member.sha256)throw new Error('Thumbnail member digest mismatch');return {bytes,start:12+length,members:value.members};
}
/** Atomic sets in a dedicated private store. Relative paths are logical URLs;
 * no user path is used for IO and HTTP authorization remains the caller's job. */
export class ThumbnailStorage {
 #store:PublishedPrintFiles;#maxPending:number;#pending=new Set<Promise<unknown>>();#closed=false;#closing:Promise<void>|undefined;
 #budget:PrintSnapshotBudget;#cache=new Map<string,Bundle>();#cacheBytes=0;#maxCache:number;#epoch=0n;
 private constructor(store:PublishedPrintFiles,maxPending:number,maxCache:number){this.#store=store;this.#maxPending=maxPending;this.#maxCache=maxCache;this.#budget=new PrintSnapshotBudget({maxBytes:maxPending*MAX_BUNDLE+maxPending*4096,maxSnapshots:maxPending});}
 static async open(directory:string,options:{maxPending?:number;maxStorageBytes?:number;maxBundles?:number;maxCacheBytes?:number}={}):Promise<ThumbnailStorage>{
  const maxPending=options.maxPending??2,maxCache=options.maxCacheBytes??16*1024**2;if(!Number.isSafeInteger(maxPending)||maxPending<1||maxPending>8||!Number.isSafeInteger(maxCache)||maxCache<0||maxCache>64*1024**2)throw new RangeError('Invalid thumbnail storage capacity');
  return new ThumbnailStorage(await PublishedPrintFiles.open(directory,{maxFileBytes:MAX_BUNDLE,maxOperations:maxPending,maxStorageBytes:options.maxStorageBytes??128*1024**2,maxPublishedFiles:options.maxBundles??1024}),maxPending,maxCache);
 }
 static newId():string{return 'thumb-'+randomUUID();}
 get status(){return {closed:this.#closed,pending:this.#pending.size,cacheBytes:this.#cacheBytes,cachedBundles:this.#cache.size,staging:this.#budget.status,storage:this.#store.status};}
 #run<T>(operation:()=>Promise<T>):Promise<T>{if(this.#closed)return Promise.reject(new Error('Thumbnail storage is closed'));if(this.#pending.size>=this.#maxPending)return Promise.reject(new ThumbnailStorageBusyError());const task=Promise.resolve().then(operation);this.#pending.add(task);return task.finally(()=>this.#pending.delete(task));}
 #drop(id:string):void{const cached=this.#cache.get(id);if(cached){this.#cacheBytes-=cached.bytes.length;this.#cache.delete(id);}}
 async #load(id:string,signal:AbortSignal):Promise<Bundle>{
  idCheck(id);signal.throwIfAborted();const cached=this.#cache.get(id);if(cached){this.#cache.delete(id);this.#cache.set(id,cached);return cached;}
  const epoch=this.#epoch,{bytes}=await this.#store.readBytes(id,signal,MAX_BUNDLE),bundle=decode(bytes);signal.throwIfAborted();
  if(!this.#closed&&epoch===this.#epoch&&bytes.length<=this.#maxCache){this.#drop(id);while(this.#cacheBytes+bytes.length>this.#maxCache)this.#drop(this.#cache.keys().next().value!);this.#cache.set(id,bundle);this.#cacheBytes+=bytes.length;}return bundle;
 }
 #metadata(id:string,bundle:Bundle){return {id,thumbnails:bundle.members.map((m,i)=>({width:m.width,height:m.height,size:m.size,relative_path:`.thumbs/${id}/${i}.${m.format}`}))};}
 publish(id:string,images:readonly ThumbnailImage[],signal:AbortSignal){return this.#run(async()=>{idCheck(id);signal.throwIfAborted();const bundle=encode(images),source=await sealedBuffer(bundle.bytes,signal,this.#budget);try{await this.#store.publish(id,'thumbnail-bundle',source.file,signal);return this.#metadata(id,bundle);}finally{await source.close();}});}
 inspect(id:string,signal:AbortSignal){return this.#run(async()=>this.#metadata(id,await this.#load(id,signal)));}
 read(id:string,index:number,signal:AbortSignal,maxBytes=MAX_CONTENT){return this.#run(async()=>{if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_CONTENT)throw new RangeError('Invalid thumbnail read limit');if(!Number.isSafeInteger(index)||index<0||index>=MAX_IMAGES)throw new RangeError('Invalid thumbnail index');const bundle=await this.#load(id,signal),member=bundle.members[index];if(!member)throw new Error('Thumbnail index not found');if(member.size>maxBytes)throw new RangeError('Thumbnail read limit exceeded');const bytes=Buffer.from(bundle.bytes.subarray(bundle.start+member.offset,bundle.start+member.offset+member.size));return {bytes,contentType:member.format==='png'?'image/png':'image/jpeg',sha256:member.sha256,width:member.width,height:member.height};});}
 remove(id:string,signal:AbortSignal){return this.#run(async()=>{idCheck(id);this.#epoch++;this.#drop(id);await this.#store.remove(id,signal);});}
 close():Promise<void>{if(this.#closing)return this.#closing;this.#closed=true;this.#epoch++;this.#cache.clear();this.#cacheBytes=0;this.#closing=Promise.allSettled([...this.#pending]).then(()=>this.#store.close());return this.#closing;}
}
/** Publish all images before committing one cache snapshot. The caller retains the
 * fresh bundle ID for recovery if durable publication fails ambiguously. */
export async function publishThumbnailMetadata(storage:ThumbnailStorage,cache:FileMetadataStore,ticket:MetadataTicket,fields:Readonly<Record<string,Json>>,id:string,images:readonly ThumbnailImage[],signal:AbortSignal):Promise<boolean>{
 let published=false;
 try{const result=images.length?await storage.publish(id,images,signal):{thumbnails:[]};published=images.length>0;signal.throwIfAborted();const committed=cache.commit(ticket,{...fields,thumbnails:result.thumbnails});if(!committed&&published){published=false;await storage.remove(id,new AbortController().signal);}return committed;}
 catch(error){cache.fail(ticket);if(published){try{await storage.remove(id,new AbortController().signal);}catch(cleanup){throw new AggregateError([error,cleanup],'Thumbnail metadata publication cleanup failed',{cause:error});}}throw error;}
}
