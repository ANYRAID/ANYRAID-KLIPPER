// Moonraker metadata/thumbnails response semantics, GPL-3.0-or-later.
import {ApiError,validateJson,type Json} from './rpc.ts';
import {boundedJsonBytes} from './json-size.ts';
import type {EndpointRegistry} from './endpoints.ts';
export interface MetadataTicket {readonly filename:string;}
interface Entry {ticket?:MetadataTicket;snapshot?:Readonly<Record<string,Json>>;bytes:number;keyBytes:number;}
function freeze(value:Json):void{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}}
export function validateMetadataFilename(value:string):void{if(typeof value!=='string'||!value.isWellFormed()||!value||value.startsWith('/')||value.includes('\0')||Buffer.byteLength(value)>4096||value.split('/').some(part=>!part||part==='.'||part==='..'))throw new TypeError('Invalid metadata filename');}
/** Immutable bounded snapshots. Scanner/storage owners must invalidate a changed
 * source and commit with its current ticket; this cache does not watch files. */
export class FileMetadataStore {
 #thumbnailOwners=new Map<string,Set<string>>();#retiringBundles=new Set<string>();
 #entries=new Map<string,Entry>();#bytes=0;#maxRecords:number;#maxBytes:number;#maxRecordBytes:number;
 constructor(options:{maxRecords?:number;maxBytes?:number;maxRecordBytes?:number}={}){
  this.#maxRecords=options.maxRecords??4096;this.#maxBytes=options.maxBytes??16*1024**2;this.#maxRecordBytes=options.maxRecordBytes??256*1024;
  for(const [value,max] of [[this.#maxRecords,10000],[this.#maxBytes,64*1024**2],[this.#maxRecordBytes,1024**2]])if(!Number.isSafeInteger(value)||value<1||value>max)throw new RangeError('Invalid metadata capacity');
 }
 get status(){return {entries:this.#entries.size,bytes:this.#bytes,maxRecords:this.#maxRecords,maxBytes:this.#maxBytes,maxRecordBytes:this.#maxRecordBytes};}
 begin(path:string):MetadataTicket{
  validateMetadataFilename(path);const previous=this.#entries.get(path),keyBytes=Buffer.byteLength(path);
  if(!previous&&(this.#entries.size>=this.#maxRecords||this.#bytes+keyBytes>this.#maxBytes))throw new ApiError(503,'Metadata cache capacity exceeded');
  if(previous){this.#unindex(path,previous.snapshot);this.#bytes-=previous.bytes;}else this.#bytes+=keyBytes;
  const ticket=Object.freeze({filename:path});this.#entries.set(path,{ticket,bytes:0,keyBytes});return ticket;
 }
 commit(ticket:MetadataTicket,value:Readonly<Record<string,Json>>):boolean{
  const entry=this.#entries.get(ticket.filename);if(!entry||entry.ticket!==ticket)return false;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Invalid file metadata');validateJson(value);
  const thumbnails=value.thumbnails;if(thumbnails!==undefined){if(!Array.isArray(thumbnails)||thumbnails.length>256||thumbnails.some(item=>!item||typeof item!=='object'||Array.isArray(item)||item.relative_path!==undefined&&item.relative_path!==null&&typeof item.relative_path!=='string'))throw new TypeError('Invalid thumbnail metadata');}
  const bytes=boundedJsonBytes(value,this.#maxRecordBytes);boundedJsonBytes({...value,filename:ticket.filename},1024**2);if(this.#bytes+bytes>this.#maxBytes)throw new ApiError(503,'Metadata cache byte capacity exceeded');
  if(this.#retiringBundles.size)for(const relative of this.#references(value))if(this.#retiringBundles.has(relative.split('/')[1]))throw new ApiError(409,'Thumbnail bundle is retiring');
  const snapshot=structuredClone(value);freeze(snapshot);entry.snapshot=snapshot;entry.bytes=bytes;entry.ticket=undefined;this.#bytes+=bytes;this.#index(ticket.filename,snapshot);return true;
 }
 isCurrent(ticket:MetadataTicket):boolean{return this.#entries.get(ticket.filename)?.ticket===ticket;}
 fail(ticket:MetadataTicket):boolean{if(this.#entries.get(ticket.filename)?.ticket!==ticket)return false;return this.invalidate(ticket.filename);}
 invalidate(path:string):boolean{const entry=this.#entries.get(path);if(!entry)return false;this.#unindex(path,entry.snapshot);this.#entries.delete(path);this.#bytes-=entry.keyBytes+entry.bytes;return true;}
 clear():void{this.#thumbnailOwners.clear();this.#entries.clear();this.#bytes=0;}
 peek(path:string):Readonly<Record<string,Json>>|undefined{return this.#entries.get(path)?.snapshot;}
 #references(snapshot:Readonly<Record<string,Json>>|undefined):string[]{return ((snapshot?.thumbnails??[]) as Record<string,Json>[]).flatMap(item=>typeof item.relative_path==='string'&&/^\.thumbs\/thumb-[a-f0-9-]{36}\/(?:0|[1-9][0-9]?)\.(?:png|jpg)$/.test(item.relative_path)?[item.relative_path]:[]);}
 #index(path:string,snapshot:Readonly<Record<string,Json>>):void{for(const relative of this.#references(snapshot)){let owners=this.#thumbnailOwners.get(relative);if(!owners)this.#thumbnailOwners.set(relative,owners=new Set());owners.add(path);}}
 #unindex(path:string,snapshot:Readonly<Record<string,Json>>|undefined):void{for(const relative of this.#references(snapshot)){const owners=this.#thumbnailOwners.get(relative);owners?.delete(path);if(!owners?.size)this.#thumbnailOwners.delete(relative);}}
 /** Only current, unambiguous generated references are downloadable. Index keys
  * retain short relative names, not the expanded parent for every thumbnail. */
 thumbnailOwner(path:string):{filename:string;snapshot:Readonly<Record<string,Json>>;size:number}|undefined{
  const at=path.lastIndexOf('.thumbs/'),relative=path.slice(at);if(at<0)return;
  let found:{filename:string;snapshot:Readonly<Record<string,Json>>;size:number}|undefined;
  for(const filename of this.#thumbnailOwners.get(relative)??[]){if(thumbnailPath(filename,relative)!==path)continue;const snapshot=this.peek(filename)!;const item=(snapshot.thumbnails as Record<string,Json>[]).find(item=>item.relative_path===relative)!;if(!Number.isSafeInteger(item.size)||typeof item.size!=='number'||item.size<1||item.size>8*1024**2)return;if(found)return;found={filename,snapshot,size:item.size};}return found;
 }
 /** Exclude new references during awaited storage retirement. The lifecycle
  * owner must still prevent replay of retired scan tickets after release. */
 guardThumbnailRetirement(id:string):()=>void{
  if(!/^thumb-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw new TypeError('Invalid thumbnail retirement ID');
  if(this.#retiringBundles.has(id)||this.#retiringBundles.size>=64)throw new ApiError(409,'Thumbnail retirement already active or full');
  for(let index=0;index<100;index++)for(const ext of ['png','jpg'])if(this.#thumbnailOwners.has(`.thumbs/${id}/${index}.${ext}`))throw new ApiError(409,'Thumbnail bundle is still referenced');
  this.#retiringBundles.add(id);let active=true;return ()=>{if(active){active=false;this.#retiringBundles.delete(id);}};
 }
 metadata(path:string):Record<string,Json>{const snapshot=this.peek(path);if(!snapshot)throw new ApiError(404,`Metadata not available for <${path}>`);return {...snapshot,filename:path};}
 thumbnails(path:string):Json[]{
  const value=this.peek(path)?.thumbnails;if(!value)return [];
  let bytes=2;return (value as Record<string,Json>[]).map(item=>{const copy=structuredClone(item),relative=copy.relative_path;delete copy.relative_path;if(typeof relative==='string')copy.thumbnail_path=thumbnailPath(path,relative);bytes+=boundedJsonBytes(copy,1024**2)+1;if(bytes>1024**2)throw new ApiError(413,'Thumbnail response limit exceeded');return copy;});
 }
}
/** pathlib's lexical joining drops '.' and empty components, but preserves '..'. */
export function thumbnailPath(file:string,relative:string):string{
 const parts=(value:string)=>value.split('/').filter(part=>part!==''&&part!=='.');
 const root=(value:string)=>value.startsWith('//')&&!value.startsWith('///')?'//':value.startsWith('/')?'/':'';
 const parent=parts(file);parent.pop();const prefix=relative.startsWith('/')?root(relative):root(file),joined=relative.startsWith('/')?parts(relative):[...parent,...parts(relative)];
 return prefix+joined.join('/')||'.';
}
export interface FileMetadataReader {metadata(path:string):Record<string,Json>|Promise<Record<string,Json>>;thumbnails(path:string):Json[]|Promise<Json[]>;}
export function registerFileMetadata(registry:EndpointRegistry,store:FileMetadataReader):()=>void{
 const removers:(()=>void)[]=[];
 const name=(params:Readonly<Record<string,Json>>)=>{const value=params.filename;if(typeof value!=='string'||Buffer.byteLength(value)>4096||!value.isWellFormed()||value.includes('\0'))throw new ApiError(400,'Unable to extract argument [filename] as string');return value;};
 try{
  removers.push(registry.register({endpoint:'/server/files/metadata',methods:['GET']},params=>store.metadata(name(params))));
  removers.push(registry.register({endpoint:'/server/files/thumbnails',methods:['GET']},params=>store.thumbnails(name(params))));
 }catch(error){for(const remove of removers.reverse())remove();throw error;}
 let closed=false;return ()=>{if(closed)return;closed=true;for(const remove of removers.reverse())remove();};
}
