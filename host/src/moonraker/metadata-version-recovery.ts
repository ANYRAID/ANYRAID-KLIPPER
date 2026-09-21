import type {MetadataVersions} from './metadata-versions.ts';
import {FileMetadataStore,type MetadataTicket} from './file-metadata.ts';
import {restoreMetadataSnapshot,type MetadataSnapshots} from './metadata-snapshots.ts';
import type {ThumbnailStorage} from './thumbnail-storage.ts';
import type {MetadataExtraction} from './metadata-extractor.ts';
/** Recover only the explicitly selected durable version. Pending/invalidation
 * never fall back to an older snapshot, even when its source still matches. */
export async function restoreCurrentMetadata(options:{versions:MetadataVersions;snapshots:MetadataSnapshots;images:ThumbnailStorage;cache:FileMetadataStore;ticket:MetadataTicket;signal:AbortSignal;validateSource(source:MetadataExtraction['source'],signal:AbortSignal):Promise<boolean>}):Promise<boolean>{
 const {versions,snapshots,images,cache,ticket,signal,validateSource}=options;
 try{
  signal.throwIfAborted();if(!cache.isCurrent(ticket))return false;const current=versions.current(ticket.filename);
  if(!current||current.state!=='selected'){cache.fail(ticket);return false;}
  const staged=new FileMetadataStore({maxRecords:1,maxBytes:2*1024**2,maxRecordBytes:1024**2});
  const restored=await restoreMetadataSnapshot(snapshots,'meta-'+current.scanId!.slice(5),staged,staged.begin(ticket.filename),images,validateSource,signal);signal.throwIfAborted();
  if(!restored||!versions.isCurrent(current)){cache.fail(ticket);return false;}
  return cache.commit(ticket,staged.peek(ticket.filename)!);
 }catch(error){cache.fail(ticket);throw error;}
}
