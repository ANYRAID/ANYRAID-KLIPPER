import type {FileHandle} from 'node:fs/promises';
import type {MetadataExtractor,MetadataExtraction} from './metadata-extractor.ts';
import type {ThumbnailProcessor} from './thumbnail-process.ts';
import type {FileMetadataStore,MetadataTicket} from './file-metadata.ts';
import {publishThumbnailMetadata,type ThumbnailStorage} from './thumbnail-storage.ts';
import {ApiError} from './rpc.ts';
export interface MetadataScanOptions {
 extractor:MetadataExtractor;processor:ThumbnailProcessor;storage:ThumbnailStorage;cache:FileMetadataStore;
 ticket:MetadataTicket;source:FileHandle;signal:AbortSignal;
 /** Fresh ID durably recorded by the lifecycle owner before calling this helper. */
 bundleId:string;
 /** Recheck filename binding/version against the extracted source. Source should
  * be immutable for strong consistency; stat-only checks cannot eliminate races. */
 validateSource(source:MetadataExtraction['source'],signal:AbortSignal):Promise<boolean>;
}
/** Complete field/image preparation and atomic metadata publication. Takes source
 * ownership unconditionally, including stale/pre-aborted/rejected admissions.
 * Does not own worker/process/store lifetimes or decide old-bundle retirement. */
export async function scanFileMetadata(options:MetadataScanOptions):Promise<{committed:boolean;bundleId:string|null;extraction:Omit<MetadataExtraction,'thumbnailData'>|null}>{
 const {extractor,processor,storage,cache,ticket,source,signal,bundleId}=options;
 let primary:unknown,failed=false;
 try{
  if(typeof options.validateSource!=='function')throw new TypeError('Metadata source validation is required');
  signal.throwIfAborted();if(!cache.isCurrent(ticket))return {committed:false,bundleId:null,extraction:null};
  const value=await extractor.extract(source,signal,true);signal.throwIfAborted();
  const {thumbnailData,...extraction}=value;
  if(!cache.isCurrent(ticket))return {committed:false,bundleId:null,extraction};
  if(typeof thumbnailData!=='string')throw new ApiError(502,'Metadata extraction omitted thumbnail input');
  const images=thumbnailData?await processor.prepare(thumbnailData,signal):[];signal.throwIfAborted();
  if(!cache.isCurrent(ticket))return {committed:false,bundleId:null,extraction};
  if(!await options.validateSource(extraction.source,signal))throw new ApiError(409,'Metadata source binding changed');signal.throwIfAborted();
  if(!cache.isCurrent(ticket))return {committed:false,bundleId:null,extraction};
  const committed=await publishThumbnailMetadata(storage,cache,ticket,extraction.fields,bundleId,images,signal);
  return {committed,bundleId:committed&&images.length?bundleId:null,extraction};
 }catch(error){failed=true;primary=error;cache.fail(ticket);throw error;}
 finally{if(source.fd>=0){try{await source.close();}catch(error){throw new AggregateError(failed?[primary,error]:[error],'Metadata scan source close failed');}}}
}
