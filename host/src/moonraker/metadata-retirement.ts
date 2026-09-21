import {ApiError} from './rpc.ts';
import type {MetadataScanIntents,MetadataScanIntent} from './metadata-intents.ts';
import type {MetadataSnapshots} from './metadata-snapshots.ts';
import type {ThumbnailStorage} from './thumbnail-storage.ts';
import type {FileMetadataStore} from './file-metadata.ts';
/** Explicit reconciliation only. The owner must serialize durable current-version
 * changes with this authorization and prevent stale ticket replay after completion.
 * Runtime cache guards alone cannot prove a snapshot is durably retired. */
export async function retireMetadataScan(options:{intent:MetadataScanIntent;intents:MetadataScanIntents;snapshots:MetadataSnapshots;images:ThumbnailStorage;cache:FileMetadataStore;signal:AbortSignal;authorizeRetirement(intent:MetadataScanIntent,signal:AbortSignal):Promise<boolean>}):Promise<void>{
 const {intent,intents,snapshots,images,cache,signal}=options;
 signal.throwIfAborted();if(!intents.unresolved().some(record=>record===intent))throw new ApiError(409,'Unknown or stale retirement intent');
 if(!await options.authorizeRetirement(intent,signal))throw new ApiError(409,'Metadata scan is not retired');signal.throwIfAborted();
 const release=cache.guardThumbnailRetirement(intent.bundleId);
 try{
  const id='meta-'+intent.id.slice(5);
  if((await snapshots.listIds(signal)).includes(id)){
   const record=await snapshots.read(id,signal);if(record.intent.id!==intent.id||record.intent.filename!==intent.filename||record.intent.bundleId!==intent.bundleId)throw new ApiError(409,'Retirement snapshot intent mismatch');
   await snapshots.remove(id,signal);
  }
  // Absence after restart is expected when a previous retirement stopped between
  // stores. Each successful removal is durable before the next reference is cut.
  if((await images.listIds(signal)).includes(intent.bundleId))await images.remove(intent.bundleId,signal);
  await intents.acknowledge(intent,signal);
 }finally{release();}
}
