import {unixPeerCredentials,type UnixPeerCredentials} from './unix-peer.ts';
// Klippy webhook wire protocol: JSON messages terminated by ETX, without the
// JSON-RPC version field. Based on pinned Moonraker klippy_connection.py.
import {Socket} from 'node:net';
import {ApiError,validateJson,type Json} from './rpc.ts';
import {parseRequestJson} from './json.ts';
export interface KlippySocketLimits {frameBytes?:number;pending?:number;pendingBytes?:number;outputBytes?:number;callbacks?:number;callbackBytes?:number;requestTimeoutMs?:number;callbackTimeoutMs?:number;connectTimeoutMs?:number;shutdownTimeoutMs?:number;}
export interface KlippyRequestOptions {signal?:AbortSignal;timeoutMs?:number;}
export type KlippyMethod=(params:Readonly<Record<string,Json>>,signal:AbortSignal)=>void|Promise<void>;
function bound(value:number|undefined,fallback:number,max:number){const n=value??fallback;if(!Number.isSafeInteger(n)||n<1||n>max)throw new ApiError(400,'Invalid Klippy socket limit');return n;}
/** Incremental framing copies only fragmented frames. Geometric growth avoids
 * one allocation per input byte and bounds retained partial-frame storage. */
export class KlippyFrames {
 #buffer:Buffer=Buffer.alloc(0);#length=0;readonly maximum:number;
 constructor(maximum=20*1024*1024){this.maximum=bound(maximum,20*1024*1024,64*1024*1024);}
 get bufferedBytes(){return this.#length;}
 clear(){this.#length=0;this.#buffer=Buffer.alloc(0);}
 push(chunk:Buffer,consume:(frame:Buffer)=>boolean|void):void{
  let start=0;for(;;){const end=chunk.indexOf(3,start),part=chunk.subarray(start,end<0?chunk.length:end);if(this.#length+part.length>this.maximum)throw new ApiError(413,'Klippy frame exceeds limit');
   if(end>=0&&this.#length===0){if(consume(part)===false)return;}else{this.#append(part);if(end>=0){const frame=this.#buffer.subarray(0,this.#length);this.#length=0;if(consume(frame)===false)return;}}
   if(end<0)return;start=end+1;if(start===chunk.length)return;
  }
 }
 #append(part:Buffer){if(!part.length)return;const size=this.#length+part.length;if(size>this.#buffer.length){const next=Buffer.allocUnsafe(Math.min(this.maximum,Math.max(size,4096,this.#buffer.length*2)));this.#buffer.copy(next,0,0,this.#length);this.#buffer=next;}part.copy(this.#buffer,this.#length);this.#length=size;}
}
interface Pending {id:number;bytes:number;resolve:(v:Json)=>void;reject:(e:unknown)=>void;timer:ReturnType<typeof setTimeout>;signal?:AbortSignal;cancel:()=>void;}
interface Callback {done:Promise<void>;finish:()=>void;timer:ReturnType<typeof setTimeout>;bytes:number;}
const object=(v:unknown):v is Record<string,Json>=>!!v&&typeof v==='object'&&!Array.isArray(v);
// Klippy/Moonraker turns all Python-falsy results into "ok".
function result(value:Json):Json{return value===null||value===false||value===0||value===''||Array.isArray(value)&&!value.length||object(value)&&!Object.keys(value).length?'ok':value;}
function encode(value:Json):string{let text=JSON.stringify(value);if(/\d{16}/.test(text))text=JSON.stringify(value,(_key,v)=>typeof v==='number'&&Number.isInteger(v)&&!Number.isSafeInteger(v)?(JSON as typeof JSON&{rawJSON(t:string):unknown}).rawJSON(v.toExponential()):v);return text;}
/** Single connection generation. No automatic reconnect or command replay.
 * A successful socket connection is NOT a Klippy readiness assertion.
 * Cancellation/timeout only stops waiting: already written commands may execute. */
export class KlippySocket {
 #peerCredentials:UnixPeerCredentials|null=null;#peerCredentialError:string|null=null;
 #phase:'new'|'connecting'|'connected'|'closing'|'closed'='new';#socket:Socket|undefined;#frames:KlippyFrames;#abort=new AbortController();#methods=new Map<string,KlippyMethod>();
 #pending=new Map<number,Pending>();#callbacks=new Set<Callback>();#next=1;#pendingBytes=0;#outputBytes=0;#callbackBytes=0;#closedSocket=Promise.resolve();#socketEnded=true;
 #openingReject:((e:unknown)=>void)|undefined;#openingTimer:ReturnType<typeof setTimeout>|undefined;#closing:Promise<void>|undefined;
 #limits:{pending:number;pendingBytes:number;outputBytes:number;callbacks:number;callbackBytes:number;requestTimeoutMs:number;callbackTimeoutMs:number;connectTimeoutMs:number;shutdownTimeoutMs:number};
 constructor(limits:KlippySocketLimits={}){this.#frames=new KlippyFrames(limits.frameBytes);this.#limits={pending:bound(limits.pending,256,100000),pendingBytes:bound(limits.pendingBytes,8*1024*1024,64*1024*1024),outputBytes:bound(limits.outputBytes,8*1024*1024,64*1024*1024),callbacks:bound(limits.callbacks,32,10000),callbackBytes:bound(limits.callbackBytes,20*1024*1024,64*1024*1024),requestTimeoutMs:bound(limits.requestTimeoutMs,300000,2147483647),callbackTimeoutMs:bound(limits.callbackTimeoutMs,30000,2147483647),connectTimeoutMs:bound(limits.connectTimeoutMs,5000,60000),shutdownTimeoutMs:bound(limits.shutdownTimeoutMs,5000,60000)};}
 get peerCredentials(){return this.#peerCredentials;}
 get peerCredentialError(){return this.#peerCredentialError;}
 get signal():AbortSignal{return this.#abort.signal;}
 get status(){return {phase:this.#phase,pending:this.#pending.size,pendingBytes:this.#pendingBytes,outputBytes:this.#outputBytes,callbacks:this.#callbacks.size,callbackBytes:this.#callbackBytes,inputBytes:this.#frames.bufferedBytes};}
 registerMethod(name:string,handler:KlippyMethod):()=>void{if(!name||name.length>256||typeof handler!=='function'||this.#methods.has(name)||this.#phase==='closing'||this.#phase==='closed')throw new Error('Invalid Klippy remote method');this.#methods.set(name,handler);return ()=>{if(this.#methods.get(name)===handler)this.#methods.delete(name);};}
 connect(path:string):Promise<void>{
  if(this.#phase!=='new'||typeof path!=='string'||!path||path.includes('\0')||Buffer.byteLength(path)>107)return Promise.reject(new ApiError(400,'Invalid Klippy socket path or state'));
  this.#phase='connecting';this.#socketEnded=false;const socket=this.#socket=new Socket();this.#closedSocket=new Promise<void>(resolve=>socket.once('close',()=>{this.#socketEnded=true;this.#fail(new ApiError(503,'Klippy disconnected'));this.#checkClosed();resolve();}));
  socket.on('error',()=>this.#fail(new ApiError(503,'Klippy socket failed')));socket.on('data',chunk=>{if(this.#phase!=='connected')return;try{this.#frames.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk),frame=>{this.#message(frame);return this.#phase==='connected';});}catch(error){this.#fail(error instanceof ApiError?error:new ApiError(502,'Invalid Klippy frame'));}});socket.on('end',()=>this.#fail(new ApiError(503,'Klippy disconnected')));
  return new Promise<void>((resolve,reject)=>{this.#openingReject=reject;this.#openingTimer=setTimeout(()=>this.#fail(new ApiError(504,'Klippy connection timed out')),this.#limits.connectTimeoutMs);socket.once('connect',()=>{if(this.#phase!=='connecting')return;clearTimeout(this.#openingTimer);this.#openingReject=undefined;this.#phase='connected';try{this.#peerCredentials=unixPeerCredentials(socket);this.#peerCredentialError=null;}catch(error){this.#peerCredentialError=error instanceof Error?error.message.slice(0,4096):'Peer credentials unavailable';}resolve();});try{socket.connect(path);}catch{this.#fail(new ApiError(503,'Klippy socket failed'));}});
 }
 request(method:string,params:Record<string,Json>={},options:KlippyRequestOptions={}):Promise<Json>{
  if(this.#phase!=='connected')throw new ApiError(503,'Klippy Host not connected');if(options.signal?.aborted)throw new ApiError(499,'Klippy request cancelled');
  if(typeof method!=='string'||!method||method.length>256||!object(params))throw new ApiError(400,'Invalid Klippy request');validateJson(params);if(!Number.isSafeInteger(this.#next))throw new ApiError(503,'Klippy request IDs exhausted');
  const id=this.#next++,text=encode({id,method,params}),bytes=Buffer.byteLength(text)+1;if(bytes-1>this.#frames.maximum)throw new ApiError(413,'Klippy request exceeds frame limit');
  if(this.#pending.size>=this.#limits.pending||this.#pendingBytes+bytes>this.#limits.pendingBytes||this.#outputBytes+bytes>this.#limits.outputBytes)throw new ApiError(429,'Klippy request capacity exceeded');const timeout=bound(options.timeoutMs,this.#limits.requestTimeoutMs,2147483647);
  let resolve!:(v:Json)=>void,reject!:(e:unknown)=>void;const promise=new Promise<Json>((r,j)=>{resolve=r;reject=j;}),cancel=()=>this.#settle(id,new ApiError(499,'Klippy request cancelled',{mayHaveExecuted:true})),timer=setTimeout(()=>this.#settle(id,new ApiError(504,'Klippy request timed out',{mayHaveExecuted:true})),timeout);
  const pending:Pending={id,bytes,resolve,reject,timer,signal:options.signal,cancel};this.#pending.set(id,pending);this.#pendingBytes+=bytes;options.signal?.addEventListener('abort',cancel,{once:true});this.#outputBytes+=bytes;
  let released=false;const written=(error?:Error|null)=>{if(released)return;released=true;this.#outputBytes-=bytes;if(error)this.#fail(new ApiError(503,'Klippy write failed'));};try{this.#socket!.write(text+'\x03',written);}catch{written(new Error('write'));}return promise;
 }
 #settle(id:number,error?:unknown,value?:Json){const job=this.#pending.get(id);if(!job)return;this.#pending.delete(id);this.#pendingBytes-=job.bytes;clearTimeout(job.timer);job.signal?.removeEventListener('abort',job.cancel);if(error!==undefined)job.reject(error);else job.resolve(value!);}
 #message(frame:Buffer){
  const value=parseRequestJson(new TextDecoder('utf-8',{fatal:true}).decode(frame));validateJson(value);if(!object(value))throw new ApiError(502,'Invalid Klippy message');
  if(value.method!==undefined&&value.method!==null){if(typeof value.method!=='string')throw new ApiError(502,'Invalid Klippy method');const handler=this.#methods.get(value.method);if(!handler)return;const params=value.params??{};if(!object(params))throw new ApiError(502,'Invalid Klippy method parameters');this.#invoke(handler,params,frame.length);return;}
  const id=value.id;if(typeof id!=='number'||!Number.isSafeInteger(id)||!this.#pending.has(id))return;
  if(Object.hasOwn(value,'result'))this.#settle(id,undefined,result(value.result));else{const error=value.error,message=typeof error==='string'?error:object(error)&&typeof error.message==='string'?error.message:'Malformed Klippy Response';this.#settle(id,new ApiError(400,message));}
 }
 #invoke(handler:KlippyMethod,params:Record<string,Json>,bytes:number){
  if(this.#callbacks.size>=this.#limits.callbacks||this.#callbackBytes+bytes>this.#limits.callbackBytes)throw new ApiError(429,'Klippy callback capacity exceeded');
  let finish!:()=>void;const done=new Promise<void>(r=>finish=r),job:Callback={done,finish,bytes,timer:setTimeout(()=>this.#fail(new ApiError(504,'Klippy callback timed out')),this.#limits.callbackTimeoutMs)};this.#callbacks.add(job);this.#callbackBytes+=bytes;
  const ended=()=>{clearTimeout(job.timer);if(this.#callbacks.delete(job))this.#callbackBytes-=bytes;job.finish();this.#checkClosed();};
  try{const task=handler(params,this.#abort.signal);if(task&&typeof task.then==='function')Promise.resolve(task).then(ended,()=>{this.#fail(new ApiError(502,'Klippy callback failed'));ended();});else ended();}catch{this.#fail(new ApiError(502,'Klippy callback failed'));ended();}
 }
 #fail(error:ApiError){if(this.#phase==='closed')return;this.#phase='closing';this.#peerCredentials=null;this.#peerCredentialError=null;clearTimeout(this.#openingTimer);this.#openingReject?.(error);this.#openingReject=undefined;for(const id of this.#pending.keys())this.#settle(id,new ApiError(error.status,error.message,{mayHaveExecuted:true}));this.#abort.abort(error);this.#frames.clear();this.#socket?.destroy();this.#checkClosed();}
 #checkClosed(){if(this.#phase==='closing'&&this.#socketEnded&&!this.#callbacks.size){this.#phase='closed';this.#methods.clear();}}
 close():Promise<void>{if(this.#closing)return this.#closing;this.#fail(new ApiError(503,'Klippy connection closed'));let timer:ReturnType<typeof setTimeout>|undefined;this.#closing=Promise.race([Promise.all([this.#closedSocket,...[...this.#callbacks].map(j=>j.done)]),new Promise<never>((_r,reject)=>{timer=setTimeout(()=>reject(new Error('Klippy callbacks did not stop before shutdown deadline')),this.#limits.shutdownTimeoutMs);})]).then(()=>{this.#checkClosed();}).finally(()=>{clearTimeout(timer);this.#closing=undefined;});return this.#closing;}
}
