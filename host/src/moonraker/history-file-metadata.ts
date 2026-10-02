import type {FileMetadataReader} from './file-metadata.ts';
import type {HistoryMetadataSnapshot} from './history-metadata.ts';
import type {HistoryRepository} from './history-repository.ts';
import {ApiError,type Json} from './rpc.ts';
interface Source {historyMetadata(filename:string):HistoryMetadataSnapshot|undefined;metadata(filename:string):Record<string,Json>;thumbnails(filename:string):Json[];}
/** A read overlay over immutable scan snapshots. Markers are persisted atomically
 * with history creation and only exposed for the same selected scan generation. */
export class HistoryFileMetadata implements FileMetadataReader {
 readonly #files:Source;readonly #history:Pick<HistoryRepository,'metadataMarker'>;
 constructor(files:Source,history:Pick<HistoryRepository,'metadataMarker'>){this.#files=files;this.#history=history;}
 async metadata(filename:string):Promise<Record<string,Json>>{
  const selected=this.#files.historyMetadata(filename),fields={...this.#files.metadata(filename)};
  delete fields.job_id;delete fields.print_start_time;
  if(!selected)return fields;
  const marker=await this.#history.metadataMarker(filename,selected.generation);
  if(this.#files.historyMetadata(filename)?.generation!==selected.generation)throw new ApiError(409,'Metadata changed while reading history marker');
  return marker?{...fields,...marker}:fields;
 }
 thumbnails(filename:string):Json[]{return this.#files.thumbnails(filename);}
}
