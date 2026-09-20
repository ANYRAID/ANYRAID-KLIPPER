// Moonraker metadata/thumbnails response semantics, GPL-3.0-or-later.
import {ApiError,validateJson,type Json} from './rpc.ts';
import {boundedJsonBytes} from './json-size.ts';
import type {EndpointRegistry} from './endpoints.ts';
export interface MetadataTicket {readonly filename:string;}
interface Entry {ticket?:MetadataTicket;snapshot?:Readonly<Record<string,Json>>;bytes:number;keyBytes:number;}
function freeze(value:Json):void{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}}
function filename(value:string):void{if(typeof value!=='string'||!value.isWellFormed()||!value||value.startsWith('/')||value.includes('\0')||Buffer.byteLength(value)>4096||value.split('/').some(part=>!part||part==='.'||part==='..'))throw new TypeError('Invalid metadata filename');}
/** Immutable bounded snapshots. Scanner/storage owners must invalidate a changed
 * source and commit with its current ticket; this cache does not watch files. */
export class FileMetadataStore {
 #entries=new Map<string,Entry>();#bytes=0;#maxRecords:number;#maxBytes:number;#maxRecordBytes:number;
 constructor(options:{maxRecords?:number;maxBytes?:number;maxRecordBytes?:number}={}){
  this.#maxRecords=options.maxRecords??4096;this.#maxBytes=options.maxBytes??16*1024**2;this.#maxRecordBytes=options.maxRecordBytes??256*1024;
  for(const [value,max] of [[this.#maxRecords,10000],[this.#maxBytes,64*1024**2],[this.#maxRecordBytes,1024**2]])if(!Number.isSafeInteger(value)||value<1||value>max)throw new RangeError('Invalid metadata capacity');
 }
 get status(){return {entries:this.#entries.size,bytes:this.#bytes,maxRecords:this.#maxRecords,maxBytes:this.#maxBytes,maxRecordBytes:this.#maxRecordBytes};}
 begin(path:string):MetadataTicket{
  filename(path);const previous=this.#entries.get(path),keyBytes=Buffer.byteLength(path);
  if(!previous&&(this.#entries.size>=this.#maxRecords||this.#bytes+keyBytes>this.#maxBytes))throw new ApiError(503,'Metadata cache capacity exceeded');
  if(previous)this.#bytes-=previous.bytes;else this.#bytes+=keyBytes;
  const ticket=Object.freeze({filename:path});this.#entries.set(path,{ticket,bytes:0,keyBytes});return ticket;
 }
 commit(ticket:MetadataTicket,value:Readonly<Record<string,Json>>):boolean{
  const entry=this.#entries.get(ticket.filename);if(!entry||entry.ticket!==ticket)return false;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Invalid file metadata');validateJson(value);
  const thumbnails=value.thumbnails;if(thumbnails!==undefined){if(!Array.isArray(thumbnails)||thumbnails.length>256||thumbnails.some(item=>!item||typeof item!=='object'||Array.isArray(item)||item.relative_path!==undefined&&item.relative_path!==null&&typeof item.relative_path!=='string'))throw new TypeError('Invalid thumbnail metadata');}
  const bytes=boundedJsonBytes(value,this.#maxRecordBytes);boundedJsonBytes({...value,filename:ticket.filename},1024**2);if(this.#bytes+bytes>this.#maxBytes)throw new ApiError(503,'Metadata cache byte capacity exceeded');
  const snapshot=structuredClone(value);freeze(snapshot);entry.snapshot=snapshot;entry.bytes=bytes;entry.ticket=undefined;this.#bytes+=bytes;return true;
 }
 fail(ticket:MetadataTicket):boolean{if(this.#entries.get(ticket.filename)?.ticket!==ticket)return false;return this.invalidate(ticket.filename);}
 invalidate(path:string):boolean{const entry=this.#entries.get(path);if(!entry)return false;this.#entries.delete(path);this.#bytes-=entry.keyBytes+entry.bytes;return true;}
 clear():void{this.#entries.clear();this.#bytes=0;}
 peek(path:string):Readonly<Record<string,Json>>|undefined{return this.#entries.get(path)?.snapshot;}
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
export function registerFileMetadata(registry:EndpointRegistry,store:FileMetadataStore):()=>void{
 const removers:(()=>void)[]=[];
 const name=(params:Readonly<Record<string,Json>>)=>{const value=params.filename;if(typeof value!=='string'||Buffer.byteLength(value)>4096||!value.isWellFormed()||value.includes('\0'))throw new ApiError(400,'Unable to extract argument [filename] as string');return value;};
 try{
  removers.push(registry.register({endpoint:'/server/files/metadata',methods:['GET']},params=>store.metadata(name(params))));
  removers.push(registry.register({endpoint:'/server/files/thumbnails',methods:['GET']},params=>store.thumbnails(name(params))));
 }catch(error){for(const remove of removers.reverse())remove();throw error;}
 let closed=false;return ()=>{if(closed)return;closed=true;for(const remove of removers.reverse())remove();};
}
