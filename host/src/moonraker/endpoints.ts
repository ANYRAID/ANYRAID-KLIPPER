import {parseRequestJson,JsonNumberError} from './json.ts';
// Endpoint mapping and query parsing follow the pinned Moonraker APIDefinition
// and DynamicRequestHandler. GPL-3.0-or-later.
import {JsonRpcDispatcher,ApiError,validateJson,type Json,type RpcContext,type Transport} from './rpc.ts';
export type RequestVerb='GET'|'POST'|'DELETE';
export interface EndpointOptions{endpoint:string;methods:readonly RequestVerb[];transports?:readonly Transport[];remote?:boolean;rpcVerbPrefix?:boolean;}
export type EndpointHandler=(params:Readonly<Record<string,Json>>,verb:RequestVerb,context:RpcContext)=>Json|Promise<Json>;
interface Entry{path:string;methods:readonly RequestVerb[];rpcNames:readonly string[];objects:boolean;handler:EndpointHandler;transports:ReadonlySet<Transport>;}
const verbs:readonly RequestVerb[]=['GET','POST','DELETE'];
const excluded=new Set(['_','token','access_token','connection_id']);
function argumentsFrom(encoded:string,args:Map<string,string>):void{for(const item of encoded.split('&')){if(!item)continue;const at=item.indexOf('='),key=decodeURIComponent((at<0?item:item.slice(0,at)).replace(/\+/g,' ')),value=decodeURIComponent((at<0?'':item.slice(at+1)).replace(/\+/g,' ')).replace(/[\x00-\x08\x0e-\x1f]/g,' ').trim();args.set(key,value);if(args.size>1024)throw new ApiError(400,'Too many request arguments');}}
function convert(value:string,hint:string):Json{
 const numeric=value.replace(/(?<=\d)_(?=\d)/g,'');
 if(hint==='bool')return value.toLowerCase()==='true';
 if(hint==='int'&&/^[+-]?\d+$/.test(numeric)){const n=Number(numeric);return Number.isSafeInteger(n)?n:value;}
 if(hint==='float'&&/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(numeric)){const n=Number(numeric);return Number.isFinite(n)?n:value;}
 if(hint==='json')try{const v:unknown=parseRequestJson(value);validateJson(v);return v;}catch{}
 return value;
}
export function parseRestArguments(query:string,body:Uint8Array,contentType:string,objects=false):Record<string,Json>{
 const encoded=new Map<string,string>();try{argumentsFrom(query,encoded);if(contentType.trim().startsWith('application/x-www-form-urlencoded'))argumentsFrom(new TextDecoder('utf-8',{fatal:true}).decode(body),encoded);}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400,'Error Parsing Request Arguments. Is the Content-Type correct?');}
 const parsed:Record<string,Json>=Object.create(null);
 for(const [key,value] of encoded){if(excluded.has(key))continue;if(objects){parsed[key]=value?value.split(','):null;continue;}const at=key.lastIndexOf(':');parsed[at<0?key:key.slice(0,at)]=at<0?value:convert(value,key.slice(at+1));}
 const result:Record<string,Json>=objects?{objects:parsed}:parsed;
 if(contentType.trim().startsWith('application/json')){let json:unknown;try{json=parseRequestJson(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch(error){if(error instanceof JsonNumberError)throw new ApiError(400,error.message);validateJson(result);return result;}
  if(json===null||typeof json!=='object'||Array.isArray(json))throw new ApiError(400,'JSON request body must be an object');validateJson(json);for(const [key,value] of Object.entries(json))Object.defineProperty(result,key,{value,writable:true,enumerable:true,configurable:true});
 }
 validateJson(result);return result;
}
/** Shared static JSON REST and RPC registration. No endpoint is exposed until
 * every route and RPC name has passed duplicate validation. */
export class EndpointRegistry{
 readonly dispatcher:JsonRpcDispatcher;#entries=new Map<string,Entry>();#http=new Map<string,Entry>();
 constructor(dispatcher:JsonRpcDispatcher){this.dispatcher=dispatcher;}
 register(options:EndpointOptions,handler:EndpointHandler):()=>void{
  const {endpoint,remote=false}=options,path=remote?`/printer/${endpoint.replace(/^\/+|\/+$/g,'')}`:endpoint,transports=new Set<Transport>(options.transports??['http','websocket','unix','mqtt']);
  if(path==='/server/jsonrpc'||!/^\/(?:printer|server|machine|access|api|debug)\/[A-Za-z0-9_/-]+$/.test(path)||path.includes('//')||path.endsWith('/')||path.length>512||typeof handler!=='function'||!transports.size||[...transports].some(t=>!['http','websocket','unix','mqtt'].includes(t)))throw new Error('Invalid endpoint definition');
  if(options.rpcVerbPrefix!==undefined&&(typeof options.rpcVerbPrefix!=='boolean'||remote))throw new Error('Invalid RPC verb prefix');
  if(this.#entries.has(path))throw new Error('Endpoint already registered');
  const methods=remote?['GET','POST'] as const:verbs.filter(v=>options.methods.includes(v));if(!methods.length||!remote&&(methods.length!==options.methods.length))throw new Error('Invalid endpoint request methods');
  const parts=path.slice(1).split('/'),name=parts.at(-1)!,names=remote||methods.length===1&&!options.rpcVerbPrefix?[parts.join('.')]:methods.map(v=>[...parts.slice(0,-1),`${v.toLowerCase()}_${name}`].join('.'));
  const rpcEnabled=remote||!(transports.size===1&&transports.has('http'));if(rpcEnabled&&names.some(n=>this.dispatcher.has(n)))throw new Error('RPC method already registered');
  const entry:Entry={path,methods:[...methods],rpcNames:names,objects:remote&&endpoint.startsWith('objects/'),handler,transports};
  if(rpcEnabled)for(let i=0;i<names.length;i++)this.dispatcher.register(names[i],[...transports],(params,context)=>handler(params,methods[i],context));
  this.#entries.set(path,entry);if(transports.has('http'))this.#http.set(path,entry);
  return ()=>{if(this.#entries.get(path)!==entry)return;this.#entries.delete(path);this.#http.delete(path);if(rpcEnabled)for(const name of names)this.dispatcher.remove(name);};
 }
 allowed(path:string):readonly RequestVerb[]|undefined{const entry=this.#http.get(path);return entry?[...entry.methods]:undefined;}
 parse(path:string,query:string,body:Uint8Array,contentType:string):Record<string,Json>{const entry=this.#http.get(path);if(!entry)throw new ApiError(404,'Not Found');return parseRestArguments(query,body,contentType,entry.objects);}
 async invoke(path:string,verb:string,params:Record<string,Json>,context:RpcContext):Promise<Json>{
  const entry=this.#http.get(path);if(!entry)throw new ApiError(404,'Not Found');const at=entry.methods.indexOf(verb as RequestVerb);if(at<0)throw new ApiError(405,'Method Not Allowed');
  validateJson(params);context.signal.throwIfAborted();await context.authorize(entry.rpcNames[at]??entry.rpcNames[0],params);context.signal.throwIfAborted();const result=await entry.handler(params,verb as RequestVerb,context);context.signal.throwIfAborted();validateJson(result);return result;
 }
}
