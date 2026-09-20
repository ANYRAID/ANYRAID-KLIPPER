import {ApiError,type Json} from './rpc.ts';
// Call validateJson first; count serialized UTF-8 without constructing one large output.
export function boundedJsonBytes(value:Json,limit:number):number{
 let bytes=0;const add=(size:number)=>{bytes+=size;if(bytes>limit)throw new ApiError(413,'JSON byte limit exceeded');};
 const string=(text:string)=>{if(Buffer.byteLength(text)>limit-bytes)throw new ApiError(413,'JSON byte limit exceeded');add(Buffer.byteLength(JSON.stringify(text)));};
 const visit=(item:Json):void=>{
  if(typeof item==='string'){string(item);return;}
  if(item===null||typeof item!=='object'){add(JSON.stringify(item).length);return;}
  add(2);if(Array.isArray(item)){for(let i=0;i<item.length;i++){if(i)add(1);visit(item[i]);}}
  else{let first=true;for(const [key,child] of Object.entries(item)){if(!first)add(1);first=false;string(key);add(1);visit(child);}}
 };visit(value);return bytes;
}
