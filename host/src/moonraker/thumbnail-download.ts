import type {FileMetadataStore} from './file-metadata.ts';
import {ThumbnailStorageBusyError,type ThumbnailStorage} from './thumbnail-storage.ts';
import {ApiError,type RpcContext} from './rpc.ts';
export interface ThumbnailDownload {size:number;contentType:string;read():Promise<{bytes:Buffer;sha256:string}>;}
/** Logical gcodes URLs only. Current metadata and per-source authorization are
 * both required; a bundle UUID is never an authorization credential. */
export class ThumbnailDownloads {
 private storage:ThumbnailStorage;private metadata:FileMetadataStore;private assertAvailable:(()=>void)|undefined;
 constructor(storage:ThumbnailStorage,metadata:FileMetadataStore,assertAvailable?:()=>void){this.storage=storage;this.metadata=metadata;this.assertAvailable=assertAvailable;}
 matches(path:string):boolean{return path.startsWith('/server/files/gcodes/');}
 async resolve(rawPath:string,context:RpcContext):Promise<ThumbnailDownload>{
  await context.authorize('server.files.download',{path:rawPath});context.signal.throwIfAborted();this.assertAvailable?.();
  let path:string;try{path=decodeURIComponent(rawPath.slice('/server/files/gcodes/'.length));}catch{throw new ApiError(400,'Invalid download path');}
  if(Buffer.byteLength(path)>4096||path.includes('\0')||path.split('/').some(part=>!part||part==='.'||part==='..'))throw new ApiError(400,'Invalid download path');
  const match=/(?:^|\/)\.thumbs\/(thumb-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/(0|[1-9][0-9]?)\.(png|jpg)$/.exec(path);
  const owner=match&&this.metadata.thumbnailOwner(path);if(!match||!owner)throw new ApiError(404,'Thumbnail not found');
  await context.authorize('server.files.download',{path:rawPath,filename:owner.filename});context.signal.throwIfAborted();
  const current=()=>{context.signal.throwIfAborted();this.assertAvailable?.();if(this.metadata.peek(owner.filename)!==owner.snapshot)throw new ApiError(404,'Thumbnail reference changed');};current();
  return {size:owner.size,contentType:match[3]==='png'?'image/png':'image/jpeg',read:async()=>{current();const result=await this.storage.read(match[1],Number(match[2]),context.signal,owner.size).catch(error=>{if(error instanceof ThumbnailStorageBusyError)throw new ApiError(503,'Thumbnail storage busy');throw error;});current();if(result.bytes.length!==owner.size||result.contentType!==(match[3]==='png'?'image/png':'image/jpeg'))throw new ApiError(500,'Thumbnail metadata mismatch');return result;}};
 }
}
