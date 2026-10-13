// Query/body selection follows pinned Moonraker RedirectHandler; GPL-3.0-or-later.
// Original Copyright (C) 2020 Eric Callahan.
import {ApiError} from './rpc.ts';
import {parseRequestJson} from './json.ts';
const whitespace='\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000',edges=new RegExp(`^[${whitespace}]+|[${whitespace}]+$`,'g');
/** Query's last url wins and is stripped as get_argument; otherwise decode
 * JSON regardless of content type. Never reflect a rejected URL/credential. */
export function redirectArgument(query:string,body:Uint8Array):string{
 let selected:string|undefined,value:unknown;for(const pair of query.split('&'))if(new URLSearchParams(pair).has('url'))selected=pair.slice(pair.indexOf('=')<0?pair.length:pair.indexOf('=')+1);
 if(selected!==undefined){try{value=decodeURIComponent(selected.replaceAll('+',' ').replace(/%(?![a-f\d]{2})/gi,'%25')).replace(edges,'');}catch{throw new ApiError(400,'Invalid redirect URL');}}
 else{try{const parsed:unknown=parseRequestJson(new TextDecoder('utf-8',{fatal:true}).decode(body));if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&Object.hasOwn(parsed,'url'))value=(parsed as Record<string,unknown>).url;}catch{}}
 if(value===undefined)throw new ApiError(400,'No url argument provided');
 if(typeof value!=='string')throw new ApiError(400,'Invalid redirect URL');return value;
}
/** Safe header serialization, full URL policy scope. Reject authority/path
 * normalization ambiguity; encode only Unicode, retaining percent/query bytes. */
export function safeRedirectTarget(value:unknown):string|undefined{
 if(typeof value!=='string'||!value||Buffer.byteLength(value)>4096||/[\x00-\x20\x7f\\]/.test(value))return;
 try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return;
  const ascii=value.replace(/[^\x21-\x7e]/gu,char=>encodeURIComponent(char));
  if(ascii.length>4096)return;
  const tail=ascii.slice(url.origin.length),normalized=ascii.startsWith(url.origin)&&(!tail||tail[0]==='?'||tail[0]==='#')?url.origin+'/'+tail:ascii;
  if(url.href!==normalized)return;return ascii;
 }catch{return;}
}
