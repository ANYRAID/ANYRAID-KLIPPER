import {workerEntry} from '../runtime/worker-entry.ts';
import {fork,type ChildProcess} from 'node:child_process';
import {ApiError} from './rpc.ts';
import type {ThumbnailImage} from './thumbnail-images.ts';
export interface ThumbnailProcessorOptions {maxPending?:number;maxQueuedBytes?:number;timeoutMs?:number;startupTimeoutMs?:number;}
interface Request {id:number;kind:'blocks'|'png';data:string|Buffer;bytes:number;finish:(error:unknown,images?:ThumbnailImage[])=>void;dispose:()=>void;}
/** Serial image processing in a separate process, including its native thread pools.
 * Active cancellation/timeout fences the instance and kills the child; no auto-restart. */
export class ThumbnailProcessor {
 #child:ChildProcess;#requests=new Map<number,Request>();#active:number|undefined;#next=0;#bytes=0;#closed=false;#closing:Promise<void>|undefined;
 #exit=Promise.withResolvers<void>();#options:Required<ThumbnailProcessorOptions>;
 private constructor(options:Required<ThumbnailProcessorOptions>){this.#options=options;this.#child=fork(workerEntry('./thumbnail-process-child.ts',import.meta.url),[],{execPath:process.execPath,execArgv:['--max-old-space-size=64','--max-semi-space-size=8'],env:{...process.env,UV_THREADPOOL_SIZE:'2'},serialization:'advanced',stdio:['ignore','ignore','ignore','ipc']});}
 static async open(input:ThumbnailProcessorOptions={}):Promise<ThumbnailProcessor>{
  const options={maxPending:input.maxPending??4,maxQueuedBytes:input.maxQueuedBytes??4*1024**2,timeoutMs:input.timeoutMs??5000,startupTimeoutMs:input.startupTimeoutMs??5000};
  for(const [key,max] of [['maxPending',64],['maxQueuedBytes',16*1024**2],['timeoutMs',60000],['startupTimeoutMs',60000]] as const)if(!Number.isSafeInteger(options[key])||options[key]<1||options[key]>max)throw new RangeError('Invalid thumbnail process capacity');
  const instance=new ThumbnailProcessor(options),ready=Promise.withResolvers<void>();let started=false;
  instance.#child.on('error',error=>{ready.reject(error);instance.#fail(error);});
  instance.#child.on('exit',(code,signal)=>{const error=new ApiError(503,`Thumbnail process exited (${code??signal})`);ready.reject(error);instance.#fail(error);});
  instance.#child.on('close',()=>instance.#exit.resolve());
  instance.#child.on('disconnect',()=>{const error=new ApiError(503,'Thumbnail process disconnected');ready.reject(error);instance.#fail(error);});
  instance.#child.on('message',message=>{
   const result=message as {ready?:boolean;id?:number;images?:ThumbnailImage[];error?:string};
   if(!started&&result?.ready===true){started=true;ready.resolve();return;}
   if(instance.#closed)return;
   if(!started||!result||result.id!==instance.#active){instance.#fail(new ApiError(502,'Unexpected thumbnail process response'));return;}
   const request=instance.#requests.get(result.id!);if(!request){instance.#fail(new ApiError(502,'Unknown thumbnail process request'));return;}
   instance.#remove(request);instance.#active=undefined;
   if(typeof result.error==='string')request.finish(new ApiError(422,result.error));
   else if(!Array.isArray(result.images)||result.images.length>65||result.images.some(image=>!image||!Buffer.isBuffer(image.bytes)||!Number.isSafeInteger(image.width)||!Number.isSafeInteger(image.height)||image.width<1||image.height<1||image.width>2048||image.height>2048||image.width*image.height>4*1024**2||!['png','jpg'].includes(image.format)||typeof image.miniature!=='boolean')||result.images.reduce((n,image)=>n+image.bytes.length,0)>8*1024**2){request.finish(new ApiError(502,'Invalid thumbnail process output'));instance.#fail(new ApiError(502,'Invalid thumbnail process output'));return;}
   else request.finish(undefined,result.images);
   instance.#dispatch();
  });
  const timer=setTimeout(()=>ready.reject(new ApiError(504,'Thumbnail process startup timed out')),options.startupTimeoutMs);
  try{await ready.promise;return instance;}catch(error){await instance.close();throw error;}finally{clearTimeout(timer);}
 }
 get status(){return {pid:this.#child.pid,pending:this.#requests.size,bytes:this.#bytes,active:this.#active!==undefined,closed:this.#closed};}
 prepare(data:string,signal:AbortSignal):Promise<ThumbnailImage[]>{
  if(this.#closed)return Promise.reject(new ApiError(503,'Thumbnail processor is closed'));
  if(signal.aborted)return Promise.reject(signal.reason);
  if(typeof data!=='string')return Promise.reject(new TypeError('Invalid thumbnail input'));
  if(data.length>2*1024**2)return Promise.reject(new ApiError(413,'Thumbnail text limit exceeded'));
  const bytes=Buffer.byteLength(data);if(bytes>2*1024**2)return Promise.reject(new ApiError(413,'Thumbnail text limit exceeded'));
  return this.#enqueue('blocks',data,bytes,signal);
 }
 /** UFP PNG input is decoded in the same isolated owner; never rewrite G-code. */
 preparePng(data:Buffer,signal:AbortSignal):Promise<ThumbnailImage[]>{
  if(this.#closed)return Promise.reject(new ApiError(503,'Thumbnail processor is closed'));
  if(signal.aborted)return Promise.reject(signal.reason);
  if(!Buffer.isBuffer(data))return Promise.reject(new TypeError('Invalid thumbnail PNG input'));
  if(data.length>4*1024**2)return Promise.reject(new ApiError(413,'Thumbnail PNG limit exceeded'));
  return this.#enqueue('png',data,data.length,signal);
 }
 #enqueue(kind:'blocks'|'png',data:string|Buffer,bytes:number,signal:AbortSignal):Promise<ThumbnailImage[]>{
  if(this.#requests.size>=this.#options.maxPending||this.#bytes+bytes>this.#options.maxQueuedBytes||this.#next===Number.MAX_SAFE_INTEGER)return Promise.reject(new ApiError(503,'Thumbnail process queue is full'));
  const id=++this.#next,result=Promise.withResolvers<ThumbnailImage[]>();let settled=false;
  const finish=(error:unknown,images?:ThumbnailImage[])=>{if(settled)return;settled=true;if(error!==undefined)result.reject(error);else if(signal.aborted)result.reject(signal.reason);else result.resolve(images!);};
  const cancel=(error:unknown)=>{const request=this.#requests.get(id);if(!request)return;if(this.#active===id){this.#fail(error);return;}this.#remove(request);finish(error);};
  const abort=()=>cancel(signal.reason??new ApiError(499,'Thumbnail processing cancelled'));
  const timer=setTimeout(()=>cancel(new ApiError(504,'Thumbnail processing timed out')),this.#options.timeoutMs);
  const dispose=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
  // Own a snapshot even while queued; callers may reuse their archive buffer.
  this.#requests.set(id,{id,kind,data:Buffer.isBuffer(data)?Buffer.from(data):data,bytes,finish,dispose});this.#bytes+=bytes;signal.addEventListener('abort',abort,{once:true});this.#dispatch();return result.promise;
 }
 #remove(request:Request):void{this.#requests.delete(request.id);this.#bytes-=request.bytes;request.data='';request.dispose();}
 #dispatch():void{
  if(this.#closed||this.#active!==undefined)return;const request=this.#requests.values().next().value as Request|undefined;if(!request)return;this.#active=request.id;
  // Only one IPC request is in flight; retained budget covers it until acknowledgment.
  try{this.#child.send({id:request.id,kind:request.kind,data:request.data},error=>{if(error)this.#fail(error);});request.data='';}catch(error){this.#fail(error);}
 }
 #fail(error:unknown):void{
  if(!this.#closed){this.#closed=true;for(const request of this.#requests.values()){request.finish(error);request.dispose();request.data='';}this.#requests.clear();this.#active=undefined;this.#bytes=0;}
  if(!this.#closing){this.#closing=this.#exit.promise;this.#child.kill('SIGKILL');}
 }
 close():Promise<void>{this.#fail(new ApiError(503,'Thumbnail processor is closed'));return this.#closing!;}
}
