import {ApiError,validateJson,type Json,type RpcId} from './rpc.ts';
import {parseRequestJson} from './json.ts';
export type ClientArguments=Json[]|{[key:string]:Json}|null;
export interface ClientRequestLimits {pending?:number;perClient?:number;bytes?:number;timeoutMs?:number;}
export interface ClientRequestOptions {signal?:AbortSignal;timeoutMs?:number;}
export interface ClientRequestTarget {signal:AbortSignal;authorize(method:string,params:ClientArguments,signal:AbortSignal):void|Promise<void>;send(encoded:string):boolean;}
export class ClientResponseError extends ApiError {constructor(data:Json){super(424,'Client RPC error',data);}}
interface Peer {id:number;target:ClientRequestTarget;abort:()=>void;closed:boolean;jobs:Set<Job>;awaiting:number;}
interface Job {id:number;peer:Peer;encoded:string;bytes:number;abort:AbortController;working:boolean;settled:boolean;sent:boolean;resolve:(value:Json)=>void;reject:(error:unknown)=>void;done?:Promise<void>;finish?:()=>void;timer?:ReturnType<typeof setTimeout>;signal?:AbortSignal;cancel:()=>void;}
function limit(value:number|undefined,fallback:number,max:number):number{const n=value??fallback;if(!Number.isSafeInteger(n)||n<1||n>max)throw new ApiError(400,'Invalid client request limit');return n;}
function freeze(value:Json):void{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}}
export function encodeClientMessage(value:Json):string{
 let text=JSON.stringify(value);
 // Keep finite binary64 quantities above MAX_SAFE_INTEGER explicitly floating
 // on the wire; exact integer quantities must already be encoded as strings.
 if(/\d{16}/.test(text))text=JSON.stringify(value,(_key,item)=>typeof item==='number'&&Number.isInteger(item)&&!Number.isSafeInteger(item)?(JSON as typeof JSON&{rawJSON(text:string):unknown}).rawJSON(item.toExponential()):item);
 return text;
}
function response(value:Json):value is {[key:string]:Json}{return !!value&&typeof value==='object'&&!Array.isArray(value)&&!Object.hasOwn(value,'method')&&value.jsonrpc==='2.0'&&(typeof value.id==='string'||typeof value.id==='number'&&Number.isSafeInteger(value.id))&&(Object.hasOwn(value,'result')!==Object.hasOwn(value,'error'));}
/** Outbound JSON-RPC ownership is (connection,id), not id alone. Cancellation
 * rejects the caller immediately but retains ignored authorization work until
 * it actually settles, including byte/capacity accounting and close(). */
export class ClientRequests {
 #peers=new Map<number,Peer>();#jobs=new Map<number,Job>();#awaiting=0;#bytes=0;#next=1;#closed=false;
 #pending:number;#perClient:number;#maximumBytes:number;#timeout:number;
 constructor(limits:ClientRequestLimits={}){this.#pending=limit(limits.pending,256,100000);this.#perClient=limit(limits.perClient,32,10000);this.#maximumBytes=limit(limits.bytes,8*1024*1024,64*1024*1024);this.#timeout=limit(limits.timeoutMs,30000,2147483647);}
 get status(){return {pending:this.#jobs.size,awaiting:this.#awaiting,bytes:this.#bytes,closed:this.#closed};}
 awaiting(id:number):boolean{return (this.#peers.get(id)?.awaiting??0)>0;}
 add(id:number,target:ClientRequestTarget):void{if(this.#closed||!Number.isSafeInteger(id)||id<1||this.#peers.has(id))throw new Error('Invalid client request peer');if(target.signal.aborted)return;const peer:Peer={id,target,closed:false,jobs:new Set(),awaiting:0,abort:()=>this.remove(id)};this.#peers.set(id,peer);target.signal.addEventListener('abort',peer.abort,{once:true});}
 remove(id:number):void{const peer=this.#peers.get(id);if(!peer)return;peer.closed=true;this.#peers.delete(id);peer.target.signal.removeEventListener('abort',peer.abort);for(const job of [...peer.jobs])this.#cancel(job,new ApiError(503,'Client disconnected'));}
 request(id:number,method:string,params:ClientArguments=null,options:ClientRequestOptions={}):Promise<Json>{
  const peer=this.#peers.get(id);if(this.#closed||!peer||peer.closed)throw new ApiError(503,'Client is not connected');if(options.signal?.aborted)throw new ApiError(499,'Client request cancelled');
  if(typeof method!=='string'||!method||method.length>256)throw new ApiError(400,'Invalid client method');if(params!==null&&(typeof params!=='object'||!params))throw new ApiError(400,'Client arguments must be an object or list');validateJson(params);
  if(!Number.isSafeInteger(this.#next))throw new ApiError(503,'Client request IDs exhausted');const requestId=this.#next++,include=params!==null&&(Array.isArray(params)?params.length:Object.keys(params).length)>0;
  const encoded=encodeClientMessage({jsonrpc:'2.0',method,id:requestId,...include?{params}:{} }),bytes=Buffer.byteLength(encoded);if(bytes>1024*1024)throw new ApiError(413,'Client request exceeds message limit');
  if(this.#jobs.size>=this.#pending||peer.jobs.size>=this.#perClient||this.#bytes+bytes>this.#maximumBytes)throw new ApiError(429,'Client request capacity exceeded');
  const timeout=limit(options.timeoutMs,this.#timeout,2147483647),snapshot:ClientArguments=JSON.parse(encoded).params??null;freeze(snapshot);
  let resolve!:(value:Json)=>void,reject!:(error:unknown)=>void;const result=new Promise<Json>((a,b)=>{resolve=a;reject=b;});
  const job:Job={id:requestId,peer,encoded,bytes,abort:new AbortController(),working:true,settled:false,sent:false,resolve,reject,signal:options.signal,cancel:()=>this.#cancel(job,new ApiError(499,'Client request cancelled'))};
  this.#jobs.set(job.id,job);peer.jobs.add(job);this.#bytes+=bytes;options.signal?.addEventListener('abort',job.cancel,{once:true});job.timer=setTimeout(()=>this.#cancel(job,new ApiError(504,'Client request timed out')),timeout);
  try{const authorized=peer.target.authorize(method,snapshot,job.abort.signal);if(authorized&&typeof authorized.then==='function')Promise.resolve(authorized).then(()=>{job.working=false;this.#send(job);},error=>{job.working=false;this.#settle(job,error instanceof ApiError?error:new ApiError(401,'Client request authorization denied'));});else{job.working=false;this.#send(job);}}
  catch(error){job.working=false;this.#settle(job,error instanceof ApiError?error:new ApiError(401,'Client request authorization denied'));}
  return result;
 }
 #send(job:Job):void{if(job.settled){this.#release(job);return;}if(job.peer.closed||job.abort.signal.aborted){this.#cancel(job,new ApiError(503,'Client disconnected'));return;}
  job.sent=true;job.peer.awaiting++;this.#awaiting++;
  try{if(!job.peer.target.send(job.encoded))this.#settle(job,new ApiError(503,'Client request could not be sent'));}catch{this.#settle(job,new ApiError(503,'Client request transport failed'));}
 }
 receive(clientId:number,id:RpcId,value:{result?:Json;error?:Json}):boolean{
  if(typeof id!=='number')return false;const job=this.#jobs.get(id);if(!job||job.peer.id!==clientId||job.settled||!job.sent)return false;
  if(Object.hasOwn(value,'result')===Object.hasOwn(value,'error'))return false;
  try{validateJson(Object.hasOwn(value,'result')?value.result:value.error);}catch{return false;}
  this.#settle(job,Object.hasOwn(value,'error')?new ClientResponseError(value.error!):undefined,value.result);return true;
 }
 /** Process reply items before admitting ordinary requests, so a saturated
  * inbound request pool cannot deadlock waiting for its agents' replies. */
 acceptFrame(clientId:number,input:Uint8Array):{value?:Json}|undefined{
  if(!this.awaiting(clientId)||input.byteLength>1024*1024)return;let value:Json;
  try{value=parseRequestJson(new TextDecoder('utf-8',{fatal:true}).decode(input)) as Json;validateJson(value);if(Array.isArray(value)&&value.length>256)return;}catch{return;}
  if(Array.isArray(value)){const remaining:Json[]=[];let replies=0;for(const item of value){if(response(item)){this.receive(clientId,item.id as RpcId,item);replies++;}else remaining.push(item);}return {value:replies&&!remaining.length?undefined:remaining};}
  if(response(value)){this.receive(clientId,value.id as RpcId,value);return {};}
  return {value};
 }
 #cancel(job:Job,error:ApiError):void{const cancelled=!job.settled;this.#settle(job,error);if(cancelled)job.abort.abort(error);}
 #settle(job:Job,error?:unknown,value?:Json):void{
  if(!job.settled){job.settled=true;clearTimeout(job.timer);job.signal?.removeEventListener('abort',job.cancel);if(job.sent){job.peer.awaiting--;this.#awaiting--;job.sent=false;}if(error!==undefined)job.reject(error);else job.resolve(value!);}
  this.#release(job);
 }
 #release(job:Job):void{if(!job.settled||job.working||!this.#jobs.delete(job.id))return;job.peer.jobs.delete(job);this.#bytes-=job.bytes;job.finish?.();}
 close():Promise<void>{this.#closed=true;for(const id of [...this.#peers.keys()])this.remove(id);return Promise.all([...this.#jobs.values()].map(job=>job.done??=new Promise<void>(resolve=>job.finish=resolve))).then(()=>{});}
}
