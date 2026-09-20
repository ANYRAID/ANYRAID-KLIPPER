import {isUtf8} from 'node:buffer';
import type {FileHandle} from 'node:fs/promises';
export const METADATA_READ_BYTES=1024**2;
/** UTF-8 errors='ignore', preserving real U+FFFD and BOM characters. */
export function decodeMetadataUtf8(bytes:Buffer):string{
 if(isUtf8(bytes))return bytes.toString('utf8');
 const output=Buffer.allocUnsafe(bytes.length);let written=0,i=0;
 while(i<bytes.length){
  const lead=bytes[i];if(lead<0x80){output[written++]=lead;i++;continue;}
  let width=lead>=0xc2&&lead<=0xdf?2:lead>=0xe0&&lead<=0xef?3:lead>=0xf0&&lead<=0xf4?4:0;
  if(i+width>bytes.length)width=0;
  if(width>1){for(let j=1;j<width;j++)if((bytes[i+j]&0xc0)!==0x80){width=0;break;}}
  if(width>2&&(lead===0xe0&&bytes[i+1]<0xa0||lead===0xed&&bytes[i+1]>=0xa0||lead===0xf0&&bytes[i+1]<0x90||lead===0xf4&&bytes[i+1]>=0x90))width=0;
  if(width){for(let j=0;j<width;j++)output[written++]=bytes[i++];}else i++;
 }
 return output.toString('utf8',0,written);
}
export interface MetadataWindow {
 readonly size:number;readonly modified:number;readonly data:string;readonly header:string;readonly footer:string;
 readonly source:Readonly<{dev:bigint;ino:bigint;mtimeNs:bigint;ctimeNs:bigint}>;
}
function sliceCodepoints(value:string):{header:string;footer:string}{
 if(value.length<=METADATA_READ_BYTES)return {header:value,footer:value};
 if(!/[\ud800-\udfff]/.test(value))return {header:value.slice(0,METADATA_READ_BYTES),footer:value.slice(-METADATA_READ_BYTES)};
 let end=0,start=value.length;
 for(let count=0;count<METADATA_READ_BYTES&&end<value.length;count++){const cp=value.charCodeAt(end);end+=cp>=0xd800&&cp<=0xdbff?2:1;}
 for(let count=0;count<METADATA_READ_BYTES&&start>0;count++){const cp=value.charCodeAt(--start);if(cp>=0xdc00&&cp<=0xdfff)start--;}
 return {header:value.slice(0,end),footer:value.slice(start)};
}
/** Read the pinned Python extractor's byte windows from an authorized descriptor.
 * Caller retains ownership. No path resolution, content write or whole-file digest. */
export async function readMetadataWindow(source:FileHandle,signal:AbortSignal,options:{maxFileBytes?:number}={}):Promise<MetadataWindow>{
 const max=options.maxFileBytes??16*1024**3;if(!Number.isSafeInteger(max)||max<0||max>1024**4)throw new RangeError('Invalid metadata file limit');
 signal.throwIfAborted();const before=await source.stat({bigint:true});signal.throwIfAborted();
 if(!before.isFile()||before.size>BigInt(max))throw new Error('Metadata source exceeds regular file limit');
 const size=Number(before.size);
 const read=async(position:number,length:number)=>{
  const bytes=Buffer.allocUnsafe(length);let used=0;
  while(used<length){signal.throwIfAborted();const result=await source.read(bytes,used,length-used,position+used);signal.throwIfAborted();if(!result.bytesRead)throw new Error('Metadata source truncated during read');used+=result.bytesRead;}
  return decodeMetadataUtf8(bytes);
 };
 const head=await read(0,Math.min(size,METADATA_READ_BYTES));
 const offset=size>2*METADATA_READ_BYTES?size-METADATA_READ_BYTES:METADATA_READ_BYTES;
 const tail=size>METADATA_READ_BYTES?await read(offset,size-offset):'';
 const after=await source.stat({bigint:true});signal.throwIfAborted();
 if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new Error('Metadata source changed during read');
 const data=head+tail;let seconds=before.mtimeNs/1000000000n,nanos=before.mtimeNs%1000000000n;if(nanos<0){seconds--;nanos+=1000000000n;}
 return Object.freeze({size,modified:Number(seconds)+Number(nanos)*1e-9,data,...sliceCodepoints(data),source:Object.freeze({dev:before.dev,ino:before.ino,mtimeNs:before.mtimeNs,ctimeNs:before.ctimeNs})});
}
