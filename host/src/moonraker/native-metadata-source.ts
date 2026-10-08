import type {PublishedPrintFiles,PublishedSourceIdentity} from '../storage/published-files.ts';
import type {PrintSnapshotBudget} from '../gcode/snapshot-budget.ts';
import type {MetadataExtractor,MetadataExtraction} from './metadata-extractor.ts';
import {METADATA_READ_BYTES} from './metadata-window.ts';
import {ApiError} from './rpc.ts';
import {samePublishedFile} from '../storage/namespace-move.ts';
export const samePublishedSource=(a:PublishedSourceIdentity,b:PublishedSourceIdentity):boolean=>a.dev===b.dev&&a.ino===b.ino&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
/** Verify full content in a sealed snapshot, release its pages before Worker
 * parsing, and bind the result to the durable receipt rather than the memfd. */
export async function extractPublishedMetadata(files:PublishedPrintFiles,budget:PrintSnapshotBudget,extractor:MetadataExtractor,id:string,signal:AbortSignal):Promise<MetadataExtraction>{
 const initial=await files.describeSource(id,signal),snapshot=await files.acquireBinary(id,signal,budget);let head:Buffer,tail:Buffer;
 try{
  if(!samePublishedFile(snapshot.record,initial.file))throw new ApiError(409,'Native metadata source changed');
  const read=async(start:number,end:number)=>{const data=Buffer.allocUnsafe(end-start);let position=0;for await(const chunk of snapshot.reader.chunks(signal,start,end)){data.set(chunk,position);position+=chunk.length;}if(position!==data.length)throw new Error('Incomplete native metadata window');return data;};
  head=await read(0,Math.min(snapshot.size,METADATA_READ_BYTES));const offset=snapshot.size>2*METADATA_READ_BYTES?snapshot.size-METADATA_READ_BYTES:METADATA_READ_BYTES;tail=snapshot.size>METADATA_READ_BYTES?await read(offset,snapshot.size):Buffer.alloc(0);
 }finally{await snapshot.reader.close();}
 signal.throwIfAborted();const result=await extractor.extractWindows({head,tail,size:initial.file.size,modified:initial.modified},signal,true);signal.throwIfAborted();
 const thumbnailPng=initial.file.preview?(await files.readPreview(id,signal,initial.file))?.bytes:undefined;
 const current=await files.describeSource(id,signal);if(!samePublishedSource(initial.source,current.source)||!samePublishedFile(initial.file,current.file))throw new ApiError(409,'Native metadata receipt changed during extraction');
 return {...result,...thumbnailPng?{thumbnailPng}:{},source:initial.source,fields:{...result.fields,file_id:id,sha256:initial.file.sha256,name:initial.file.name}};
}
