import {FileMetadataStore} from './file-metadata.ts';
import {ApiError} from './rpc.ts';
import {MetadataScanIntents,type MetadataScanIntent} from './metadata-intents.ts';
import {scanFileMetadata,type MetadataScanOptions} from './metadata-scan.ts';
export class MetadataIntentScanError extends Error {
 readonly intent:MetadataScanIntent;
 constructor(intent:MetadataScanIntent,cause:unknown){super('Metadata scan requires intent reconciliation',{cause});this.intent=intent;}
}
/** Durable intent precedes processing/publication. Success also retains intent:
 * an in-memory cache commit is not durable metadata or retirement confirmation. */
export async function scanFileMetadataWithIntent(intents:MetadataScanIntents,options:Omit<MetadataScanOptions,'bundleId'>){
 let intent:MetadataScanIntent;
 try{intent=await intents.begin(options.ticket.filename,options.signal);}
 catch(error){options.cache.fail(options.ticket);try{if(options.source.fd>=0)await options.source.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Metadata intent scan admission cleanup failed');}throw error;}
 try{return {intent,result:await scanFileMetadata({...options,bundleId:intent.bundleId})};}
 catch(error){throw new MetadataIntentScanError(intent,error);}
}

/** Persist fields before exposing them to the shared query cache. The private
 * staging cache keeps the existing image publication/rollback protocol intact. */
export async function scanFileMetadataPersisted(intents:MetadataScanIntents,snapshots:import('./metadata-snapshots.ts').MetadataSnapshots,options:Omit<MetadataScanOptions,'bundleId'>){
 let intent:MetadataScanIntent|undefined,primary:unknown,failed=false;
 try{
  options.signal.throwIfAborted();if(!options.cache.isCurrent(options.ticket))throw new ApiError(409,'Metadata scan ticket changed');
  const staged=new FileMetadataStore({maxRecords:1,maxBytes:2*1024**2,maxRecordBytes:1024**2});
  const prepared=await scanFileMetadataWithIntent(intents,{...options,cache:staged,ticket:staged.begin(options.ticket.filename),validateSource:async(source,signal)=>options.cache.isCurrent(options.ticket)&&await options.validateSource(source,signal)});intent=prepared.intent;
  if(!prepared.result.committed||!prepared.result.extraction)throw new ApiError(409,'Metadata staging did not complete');
  if(!options.cache.isCurrent(options.ticket))return {...prepared,snapshotId:null,result:{...prepared.result,committed:false}};
  const record=await snapshots.put(intent,prepared.result.extraction.source,staged.peek(intent.filename)!,options.signal);
  options.signal.throwIfAborted();let committed=false;
  if(options.cache.isCurrent(options.ticket)){
   if(!await options.validateSource(prepared.result.extraction.source,options.signal))throw new ApiError(409,'Metadata source changed before cache publication');options.signal.throwIfAborted();
   committed=options.cache.commit(options.ticket,record.fields);
  }
  return {...prepared,snapshotId:record.id,result:{...prepared.result,committed}};
 }catch(error){failed=true;primary=error;options.cache.fail(options.ticket);if(intent)throw new MetadataIntentScanError(intent,error);throw error;}
 finally{if(options.source.fd>=0){try{await options.source.close();}catch(cleanup){throw new AggregateError(failed?[primary,cleanup]:[cleanup],'Persistent metadata scan source cleanup failed');}}}
}
