// Pinned Moonraker http_client.py semantics. GPL-3.0-or-later.
// Original Copyright (C) 2022 Eric Callahan.
import {request as httpRequest,Agent as HttpAgent} from 'node:http';
import {request as httpsRequest,Agent as HttpsAgent} from 'node:https';
import {createGunzip,createInflate,createBrotliDecompress} from 'node:zlib';
import {open,mkdtemp,rm,lstat,rename} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,basename,dirname,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as pause} from 'node:timers/promises';
import type {IncomingMessage} from 'node:http';
import type {Transform} from 'node:stream';
import {ApiError} from './rpc.ts';
import {parseExactJson,stringifyExactJson,type ExactJson,type ExactJsonOptions} from './json-exact.ts';
const MAX_BODY=512*1024**2;
export interface HttpRequestOptions {
 body?:string|Uint8Array|ExactJson[]|Record<string,ExactJson>|null;headers?:Record<string,string>;
 connectTimeout?:number;requestTimeout?:number;attempts?:number;retryPauseTime?:number;
 enableCache?:boolean;sendEtag?:boolean;sendIfModifiedSince?:boolean;
 basicAuthUser?:string;basicAuthPass?:string;signal?:AbortSignal;
 /** Trusted consumers may impose a smaller input budget. */
 maxBodyBytes?:number;redirect?:'follow'|'error';
}
export interface HttpDownloadOptions extends HttpRequestOptions {
 destinationPath?:string;downloadSize?:number;progress?:(percent:number,total:number,received:number)=>void;
}
class StatusError extends Error {readonly status:number;constructor(status:number,message:string){super(message);this.status=status;}}
interface Transfer {stream:IncomingMessage|Transform;response:IncomingMessage;headers:Headers;code:number;url:string;signal:AbortSignal;}
export class HttpResponse {
 readonly #body:Buffer;readonly #headers:Headers;#encoding='utf-8';
 readonly url:string;readonly finalUrl:string;readonly statusCode:number;readonly error:Error|null;
 constructor(url:string,finalUrl:string,statusCode:number,body:Uint8Array,headers:Headers,error:Error|null){this.url=url;this.finalUrl=finalUrl;this.statusCode=statusCode;this.error=error;this.#body=Buffer.from(body);this.#headers=new Headers(headers);}
 get headers(){return new Headers(this.#headers);}
 get content(){return Buffer.from(this.#body);}
 get byteLength(){return this.#body.length;}
 get etag(){return this.#headers.get('etag');}
 get lastModified(){return this.#headers.get('last-modified');}
 get encoding(){return this.#encoding;}
 set encoding(value:string){this.#encoding=value;}
 get text(){const encoding=this.#encoding.toLowerCase().replaceAll('_','-');if(['latin-1','latin1','iso-8859-1'].includes(encoding))return this.#body.toString('latin1');if(['ascii','us-ascii'].includes(encoding)){if(this.#body.some(byte=>byte>127))throw new TypeError('Invalid ASCII response');return this.#body.toString('ascii');}return new TextDecoder(this.#encoding,{fatal:true,ignoreBOM:true}).decode(this.#body);}
 json(options:ExactJsonOptions={}):ExactJson{return parseExactJson(new TextDecoder('utf-8',{fatal:true}).decode(this.#body),options);}
 isCachable(){return this.lastModified!==null||this.etag!==null;}
 hasError(){return this.error!==null;}
 raiseForStatus(message?:string){if(this.error)throw new ApiError(this.error instanceof StatusError?this.statusCode:500,message??(this.error instanceof StatusError?this.error.message:'HTTP Request Error'));}
}
const count=(value:number,min:number,max:number)=>{if(!Number.isSafeInteger(value)||value<min||value>max)throw new RangeError('Invalid HTTP capacity');return value;};
function timeout(value:number){if(!Number.isFinite(value)||value<=0||value>3600)throw new RangeError('Invalid HTTP timeout');return Math.max(1,Math.ceil(value*1000));}
function address(source:string){const url=new URL(source);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new TypeError('Invalid HTTP URL');return url;}
function responseHeaders(response:IncomingMessage){const headers=new Headers();for(let i=0;i<response.rawHeaders.length;i+=2)headers.append(response.rawHeaders[i],response.rawHeaders[i+1]);return headers;}
/** Process-owned HTTP component. No printer generation, subprocess, global
 * dispatcher or public URL/download endpoint. Shutdown aborts and drains work. */
export class MoonrakerHttpClient {
 readonly #http=new HttpAgent({keepAlive:true,maxSockets:16,maxFreeSockets:4});
 readonly #https=new HttpsAgent({keepAlive:true,maxSockets:16,maxFreeSockets:4});
 readonly #pending=new Map<AbortController,Promise<unknown>>();readonly #cache=new Map<string,HttpResponse>();
 #closed=false;#closing:Promise<void>|undefined;#cacheBytes=0;#downloadCleanupFailures=0;
 #githubLimit:number|null=null;#githubRemaining:number|null=null;#githubReset:number|null=null;
 get status(){return {closed:this.#closed,pending:this.#pending.size,cacheEntries:this.#cache.size,cacheBytes:this.#cacheBytes,downloadCleanupFailures:this.#downloadCleanupFailures};}
 #drop(key:string){const old=this.#cache.get(key);if(old)this.#cacheBytes-=old.byteLength;this.#cache.delete(key);}
 #store(key:string,value:HttpResponse){this.#drop(key);if(value.byteLength>MAX_BODY)return;while(this.#cache.size>=64||this.#cacheBytes+value.byteLength>MAX_BODY)this.#drop(this.#cache.keys().next().value!);this.#cache.set(key,value);this.#cacheBytes+=value.byteLength;}
 registerCachedUrl(url:string,etag?:string,lastModified?:string){address(url);if(this.#closed)throw new ApiError(503,'HTTP client closed');if(etag===undefined&&lastModified===undefined)throw new ApiError(500,'Either an Etag or Last Modified Date must be specified');const headers=new Headers();if(etag!==undefined)headers.set('etag',etag);if(lastModified!==undefined)headers.set('last-modified',lastModified);this.#store(url,new HttpResponse(url,url,200,Buffer.alloc(0),headers,null));}
 #admit<T>(signal:AbortSignal|undefined,run:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  if(this.#closed)return Promise.reject(new ApiError(503,'HTTP client closed'));if(this.#pending.size>=32)return Promise.reject(new ApiError(503,'HTTP request capacity exceeded'));
  const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const result=Promise.resolve().then(()=>{combined.throwIfAborted();return run(combined);}).finally(()=>this.#pending.delete(controller));this.#pending.set(controller,result);return result;
 }
 async #send(method:string,source:string,headers:Headers,body:Buffer|undefined,options:HttpRequestOptions,signal:AbortSignal){
  let url=address(source),currentMethod=method,currentBody=body;const requestMs=timeout(options.requestTimeout??10),connectMs=timeout(options.connectTimeout??5),life=AbortSignal.any([signal,AbortSignal.timeout(requestMs)]);
  for(let redirects=0;;redirects++){
   life.throwIfAborted();const response=await new Promise<IncomingMessage>((resolve,reject)=>{
    const fn=url.protocol==='https:'?httpsRequest:httpRequest,request=fn(url,{method:currentMethod,headers:Object.fromEntries(headers),agent:url.protocol==='https:'?this.#https:this.#http,signal:life},resolve);request.on('error',reject);
    request.once('socket',socket=>{if(!socket.connecting)return;const timer=setTimeout(()=>request.destroy(new Error('HTTP connection timeout')),connectMs);timer.unref();const connected=()=>clearTimeout(timer);socket.once(url.protocol==='https:'?'secureConnect':'connect',connected);request.once('close',()=>{connected();socket.removeListener('connect',connected);socket.removeListener('secureConnect',connected);});});
    request.end(currentBody);
   });
   const code=response.statusCode??500,location=response.headers.location;
   if([301,302,303,307,308].includes(code)&&location){
    response.destroy();if(options.redirect==='error'||redirects>=5)throw new Error('HTTP redirect rejected');const next=address(new URL(location,url).href);
    if(next.origin!==url.origin){headers.delete('authorization');headers.delete('cookie');}
    if(code===303&&currentMethod!=='HEAD'||[301,302].includes(code)&&currentMethod==='POST'){currentMethod='GET';currentBody=undefined;headers.delete('content-length');headers.delete('content-type');}
    url=next;continue;
   }
   const responseHeader=responseHeaders(response),encoding=response.headers['content-encoding'];
   const decoder=encoding==='gzip'?createGunzip():encoding==='deflate'?createInflate():encoding==='br'?createBrotliDecompress():undefined;
   if(decoder)response.on('error',error=>decoder.destroy(error));const stream=decoder?response.pipe(decoder):response;
   return {stream,response,headers:responseHeader,code,url:url.href,signal:life};
  }
 }
 async request(method:string,url:string,options:HttpRequestOptions={}):Promise<HttpResponse>{
  return this.#requestBody(method,url,options,false);
 }
 /** Read and limit the decoded stream without retaining a response body or
  * reading/mutating another consumer's conditional cache. */
 async probe(url:string,options:HttpRequestOptions={}):Promise<boolean>{
  const response=await this.#requestBody('GET',url,{...options,enableCache:false},true);return !response.hasError()&&response.statusCode>=200&&response.statusCode<300;
 }
 #requestBody(method:string,url:string,options:HttpRequestOptions,discardBody:boolean):Promise<HttpResponse>{
  return this.#admit(options.signal,async signal=>{
   address(url);method=method.toUpperCase();if(!/^[A-Z]+$/.test(method))throw new TypeError('Invalid HTTP method');const attempts=count(options.attempts??1,1,100),max=count(options.maxBodyBytes??MAX_BODY,1,MAX_BODY),retry=options.retryPauseTime??.1;if(!Number.isFinite(retry)||retry<0||retry>3600)throw new RangeError('Invalid HTTP retry pause');
   const key=url.split('?',1)[0],cached=options.enableCache?this.#cache.get(key):undefined,headers=new Headers(options.headers);if(!headers.has('user-agent'))headers.set('user-agent','Moonraker');if(!headers.has('accept-encoding'))headers.set('accept-encoding','gzip, deflate, br');
   let body:Buffer|undefined;if(options.body!==undefined&&options.body!==null){if(typeof options.body==='string'||options.body instanceof Uint8Array){if(typeof options.body==='string'&&!options.body.isWellFormed())throw new TypeError('Invalid HTTP body encoding');body=Buffer.from(options.body);}else{body=Buffer.from(stringifyExactJson(options.body));headers.set('content-type','application/json');}}
   if(body&&body.length>max)throw new ApiError(413,'HTTP request body exceeds capacity');
   // Upstream gates both conditionals under send_etag, and generated headers
   // take precedence over caller values. Keep this surprising frozen behavior.
   if(cached&&options.sendEtag!==false){if(cached.etag!==null)headers.set('if-none-match',cached.etag);if(cached.lastModified!==null&&options.sendIfModifiedSince!==false)headers.set('if-modified-since',cached.lastModified);}
   if(options.basicAuthUser!==undefined){if(options.basicAuthPass===undefined)throw new TypeError('HTTP basic auth requires a password');headers.set('authorization','Basic '+Buffer.from(options.basicAuthUser+':'+options.basicAuthPass).toString('base64'));}
   let error:Error|null=null,ret:HttpResponse|undefined;
   for(let attempt=0;attempt<attempts;attempt++){
    if(attempt)await pause(retry*1000,undefined,{signal});signal.throwIfAborted();let transfer:Transfer|undefined;
    try{
     transfer=await this.#send(method,url,new Headers(headers),body,options,signal);const advertised=transfer.headers.get('content-length');if(advertised!==null&&!transfer.headers.has('content-encoding')&&Number(advertised)>max)throw new ApiError(413,'HTTP response body exceeds capacity');let length=0;const chunks:Buffer[]=[];
     for await(const chunk of transfer.stream){transfer.signal.throwIfAborted();length+=chunk.length;if(length>max)throw new ApiError(413,'HTTP response body exceeds capacity');if(!discardBody)chunks.push(Buffer.from(chunk));}
     transfer.signal.throwIfAborted();error=transfer.code>=200&&transfer.code<300||transfer.code===304?null:new StatusError(transfer.code,'HTTP '+transfer.code);
     if(error&&attempt+1<attempts)continue;
     const content=discardBody?Buffer.alloc(0):transfer.code===304?(cached?.content??Buffer.alloc(0)):Buffer.concat(chunks,length);if(content.length>max)throw new ApiError(413,'Cached HTTP body exceeds capacity');
     ret=new HttpResponse(url,transfer.url,transfer.code,content,transfer.headers,error);break;
    }catch(cause){signal.throwIfAborted();error=cause instanceof Error?cause:new Error('HTTP request failed');}
    finally{transfer?.stream.destroy();transfer?.response.destroy();}
   }
   ret??=new HttpResponse(url,url,500,Buffer.alloc(0),new Headers(),error);if(!discardBody){if(options.enableCache&&ret.isCachable())this.#store(key,ret);else this.#drop(key);}return ret;
  });
 }
 get(url:string,options:HttpRequestOptions={}){return this.request('GET',url,{enableCache:true,...options});}
 post(url:string,body:HttpRequestOptions['body']='',options:HttpRequestOptions={}){return this.request('POST',url,{...options,body});}
 delete(url:string,options:HttpRequestOptions={}){return this.request('DELETE',url,options);}
 async githubApiRequest(resource:string,options:Pick<HttpRequestOptions,'attempts'|'retryPauseTime'|'signal'>={}){
  if(this.#githubRemaining===0&&this.#githubReset!==null&&Date.now()/1000<this.#githubReset)throw new ApiError(500,'GitHub Rate Limit Reached');
  const url='https://api.github.com/'+resource.replace(/^\/+|\/+$/g,''),response=await this.get(url,{...options,headers:{Accept:'application/vnd.github.v3+json'}}),headers=response.headers;
  if(headers.has('x-ratelimit-limit')){if(!headers.has('x-ratelimit-remaining')||!headers.has('x-ratelimit-reset'))throw new Error('Invalid GitHub rate headers');const limit=Number(headers.get('x-ratelimit-limit')),remaining=Number(headers.get('x-ratelimit-remaining')),reset=Number(headers.get('x-ratelimit-reset'));if(!Number.isSafeInteger(limit)||limit<0||!Number.isSafeInteger(remaining)||remaining<0||!Number.isFinite(reset))throw new Error('Invalid GitHub rate headers');this.#githubLimit=limit;this.#githubRemaining=remaining;this.#githubReset=reset;}
  return response;
 }
 githubApiStats(){return {github_rate_limit:this.#githubLimit,github_requests_remaining:this.#githubRemaining,github_limit_reset_time:this.#githubReset};}
 async getFile(url:string,contentType:string,options:HttpRequestOptions={}){const response=await this.get(url,{requestTimeout:180,enableCache:false,...options,headers:{...options.headers,Accept:contentType}});response.raiseForStatus();return response.content;}
 downloadFile(url:string,contentType:string,options:HttpDownloadOptions={}):Promise<string>{
  return this.#admit(options.signal,async signal=>{
   const attempts=count(options.attempts??1,1,100),max=count(options.maxBodyBytes??MAX_BODY,1,MAX_BODY),retry=options.retryPauseTime??1;timeout(options.requestTimeout??180);if(!Number.isFinite(retry)||retry<0||retry>3600)throw new RangeError('Invalid HTTP retry pause');
   if(options.destinationPath!==undefined&&(!isAbsolute(options.destinationPath)||options.destinationPath.includes('\0')))throw new TypeError('Download destination must be absolute');
   const headers=new Headers({...options.headers,Accept:contentType,'User-Agent':'Moonraker'});if(options.basicAuthUser!==undefined){if(options.basicAuthPass===undefined)throw new TypeError('HTTP basic auth requires a password');headers.set('authorization','Basic '+Buffer.from(options.basicAuthUser+':'+options.basicAuthPass).toString('base64'));}
   if(options.downloadSize!==undefined&&(!Number.isSafeInteger(options.downloadSize)||options.downloadSize< -1))throw new RangeError('Invalid download length');
   let last:unknown;
   for(let attempt=0;attempt<attempts;attempt++){
    if(attempt)await pause(retry*1000,undefined,{signal});signal.throwIfAborted();let transfer:Transfer|undefined,handle:Awaited<ReturnType<typeof open>>|undefined,directory:string|undefined,success=false;
    try{
     transfer=await this.#send('GET',url,new Headers(headers),undefined,{requestTimeout:180,...options},signal);if(transfer.code<200||transfer.code>=300)throw new StatusError(transfer.code,'HTTP '+transfer.code);
     let path=options.destinationPath;if(path===undefined){directory=await mkdtemp(join(tmpdir(),'moonraker-download-'));let name='download.mrd';const disposition=transfer.headers.get('content-disposition');if(disposition){const extended=/filename\*=utf-8''([^;\r\n]*)/i.exec(disposition),plain=/filename=(?:"([^"\r\n]*)"|([^;\r\n]*))/i.exec(disposition);if(extended)name=decodeURIComponent(extended[1]);else if(plain)name=(plain[1]??plain[2]).trim();}if(!name||name==='.'||name==='..'||name!==basename(name)||/[\\/\0]/.test(name))throw new Error('Invalid download filename');path=join(directory,name);}
     else{try{if(!(await lstat(path)).isFile())throw new Error('Invalid download destination');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}directory=await mkdtemp(join(dirname(path),'.moonraker-download-'));}
     const staged=options.destinationPath===undefined?path:join(directory!,'body');
     handle=await open(staged,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);if(!(await handle.stat()).isFile())throw new Error('Invalid download destination');
     const header=transfer.headers.get('content-length');let total=options.downloadSize??-1;if(header!==null){if(!/^\d+$/.test(header)||!Number.isSafeInteger(Number(header)))throw new Error('Invalid download length');total=Number(header);}let received=0,previous=0;
     for await(const chunk of transfer.stream){transfer.signal.throwIfAborted();const bytes=Buffer.from(chunk);received+=bytes.length;if(received>max)throw new ApiError(413,'HTTP download exceeds capacity');let offset=0;while(offset<bytes.length){const {bytesWritten}=await handle.write(bytes,offset,bytes.length-offset,null);if(!bytesWritten)throw new Error('Download write made no progress');offset+=bytesWritten;}
      if(total>0&&options.progress){const percent=Math.min(100,Math.floor(received/total*100+.5));if(percent!==previous){previous=percent;options.progress(percent,total,received);}}
     }
     transfer.signal.throwIfAborted();await handle.sync();await handle.close();handle=undefined;transfer.signal.throwIfAborted();if(options.destinationPath!==undefined){await rename(staged,path);success=true;const cleanup=directory!;directory=undefined;try{await rm(cleanup,{recursive:true,force:true});}catch{this.#downloadCleanupFailures=Math.min(Number.MAX_SAFE_INTEGER,this.#downloadCleanupFailures+1);}}success=true;return path;
    }catch(error){signal.throwIfAborted();last=error;}finally{transfer?.stream.destroy();transfer?.response.destroy();await handle?.close();if(directory&&!success)await rm(directory,{recursive:true,force:true});}
   }
   throw last instanceof Error?last:new Error('HTTP download retries exceeded');
  });
 }
 wrapRequest(url:string,options:HttpRequestOptions&{method?:string}={}){return new HttpRequestWrapper(this,url,options);}
 close():Promise<void>{if(this.#closing)return this.#closing;this.#closed=true;for(const controller of this.#pending.keys())controller.abort(new Error('HTTP client closed'));this.#http.destroy();this.#https.destroy();this.#cache.clear();this.#cacheBytes=0;return this.#closing=Promise.allSettled(this.#pending.values()).then(()=>{});}
}
export class HttpRequestWrapper {
 #defaults:HttpRequestOptions&{method:string;url:string};#args:HttpRequestOptions&{method:string;url:string};#last:HttpResponse|null=null;
 readonly client:MoonrakerHttpClient;
 constructor(client:MoonrakerHttpClient,url:string,options:HttpRequestOptions&{method?:string}={}){this.client=client;this.#defaults={method:'GET',url,...options};this.#args=this.#copy(this.#defaults);}
 #copy(value:HttpRequestOptions&{method:string;url:string}){const {signal,...rest}=value;return {...structuredClone(rest),...signal?{signal}:{}};}
 async send(options:HttpRequestOptions&{method?:string;url?:string}={}){const {method,url,...rest}={...this.#copy(this.#args),...options};return this.#last=await this.client.request(method,url,rest);}
 setMethod(method:string){this.#args.method=method;}setUrl(url:string){this.#args.url=url;}setBody(body:HttpRequestOptions['body']){this.#args.body=body;}addHeader(name:string,value:string){this.#args.headers??={};this.#args.headers[name]=value;}setHeaders(headers:Record<string,string>){this.#args.headers={...headers};}reset(){this.#args=this.#copy(this.#defaults);}lastResponse(){return this.#last;}
}
