import {PublishedPrintFiles,type PublishedPrintFile} from '../storage/published-files.ts';
import {PrintSnapshotBudget} from '../gcode/snapshot-budget.ts';
import {MetadataExtractor} from './metadata-extractor.ts';
import {METADATA_READ_BYTES} from './metadata-window.ts';
import {FileMetadataStore} from './file-metadata.ts';
import {ApiError,type Json} from './rpc.ts';
const identity=(file:PublishedPrintFile,modified:number)=>JSON.stringify([file.sha256,file.name,file.size,modified]);
/** Scalar metadata for the immutable native namespace. Worker parsing shares the
 * existing slicer implementations; verified byte windows do not retain memfd leases. */
export class NativeFileMetadata {
 readonly #files:PublishedPrintFiles;readonly #budget:PrintSnapshotBudget;
 readonly #cache=new FileMetadataStore({maxRecords:128,maxBytes:8*1024**2,maxRecordBytes:256*1024});
 readonly #keys=new Map<string,string>();readonly #pending=new Set<Promise<unknown>>();readonly #stop=new AbortController();
 #worker:Promise<MetadataExtractor>|undefined;#closing:Promise<void>|undefined;
 constructor(files:PublishedPrintFiles){this.#files=files;this.#budget=new PrintSnapshotBudget({maxBytes:files.status.maxFileBytes,maxSnapshots:2});}
 get status(){return {pending:this.#pending.size,closed:this.#stop.signal.aborted,cache:this.#cache.status,snapshots:this.#budget.status};}
 peek(filename:string,file:PublishedPrintFile,modified:number):Readonly<Record<string,Json>>|undefined{return this.#keys.get(filename)===identity(file,modified)?this.#cache.peek(filename):undefined;}
 metadata(filename:string,signal:AbortSignal):Promise<Record<string,Json>>{
  if(this.#stop.signal.aborted)return Promise.reject(new ApiError(503,'Native metadata closed'));
  if(!/^[A-Za-z0-9_-]{1,128}\.gcode$/.test(filename))return Promise.reject(new ApiError(400,'Invalid native metadata filename'));
  if(this.#pending.size>=2)return Promise.reject(new ApiError(503,'Native metadata queue full'));
  const combined=AbortSignal.any([signal,this.#stop.signal]);const task=this.#extract(filename,combined);this.#pending.add(task);return task.finally(()=>this.#pending.delete(task));
 }
 async #extract(filename:string,signal:AbortSignal):Promise<Record<string,Json>>{
  signal.throwIfAborted();const id=filename.slice(0,-6);
  try{
   const initial=await this.#files.describe(id,signal),key=identity(initial.file,initial.modified),cached=this.peek(filename,initial.file,initial.modified);
   if(cached){this.#keys.delete(filename);this.#keys.set(filename,key);return this.#cache.metadata(filename);}
   const snapshot=await this.#files.acquireBinary(id,signal,this.#budget);let head:Buffer,tail:Buffer;
   try{
    if(identity(snapshot.record,initial.modified)!==key)throw new ApiError(409,'Native metadata source changed');
    const read=async(start:number,end:number)=>{const bytes=Buffer.allocUnsafe(end-start);let offset=0;for await(const chunk of snapshot.reader.chunks(signal,start,end)){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;};
    head=await read(0,Math.min(snapshot.size,METADATA_READ_BYTES));const offset=snapshot.size>2*METADATA_READ_BYTES?snapshot.size-METADATA_READ_BYTES:METADATA_READ_BYTES;
    tail=snapshot.size>METADATA_READ_BYTES?await read(offset,snapshot.size):Buffer.alloc(0);
   }finally{await snapshot.reader.close();}
   signal.throwIfAborted();const worker=await(this.#worker??=MetadataExtractor.open({maxPending:2,maxFileBytes:this.#files.status.maxFileBytes}));signal.throwIfAborted();
   const result=await worker.extractWindows({head,tail,size:initial.file.size,modified:initial.modified},signal);signal.throwIfAborted();
   const current=await this.#files.describe(id,signal);if(identity(current.file,current.modified)!==key)throw new ApiError(409,'Native metadata source changed');
   const fields={...result.fields,file_id:id,sha256:initial.file.sha256,name:initial.file.name};
   this.#cache.invalidate(filename);this.#keys.delete(filename);
   const needed=Buffer.byteLength(JSON.stringify(fields))+Buffer.byteLength(filename);
   while(this.#keys.size&&(this.#keys.size>=128||this.#cache.status.bytes+needed>this.#cache.status.maxBytes)){const oldest=this.#keys.keys().next().value!;this.#keys.delete(oldest);this.#cache.invalidate(oldest);}
   const ticket=this.#cache.begin(filename);try{this.#cache.commit(ticket,fields);}catch(error){this.#cache.fail(ticket);throw error;}this.#keys.set(filename,key);return this.#cache.metadata(filename);
  }catch(error){if((error as NodeJS.ErrnoException)?.code==='ENOENT')throw new ApiError(404,'Published file not found');if(error instanceof Error&&error.message==='Print snapshot quota exceeded')throw new ApiError(503,'Native metadata snapshot capacity exceeded');throw error;}
 }
 close():Promise<void>{if(this.#closing)return this.#closing;this.#stop.abort(new ApiError(503,'Native metadata closed'));this.#closing=(async()=>{await this.#worker?.then(worker=>worker.close(),()=>{});await Promise.allSettled([...this.#pending]);this.#cache.clear();this.#keys.clear();})();return this.#closing;}
}
