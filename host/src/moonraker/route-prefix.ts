// Route configuration follows pinned Moonraker application.py; GPL-3.0-or-later.
const segment=(value:string)=>encodeURIComponent(value).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
/** Absent differs from an explicitly empty prefix. Collapse empty components
 * and escape each Unicode component as Tornado url_escape(plus=False). */
export function readRoutePrefix(value:string|null):string{
 if(value===null)return '';
 if(typeof value!=='string'||Buffer.byteLength(value)>1024)throw new TypeError('Invalid route_prefix');
 const parts=value.split('/').filter(Boolean);
 if(!parts.length||parts.some(p=>p==='.'||p==='..'))throw new TypeError('Invalid route_prefix');
 const result='/'+parts.map(segment).join('/');validateRoutePrefix(result);return result;
}
/** Transport receives the canonical encoded prefix, never a routing regexp. */
export function validateRoutePrefix(value:string):void{
 if(value==='')return;
 if(typeof value!=='string'||value.length>4096||!value.startsWith('/')||value.endsWith('/'))throw new TypeError('Invalid canonical route prefix');
 for(const part of value.slice(1).split('/')){let decoded:string;try{decoded=decodeURIComponent(part);}catch{throw new TypeError('Invalid canonical route prefix');}if(!part||decoded==='.'||decoded==='..'||decoded.includes('/')||segment(decoded)!==part)throw new TypeError('Invalid canonical route prefix');}
}
/** Match a complete path boundary; retain original query/percent escapes and
 * never rewrite IncomingMessage.url, credential parsing or filesystem paths. */
export function relativeRouteUrl(url:string,prefix:string):string|undefined{
 if(!prefix)return url;
 return url.startsWith(prefix+'/')?url.slice(prefix.length):undefined;
}
