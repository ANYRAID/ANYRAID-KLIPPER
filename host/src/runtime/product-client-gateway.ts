import {createServer,request as httpRequest,type IncomingMessage,type ServerResponse,type Server,type IncomingHttpHeaders} from 'node:http';
import {randomBytes} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import type {Duplex} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {WebSocket,WebSocketServer,type RawData} from 'ws';

export interface ProductClientGatewayOptions {
 /** Explicit canonical external origin; forwarded identity headers are ignored. */
 origin:string;
 /** Fixed private native Moonraker listener, never supplied by a client. */
 upstream:string;
 /** Plain HTTP cookies are permitted only for explicit local development. */
 loopbackHttp?:boolean;
 maxSessions?:number;maxConnections?:number;maxRequests?:number;
 /** Trusted frontend hosting only; API/auth routes never reach this callback. */
 client?(request:IncomingMessage,response:ServerResponse,signal:AbortSignal,authenticated:boolean):Promise<void>;
}
interface Session {id:string;username:string;access:string;refresh:string;accessExpires:number;expires:number;refreshing?:Promise<string>;sockets:Set<WebSocket>;}
class GatewayError extends Error {readonly code:number;constructor(code:number){super('Client gateway request rejected');this.code=code;}}
const hop=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
const apiPath=(p:string)=>/^\/(?:server|printer|machine|access)\//u.test(p);
function bounded(n:number|undefined,fallback:number,max:number){n??=fallback;if(!Number.isInteger(n)||n<1||n>max)throw new TypeError('Invalid client gateway capacity');return n;}
function headers(input:IncomingHttpHeaders){const omit=new Set([...hop,...String(input.connection??'').toLowerCase().split(',').map(s=>s.trim())]);return Object.fromEntries(Object.entries(input).filter(([k,v])=>v!==undefined&&!omit.has(k))) as IncomingHttpHeaders;}
function expires(token:unknown){if(typeof token!=='string'||token.length>8192||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token))throw new GatewayError(502);const p=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());if(!Number.isSafeInteger(p.exp)||p.exp<=Date.now()/1000)throw new GatewayError(502);return p.exp*1000;}
/** Credential transport for unchanged browser clients. Native Moonraker remains
 * the sole account, authorization, subscription and operation owner. Opaque
 * session handles never carry shared/admin identity, and mutations are never
 * retried. Shutdown invalidates handles without logging out unrelated clients. */
export class ProductClientGateway {
 #options:ProductClientGatewayOptions;#origin:URL;#upstream:URL;#cookie:string;#secure:boolean;
 #server:Server;#websockets:WebSocketServer;#sessions=new Map<string,Session>();#connections=new Set<Duplex>();#relays=new Set<WebSocket>();
 #lifetime=new AbortController();#active=0;#upgrades=0;#buffered=0;#tasks=new Set<Promise<void>>();#maxSessions:number;#maxConnections:number;#maxRequests:number;
 #opening:Promise<void>|undefined;
 #alive=new WeakMap<WebSocket,boolean>();
 #listening=false;#closed=false;#closing:Promise<void>|undefined;#sweep:ReturnType<typeof setInterval>|undefined;
 constructor(options:ProductClientGatewayOptions){
  const origin=new URL(options.origin),upstream=new URL(options.upstream),local=(u:URL)=>['127.0.0.1','[::1]'].includes(u.hostname);
  if(origin.origin!==options.origin||origin.username||origin.password||!['http:','https:'].includes(origin.protocol)||origin.protocol==='http:'&&(!options.loopbackHttp||!local(origin))||upstream.origin!==options.upstream||upstream.protocol!=='http:'||!local(upstream)||upstream.username||upstream.password||options.client!==undefined&&typeof options.client!=='function')throw new TypeError('Invalid explicit client gateway origins');
  this.#options={...options};this.#origin=origin;this.#upstream=upstream;this.#secure=origin.protocol==='https:';this.#cookie=this.#secure?'__Host-anyraid-client':'anyraid-client-loopback';
  this.#maxSessions=bounded(options.maxSessions,128,1024);this.#maxConnections=bounded(options.maxConnections,50,1000);this.#maxRequests=bounded(options.maxRequests,256,10000);
  this.#server=createServer({maxHeaderSize:16384,requestTimeout:30000,headersTimeout:10000},(q,r)=>this.#launch(this.#http(q,r)));this.#server.maxConnections=this.#maxConnections+this.#maxRequests;
  this.#server.on('connection',s=>{this.#connections.add(s);s.once('close',()=>this.#connections.delete(s));});
  this.#server.on('clientError',(_e,s)=>{if(s.writable)s.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');});
  this.#websockets=new WebSocketServer({noServer:true,maxPayload:1024*1024,perMessageDeflate:false});
  this.#server.on('upgrade',(q,s,h)=>this.#launch(this.#upgrade(q,s,h)));
 }
 get status(){return {listening:this.#listening,closed:this.#closed,sessions:this.#sessions.size,requests:this.#active,upgrades:this.#upgrades,websockets:this.#relays.size,bufferedBytes:this.#buffered};}
 #launch(task:Promise<void>){const observed=task.catch(()=>{}).finally(()=>this.#tasks.delete(observed));this.#tasks.add(observed);}
 async listen(port:number,host='127.0.0.1'):Promise<AddressInfo>{
  if(this.#opening||this.#listening||this.#closed||!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid client gateway listen state');
  await (this.#opening=new Promise<void>((resolve,reject)=>{const fail=(e:Error)=>{this.#server.off('listening',ready);reject(e);},ready=()=>{this.#server.off('error',fail);resolve();};this.#server.once('error',fail);this.#server.once('listening',ready);this.#server.listen(port,host);}));if(this.#closed)throw new Error('Client gateway startup cancelled');this.#listening=true;
  this.#sweep=setInterval(()=>{for(const s of this.#sessions.values())if(s.expires<=Date.now())this.#drop(s);for(const ws of this.#relays){if(ws.readyState!==WebSocket.OPEN)continue;if(this.#alive.get(ws)===false){ws.terminate();continue;}this.#alive.set(ws,false);ws.ping();}},10000);this.#sweep.unref();return this.#server.address() as AddressInfo;
 }
 #admit(request:IncomingMessage,unsafe=false){if(!this.#listening||this.#closed)throw new GatewayError(503);if(request.headers.host!==this.#origin.host)throw new GatewayError(403);if((unsafe||request.headers.origin!==undefined)&&request.headers.origin!==this.#origin.origin)throw new GatewayError(403);}
 #session(request:IncomingMessage){
  const values=(request.headers.cookie??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(this.#cookie+'='));if(values.length!==1)throw new GatewayError(401);
  const id=values[0].slice(this.#cookie.length+1);if(!/^[A-Za-z0-9_-]{43}$/u.test(id))throw new GatewayError(401);const s=this.#sessions.get(id);if(!s)throw new GatewayError(401);if(s.expires<=Date.now()){this.#drop(s);throw new GatewayError(401);}return s;
 }
 #drop(session:Session){this.#sessions.delete(session.id);for(const s of session.sockets)s.terminate();session.sockets.clear();session.access=session.refresh='';}
 #setCookie(response:ServerResponse,id='',age=0){response.setHeader('set-cookie',`${this.#cookie}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${this.#secure?'; Secure':''}`);}
 #reply(response:ServerResponse,code:number,body:unknown){if(response.destroyed||response.writableEnded)return;if(response.headersSent){response.destroy();return;}response.writeHead(code,{'content-type':'application/json; charset=UTF-8','cache-control':'no-store','x-content-type-options':'nosniff'});response.end(JSON.stringify(body));}
 #failure(response:ServerResponse,error:unknown){this.#reply(response,error instanceof GatewayError?error.code:502,{error:{message:'Client request rejected'}});}
 async #json(request:IncomingMessage){const chunks:Buffer[]=[];let size=0;if(request.headers['content-type']?.split(';')[0]!=='application/json')throw new GatewayError(415);for await(const b of request){size+=b.length;if(size>4096)throw new GatewayError(413);chunks.push(b);}try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw new GatewayError(400);}}
 async #native(path:string,method:string,body?:object,token?:string):Promise<Record<string,unknown>>{
  const result=await fetch(this.#upstream.origin+path,{method,redirect:'error',signal:AbortSignal.any([this.#lifetime.signal,AbortSignal.timeout(10000)]),headers:{'content-type':'application/json',...token?{authorization:'Bearer '+token}:{}},body:body?JSON.stringify(body):undefined});
  const chunks:Uint8Array[]=[];let size=0;try{for await(const b of result.body??[]){size+=b.length;if(size>65536)throw new GatewayError(502);chunks.push(b);}}finally{if(!result.body?.locked)await result.body?.cancel().catch(()=>{});}
  if(result.status!==200)throw new GatewayError(result.status===400||result.status===401?401:503);const parsed=JSON.parse(Buffer.concat(chunks).toString());if(!parsed.result||typeof parsed.result!=='object'||Array.isArray(parsed.result))throw new GatewayError(502);return parsed.result;
 }
 async #token(session:Session){
  if(session.expires<=Date.now()||this.#sessions.get(session.id)!==session)throw new GatewayError(401);
  if(session.accessExpires-Date.now()>60000)return session.access;
  session.refreshing??=this.#native('/access/refresh_jwt','POST',{refresh_token:session.refresh}).then(result=>{if(result.username!==session.username||this.#sessions.get(session.id)!==session)throw new GatewayError(401);const expiry=expires(result.token);session.access=result.token as string;session.accessExpires=expiry;return session.access;}).catch(e=>{this.#drop(session);throw e;}).finally(()=>{session.refreshing=undefined;});return session.refreshing;
 }
 async #identity(session:Session,token:string){try{const user=await this.#native('/access/user','GET',undefined,token);if(user.username!==session.username)throw new GatewayError(401);}catch(e){if(e instanceof GatewayError&&e.code===401)this.#drop(session);throw e;}}
 async #http(request:IncomingMessage,response:ServerResponse){
  let admitted=false;const abort=new AbortController(),disconnect=()=>abort.abort(new Error('Client disconnected'));response.once('close',disconnect);
  try{
   this.#admit(request,!['GET','HEAD'].includes(request.method??''));if(this.#active>=this.#maxRequests)throw new GatewayError(429);this.#active++;admitted=true;
   const path=request.url?.split('?')[0];if(!path||!request.url?.startsWith('/')||request.url.startsWith('//'))throw new GatewayError(400);
   if(path==='/_client/session'){
    if(request.url!==path)throw new GatewayError(400);
    if(request.method==='POST'){
     let previous:Session|undefined;try{previous=this.#session(request);}catch(e){if(!(e instanceof GatewayError)||e.code!==401)throw e;}
     if(this.#sessions.size>=this.#maxSessions&&!previous)throw new GatewayError(429);
     const input=await this.#json(request);if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.username!=='string'||typeof input.password!=='string'||Object.keys(input).some(k=>k!=='username'&&k!=='password'))throw new GatewayError(400);
     const login=await this.#native('/access/login','POST',input);const expiry=expires(login.token),refreshExpiry=expires(login.refresh_token);
     abort.signal.throwIfAborted();this.#lifetime.signal.throwIfAborted();if(this.#sessions.size>=this.#maxSessions&&(!previous||this.#sessions.get(previous.id)!==previous))throw new GatewayError(429);if(login.username!==input.username)throw new GatewayError(502);
     if(previous)this.#drop(previous);
     const id=randomBytes(32).toString('base64url'),session:Session={id,username:input.username,access:login.token as string,refresh:login.refresh_token as string,accessExpires:expiry,expires:Math.min(refreshExpiry,Date.now()+86400000),sockets:new Set()};this.#sessions.set(id,session);
     this.#setCookie(response,id,Math.floor((session.expires-Date.now())/1000));this.#reply(response,200,{result:{username:session.username}});return;
    }
    const session=this.#session(request),token=await this.#token(session);
    if(request.method==='GET'){await this.#identity(session,token);this.#reply(response,200,{result:{username:session.username,expires:session.expires}});return;}
    if(request.method==='DELETE'){
     try{await this.#native('/access/logout','POST',{},token);}finally{this.#drop(session);this.#setCookie(response);}
     this.#reply(response,200,{result:{logged_out:true}});return;
    }
    throw new GatewayError(405);
   }
   if(path==='/_client/login'&&request.method==='GET'&&request.url===path&&this.#options.client){await this.#options.client(request,response,AbortSignal.any([abort.signal,this.#lifetime.signal]),false);return;}
   const session=this.#session(request),token=await this.#token(session);
   if(apiPath(path)){await this.#proxy(request,response,token,AbortSignal.any([abort.signal,this.#lifetime.signal]));return;}
   // Frontend assets require a currently valid native identity, not just a
   // cache entry whose JWT may have been revoked by another native client.
   await this.#identity(session,token);
   if(!this.#options.client)throw new GatewayError(404);await this.#options.client(request,response,AbortSignal.any([abort.signal,this.#lifetime.signal]),true);
  }catch(error){if(!request.complete&&!response.headersSent)response.setHeader('connection','close');if(error instanceof GatewayError&&error.code===401&&request.method==='GET'&&!apiPath(request.url?.split('?')[0]??'')&&(!request.url?.startsWith('/_client/')||['/_client/control','/_client/queue'].includes(request.url??''))&&request.headers.accept?.includes('text/html')&&!response.headersSent){response.writeHead(303,{location:'/_client/login','cache-control':'no-store'});response.end();}else this.#failure(response,error);}finally{response.off('close',disconnect);if(admitted)this.#active--;if(!request.complete)request.resume();}
 }
 async #proxy(request:IncomingMessage,response:ServerResponse,token:string,signal:AbortSignal){
  const forwarded=headers(request.headers);for(const h of ['cookie','authorization','x-api-key','x-access-token','forwarded','x-forwarded-for','x-real-ip'])delete forwarded[h];forwarded.authorization='Bearer '+token;forwarded.host=this.#upstream.host;if(forwarded.origin!==undefined)forwarded.origin=this.#upstream.origin;
  await new Promise<void>((resolve,reject)=>{
   const upstream=httpRequest(new URL(request.url!,this.#upstream),{method:request.method,headers:forwarded,signal},incoming=>{
    const reply=headers(incoming.headers);delete reply['set-cookie'];response.writeHead(incoming.statusCode??502,reply);void pipeline(incoming,response,{signal}).then(resolve,reject);
   });upstream.setTimeout(300000,()=>upstream.destroy(new Error('Client proxy timed out')));upstream.once('error',reject);void pipeline(request,upstream,{signal}).catch(reject);
  });
 }
 async #upgrade(request:IncomingMessage,socket:Duplex,head:Buffer){
  let upstream:WebSocket|undefined,admitted=false;const abort=()=>upstream?.terminate();
  try{
   this.#admit(request,true);if(request.url!=='/websocket')throw new GatewayError(404);if(this.#relays.size+this.#upgrades>=this.#maxConnections)throw new GatewayError(503);this.#upgrades++;admitted=true;const session=this.#session(request),token=await this.#token(session);
   await this.#identity(session,token);if(socket.destroyed||this.#closed)throw new GatewayError(503);
   upstream=new WebSocket(this.#upstream.origin.replace('http:','ws:')+'/websocket',{headers:{authorization:'Bearer '+token,origin:this.#upstream.origin},maxPayload:1024*1024,perMessageDeflate:false,handshakeTimeout:10000});
   this.#lifetime.signal.addEventListener('abort',abort,{once:true});if(this.#lifetime.signal.aborted)abort();
   const remote=upstream;await new Promise<void>((resolve,reject)=>{remote.once('open',resolve);remote.once('error',reject);socket.once('close',()=>{remote.terminate();reject(new Error('Client disconnected'));});});
   if(this.#closed||this.#sessions.get(session.id)!==session||this.#relays.size>=this.#maxConnections)throw new GatewayError(503);
   this.#websockets.handleUpgrade(request,socket,head,local=>{
    this.#relays.add(local);session.sockets.add(local);this.#alive.set(local,true);local.on('pong',()=>this.#alive.set(local,true));let retired=false;
    const retire=()=>{if(retired)return;retired=true;this.#relays.delete(local);session.sockets.delete(local);local.terminate();remote.terminate();};local.once('error',retire);remote.once('error',retire);local.once('close',retire);remote.once('close',retire);
    const relay=(target:WebSocket,data:RawData,binary:boolean)=>{const length=Array.isArray(data)?data.reduce((n,b)=>n+b.length,0):data.byteLength;if(target.readyState!==WebSocket.OPEN||this.#buffered+length>8*1024*1024){retire();return;}this.#buffered+=length;try{target.send(data,{binary},()=>{this.#buffered-=length;});}catch{this.#buffered-=length;retire();}};
    local.on('message',(data,binary)=>relay(remote,data,binary));remote.on('message',(data,binary)=>relay(local,data,binary));
   });
  }catch(error){upstream?.terminate();if(socket.writable)socket.end(`HTTP/1.1 ${error instanceof GatewayError?error.code:502} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);}finally{this.#lifetime.signal.removeEventListener('abort',abort);if(admitted)this.#upgrades--;}
 }
 close():Promise<void>{return this.#closing??=this.#close();}
 async #close(){this.#closed=true;this.#listening=false;if(this.#sweep)clearInterval(this.#sweep);this.#lifetime.abort(new Error('Client gateway closed'));for(const s of this.#sessions.values())this.#drop(s);for(const s of this.#connections)s.destroy();await this.#opening?.catch(()=>{});await new Promise<void>((resolve,reject)=>this.#server.close(e=>{if(e&&(e as NodeJS.ErrnoException).code!=='ERR_SERVER_NOT_RUNNING')reject(e);else resolve();}));await Promise.all(this.#tasks);await new Promise<void>(resolve=>this.#websockets.close(()=>resolve()));}
}
