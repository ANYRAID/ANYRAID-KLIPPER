import type {ThumbnailDownloads} from './thumbnail-download.ts';
import type {NativePrintUploads} from './native-print-uploads.ts';
import {discardRejectedUploadBody} from './rejected-upload-body.ts';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {setImmediate as yieldImmediate} from 'node:timers/promises';
import {ClientCalls} from './client-calls.ts';
import {ClientRequests,type ClientArguments,type ClientRequestLimits,type ClientRequestOptions} from './client-requests.ts';
import {ResponseCompletion} from './response-completion.ts';
import {subscriptionConnectionId} from './subscription-connection.ts';
import {NotificationFanout,type NotificationLimits,type DeliveryReport} from './notifications.ts';
import {RemoteClients} from './clients.ts';
import {EndpointRegistry} from './endpoints.ts';
import {createServer,type IncomingMessage,type ServerResponse,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import type {Duplex} from 'node:stream';
import {WebSocketServer,WebSocket,type RawData} from 'ws';
import {JsonRpcDispatcher,ApiError,encodeNotification,type Json,type RpcContext,type AuthorizationResult} from './rpc.ts';
export interface NetworkAuthorization {
 request:IncomingMessage;transport:'http'|'websocket';connectionId?:number;signal:AbortSignal;
}
export interface MoonrakerNetworkOptions {
 endpoints?:EndpointRegistry;
 thumbnails?:ThumbnailDownloads;
 /** Native multipart HTTP admission; lifetime belongs to the composition owner. */
 nativeUploads?:NativePrintUploads;
 authorize(method:string,params:Readonly<Record<string,Json>>,request:NetworkAuthorization):AuthorizationResult|Promise<AuthorizationResult>;
 /** Required to enable broadcasts; separate from inbound method authorization. */
 authorizeNotification?(method:string,params:readonly Json[],request:NetworkAuthorization):void|Promise<void>;
 /** Required to associate an HTTP subscription with a different transport.
  * Check authenticated ownership/permissions of source and target explicitly. */
 authorizeSubscriptionConnection?(source:NetworkAuthorization,target:NetworkAuthorization):void|Promise<void>;
 notificationLimits?:NotificationLimits;
 /** Required for reply-free agent callbacks; independent of inbound and request authorization. */
 authorizeClientCall?(method:string,params:ClientArguments,request:NetworkAuthorization):void|Promise<void>;
 clientCallLimits?:NotificationLimits;
 /** Required for server-initiated requests to clients/agents. */
 authorizeClientRequest?(method:string,params:ClientArguments,request:NetworkAuthorization):void|Promise<void>;
 clientRequestLimits?:ClientRequestLimits;
 /** Additional allowed browser origins. Same-origin and clients without Origin
  * are accepted; method authorization is always required independently. */
 origins?:readonly string[];maxConnections?:number;maxRequests?:number;maxRequestsPerSocket?:number;
 requestTimeoutMs?:number;shutdownTimeoutMs?:number;maxBufferedBytes?:number;maxOutputBytes?:number;
}
interface Peer{socket:WebSocket;request:IncomingMessage;abort:AbortController;active:number;alive:boolean;}
const maxBytes=1024*1024;
function bounded(value:number|undefined,fallback:number,max:number):number{const n=value??fallback;if(!Number.isInteger(n)||n<1||n>max)throw new RangeError('Invalid network capacity or timeout');return n;}
function bytes(data:RawData):Buffer{return Buffer.isBuffer(data)?data:Array.isArray(data)?Buffer.concat(data):Buffer.from(data);}
/** Moonraker JSON-RPC network transport. Business APIs and authorization storage
 * remain separate components; the required authorize callback never defaults to allow. */
export class MoonrakerNetwork {
 #clientCalls:ClientCalls|undefined;#clients=new RemoteClients();#notifications:NotificationFanout|undefined;#clientRequests:ClientRequests|undefined;
 #rpc:JsonRpcDispatcher;#options:MoonrakerNetworkOptions;#server:Server;#ws:WebSocketServer;
 #peers=new Map<number,Peer>();#nextId=1;#requests=new Map<AbortController,Promise<void>>();#sockets=new Set<Duplex>();
 #outputBytes=0;#maximumOutputBytes:number;
 #buffered=0;#maxBuffered:number;#maxConnections:number;#maxRequests:number;#perSocket:number;#timeout:number;#shutdownTimeout:number;#origins:Set<string>;
 #opening:Promise<void>|undefined;#heartbeat:ReturnType<typeof setInterval>|undefined;#phase:'new'|'starting'|'listening'|'closing'|'closed'='new';#close:Promise<void>|undefined;
 constructor(rpc:JsonRpcDispatcher,options:MoonrakerNetworkOptions){
  if(rpc.has('server.websocket.id')||rpc.has('server.connection.identify'))throw new Error('Network RPC method already registered');
  if(typeof options.authorize!=='function')throw new TypeError('Network authorization is required');if(options.endpoints&&options.endpoints.dispatcher!==rpc)throw new Error('Endpoint registry must share the network dispatcher');this.#rpc=rpc;this.#options={...options};
  this.#maximumOutputBytes=bounded(options.maxOutputBytes,8*maxBytes,64*maxBytes);
  this.#maxBuffered=bounded(options.maxBufferedBytes,8*maxBytes,64*maxBytes);this.#maxConnections=bounded(options.maxConnections,50,10000);this.#maxRequests=bounded(options.maxRequests,256,10000);this.#perSocket=bounded(options.maxRequestsPerSocket,32,1000);this.#timeout=bounded(options.requestTimeoutMs,300000,2147483647);this.#shutdownTimeout=bounded(options.shutdownTimeoutMs,5000,60000);
  this.#origins=new Set((options.origins??[]).map(origin=>{const url=new URL(origin);if(!['http:','https:'].includes(url.protocol)||url.origin!==origin)throw new Error('Invalid allowed origin');return origin;}));
  if(options.authorizeNotification!==undefined&&typeof options.authorizeNotification!=='function')throw new TypeError('Invalid notification authorization');
  if(options.authorizeSubscriptionConnection!==undefined&&typeof options.authorizeSubscriptionConnection!=='function')throw new TypeError('Invalid subscription connection authorization');
  if(options.authorizeNotification)this.#notifications=new NotificationFanout(options.notificationLimits);
  if(options.authorizeClientCall!==undefined&&typeof options.authorizeClientCall!=='function')throw new TypeError('Invalid client call authorization');
  if(options.authorizeClientCall)this.#clientCalls=new ClientCalls(options.clientCallLimits);
  if(options.authorizeClientRequest!==undefined&&typeof options.authorizeClientRequest!=='function')throw new TypeError('Invalid client request authorization');
  if(options.authorizeClientRequest)this.#clientRequests=new ClientRequests(options.clientRequestLimits);
  this.#server=createServer({maxHeaderSize:16384,requestTimeout:30000,headersTimeout:10000},(request,response)=>this.#http(request,response));this.#server.maxConnections=this.#maxConnections+this.#maxRequests;
  this.#ws=new WebSocketServer({noServer:true,maxPayload:maxBytes,perMessageDeflate:false});
  this.#server.on('connection',socket=>{this.#sockets.add(socket);socket.on('close',()=>this.#sockets.delete(socket));});
  this.#server.on('upgrade',(request,socket,head)=>{
   if(this.#phase!=='listening'||this.#peers.size>=this.#maxConnections){this.#rejectUpgrade(socket,503);return;}
   if(request.url?.split('?')[0]!=='/websocket'){this.#rejectUpgrade(socket,404);return;}
   if(!this.#origin(request)){this.#rejectUpgrade(socket,403);return;}
   this.#ws.handleUpgrade(request,socket,head,ws=>this.#connected(request,ws));
  });
  this.#server.on('clientError',(_error,socket)=>{if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');});
  rpc.register('server.websocket.id',['websocket'],(_p,context)=>({websocket_id:context.connectionId!}));
  rpc.register('server.connection.identify',['websocket'],(params,context)=>{const client=this.#clients.identify(context.connectionId!,params);if(client.identity?.type==='agent')this.#agentEvent(client.id,{agent:client.identity.name,event:'connected',data:{...client.identity}});return {connection_id:client.id};});
 }
 get clients(){return this.#clients.all();}
 getClient(id:number){return this.#clients.get(id);}
 getClientsByName(name:string){return this.#clients.byName(name);}
 getClientsByType(type:string){return this.#clients.byType(type);}
 getUnidentifiedClients(){return this.#clients.unidentified();}
 getAgents(){return this.#clients.agents();}
 getAgent(name:string){return this.#clients.agent(name);}
 get status(){return {phase:this.#phase,connections:this.#peers.size,requests:this.#requests.size,bufferedBytes:this.#buffered,outputBufferedBytes:this.#outputBytes,notifications:this.#notifications?.status??null,clientCalls:this.#clientCalls?.status??null,clientRequests:this.#clientRequests?.status??null};}
 async listen(port=0,host='127.0.0.1'):Promise<AddressInfo>{
  if(this.#phase!=='new'||!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid network listen state or port');
  this.#phase='starting';try{this.#opening=new Promise<void>((resolve,reject)=>{const fail=(e:Error)=>{this.#server.off('listening',ready);reject(e);},ready=()=>{this.#server.off('error',fail);resolve();};this.#server.once('error',fail);this.#server.once('listening',ready);this.#server.listen(port,host);});await this.#opening;if(this.#phase!=='starting')throw new Error('Network startup cancelled');this.#phase='listening';}
  catch(error){if(this.#phase==='starting')this.#phase='new';throw error;}
  this.#heartbeat=setInterval(()=>{for(const peer of this.#peers.values()){if(peer.socket.readyState!==WebSocket.OPEN)continue;if(!peer.alive){peer.socket.terminate();continue;}peer.alive=false;peer.socket.ping();}},10000);this.#heartbeat.unref();return this.#server.address() as AddressInfo;
 }
 #origin(request:IncomingMessage):boolean{
  const origin=request.headers.origin;if(origin===undefined)return true;
  try{const url=new URL(origin);return this.#origins.has(origin)||['http:','https:'].includes(url.protocol)&&url.origin===origin&&url.host.toLowerCase()===request.headers.host?.toLowerCase();}catch{return false;}
 }
 #error(response:ServerResponse,status:number,message:string):void{if(response.destroyed||response.writableEnded)return;if(response.headersSent){response.destroy();return;}response.writeHead(status,{'content-type':'application/json; charset=UTF-8'});response.end(JSON.stringify({error:{code:status,message}}));}
 #rejectUpgrade(socket:Duplex,status:number):void{socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);}
 #launch(run:(signal:AbortSignal)=>Promise<void>,parent?:AbortSignal):void{
  const abort=new AbortController(),cancel=()=>abort.abort(parent?.reason??new Error('Client disconnected'));parent?.addEventListener('abort',cancel,{once:true});if(parent?.aborted)cancel();
  const timeout=setTimeout(()=>abort.abort(new Error('RPC request timed out')),this.#timeout);
  // Publish the task before invoking handlers so reentrant shutdown sees it.
  const job=Promise.resolve().then(()=>run(abort.signal)).catch(()=>{}).finally(()=>{clearTimeout(timeout);parent?.removeEventListener('abort',cancel);this.#requests.delete(abort);});this.#requests.set(abort,job);
 }
 #context(request:IncomingMessage,transport:'http'|'websocket',signal:AbortSignal,id?:number):RpcContext{
  return {transport,signal,connectionId:id,authorize:(method,params)=>this.#options.authorize(method,params,{request,transport,connectionId:id,signal}),receiveResponse:transport==='websocket'&&id!==undefined?(responseId,value)=>{this.#clientRequests?.receive(id,responseId,value);}:undefined};
 }
 async #subscriptionConnection(request:IncomingMessage,body:Uint8Array,signal:AbortSignal):Promise<{id:number;signal:AbortSignal}>{
  if(!this.#options.authorizeSubscriptionConnection)throw new ApiError(503,'Subscription connection authorization is required');signal.throwIfAborted();
  const id=subscriptionConnectionId(request.url??'',body,request.headers['content-type']??''),peer=this.#peers.get(id);if(!peer||peer.abort.signal.aborted)throw new ApiError(404,'Subscription connection is no longer available');
  const combined=AbortSignal.any([signal,peer.abort.signal]);await this.#options.authorizeSubscriptionConnection({request,transport:'http',signal:combined},{request:peer.request,transport:'websocket',connectionId:id,signal:combined});combined.throwIfAborted();if(this.#peers.get(id)!==peer)throw new ApiError(404,'Subscription connection changed');return {id,signal:peer.abort.signal};
 }
 #http(request:IncomingMessage,response:ServerResponse):void{
  if(this.#phase!=='listening'){this.#error(response,503,'Server is shutting down');return;}
  const url=request.url??'',at=url.indexOf('?'),path=at<0?url:url.slice(0,at),query=at<0?'':url.slice(at+1),isRPC=path==='/server/jsonrpc',isUpload=!!this.#options.nativeUploads&&path==='/server/files/upload',isDownload=this.#options.nativeUploads?.matchesDownload(path)??false,isNativeThumbnail=!!this.#options.nativeUploads&&!isDownload&&path.startsWith('/server/files/gcodes/.thumbs/')&&(!this.#options.thumbnails||this.#options.nativeUploads.hasThumbnail(path)),isThumbnail=isNativeThumbnail||(this.#options.thumbnails?.matches(path)??false),allowed=isRPC||isUpload?['POST']:isDownload&&this.#options.nativeUploads!.canRemove?['GET','HEAD','DELETE']:isDownload||isThumbnail?['GET','HEAD']:this.#options.endpoints?.allowed(path);
  if(!allowed){this.#error(response,404,'Not Found');return;}
  if(!this.#origin(request)){this.#error(response,403,'Origin not allowed');return;}
  if(request.headers.origin&&this.#origins.has(request.headers.origin)){response.setHeader('access-control-allow-origin',request.headers.origin);response.setHeader('vary','Origin');response.setHeader('access-control-allow-credentials','true');response.setHeader('access-control-expose-headers','ETag, Content-Disposition, Content-Length, Content-Range, Accept-Ranges');}
  if(request.method==='OPTIONS'){response.writeHead(204,{'access-control-allow-methods':[...allowed,'OPTIONS'].join(', '),'access-control-allow-headers':'Content-Type, Authorization, X-Api-Key, If-None-Match, Range, If-Range'});response.end();return;}
  if(!allowed.some(v=>v===request.method)){this.#error(response,405,'Method Not Allowed');return;}
  if(isRPC&&!request.headers['content-type']?.trim().startsWith('application/json')){this.#error(response,400,'Invalid content type, application/json required');return;}
  if(this.#requests.size>=this.#maxRequests){this.#error(response,429,'Too many active requests');return;}
  const parent=new AbortController(),disconnected=()=>{if(!response.writableEnded)parent.abort(new Error('HTTP client disconnected'));};response.once('close',disconnected);
  this.#launch(async signal=>{
   let reserved=0,outputReserved=0,completion:ResponseCompletion|undefined;const cancel=()=>{this.#error(response,503,'Request cancelled');request.destroy();};signal.addEventListener('abort',cancel,{once:true});
   try{
    if(isUpload){
     signal.throwIfAborted();response.setHeader('connection','close');
     const budget=8*65536;if(this.#buffered+budget>this.#maxBuffered)throw new ApiError(429,'Request buffer capacity exceeded');
     this.#buffered+=budget;reserved=budget;
     const result=await this.#options.nativeUploads!.receive(request,this.#context(request,'http',signal));signal.throwIfAborted();
     response.setHeader('content-type','application/json; charset=UTF-8');response.end(JSON.stringify({result}));return;
    }
    signal.throwIfAborted();const chunks:Buffer[]=[];let length=0;
    for await(const chunk of request){signal.throwIfAborted();length+=chunk.length;if(length>maxBytes){this.#error(response,413,'Request too large');return;}if(this.#buffered+chunk.length>this.#maxBuffered){this.#error(response,429,'Request buffer capacity exceeded');return;}this.#buffered+=chunk.length;reserved+=chunk.length;chunks.push(chunk);}
    const body=Buffer.concat(chunks),context=this.#context(request,'http',signal);
    if(isDownload&&request.method==='DELETE'){
     if(query||body.length)throw new ApiError(400,'File deletion does not accept a query or body');
     const result=await this.#options.nativeUploads!.remove({path:decodeURIComponent(path.slice('/server/files/'.length))},context);signal.throwIfAborted();response.setHeader('content-type','application/json; charset=UTF-8');response.end(JSON.stringify({result}));return;
    }
    if(isDownload){
     // Source copy, generator and transport each hold bounded chunks. Kernel
     // snapshot content has an independent owner quota, not this JS buffer pool.
     const budget=3*65536;if(budget>this.#maximumOutputBytes-this.#outputBytes)throw new ApiError(429,'Response buffer capacity exceeded');this.#outputBytes+=budget;outputReserved=budget;
     await this.#options.nativeUploads!.download(path,context,async(file,downloadSignal)=>{
      const etag='"'+file.sha256+'"';response.setHeader('content-type','application/octet-stream');response.setHeader('cache-control','private, no-cache');response.setHeader('x-content-type-options','nosniff');response.setHeader('etag',etag);response.setHeader('accept-ranges','bytes');
      const encoded=encodeURIComponent(file.record.name).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
      response.setHeader('content-disposition',`attachment; filename="${file.record.id}.gcode"; filename*=UTF-8''${encoded}`);
      const condition=request.headers['if-none-match'];if(condition?.split(',').some(value=>value.trim()==='*'||value.trim().replace(/^W\//,'')===etag)){response.writeHead(304);response.end();return;}
      let start=0,end=file.size;
      if(request.method==='GET'&&request.headers.range&&(!request.headers['if-range']||request.headers['if-range']===etag)){
       const range=/^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
       if(range&&(range[1]||range[2])){
        const first=range[1]?Number(range[1]):undefined,last=range[2]?Number(range[2]):undefined;
        if(first===undefined){start=Math.max(0,file.size-(last??0));}else{start=first;if(last!==undefined)end=Math.min(file.size,last+1);}
        if(first!==undefined&&!Number.isSafeInteger(first)||last!==undefined&&!Number.isSafeInteger(last)||start>=file.size||end<=start){response.setHeader('content-range','bytes */'+file.size);response.writeHead(416);response.end();return;}
        response.statusCode=206;response.setHeader('content-range',`bytes ${start}-${end-1}/${file.size}`);
       }
      }
      response.setHeader('content-length',end-start);if(request.method==='HEAD'){response.end();return;}
      await pipeline(Readable.from(file.reader.chunks(downloadSignal,start,end),{objectMode:false,highWaterMark:65536}),response,{signal:downloadSignal});
     });return;
    }
    if(isThumbnail){
     const download=isNativeThumbnail?await this.#options.nativeUploads!.resolveThumbnail(path,context):await this.#options.thumbnails!.resolve(path,context);signal.throwIfAborted();
     if(!Number.isSafeInteger(download.size)||download.size<1||download.size>8*maxBytes)throw new ApiError(500,'Invalid thumbnail size');
     response.setHeader('content-type',download.contentType);response.setHeader('cache-control','private, no-cache');response.setHeader('x-content-type-options','nosniff');
     if(request.method==='HEAD'&&!request.headers['if-none-match']){response.setHeader('content-length',download.size);response.end();return;}
     if(download.size>this.#maximumOutputBytes-this.#outputBytes)throw new ApiError(429,'Response buffer capacity exceeded');
     this.#outputBytes+=download.size;outputReserved=download.size;
     const image=await download.read();signal.throwIfAborted();if(image.bytes.length!==download.size)throw new ApiError(500,'Thumbnail size changed');
     const etag='"'+image.sha256+'"';response.setHeader('etag',etag);
     const condition=request.headers['if-none-match'];if(condition?.split(',').some(value=>value.trim()==='*'||value.trim().replace(/^W\//,'')===etag)){response.writeHead(304);response.end();return;}
     response.setHeader('content-length',image.bytes.length);
     if(request.method==='HEAD'){response.end();return;}
     async function* chunks(){for(let offset=0;offset<image.bytes.length;offset+=65536){signal.throwIfAborted();yield image.bytes.subarray(offset,offset+65536);await yieldImmediate(undefined,{signal});}}
     await pipeline(Readable.from(chunks(),{objectMode:false,highWaterMark:65536}),response,{signal});return;
    }
    context.afterResponse=callback=>{(completion??=new ResponseCompletion(signal)).add(callback);};
    context.subscriptionConnection=()=>this.#subscriptionConnection(request,body,signal);
    const result=isRPC?await this.#rpc.dispatch(body,context):JSON.stringify({result:await this.#options.endpoints!.invoke(path,request.method!,this.#options.endpoints!.parse(path,query,body,request.headers['content-type']??''),context)});signal.throwIfAborted();
    if(result!==null&&Buffer.byteLength(result)>maxBytes){this.#error(response,500,'Response too large');return;}
    if(!response.destroyed){if(result!==null)response.setHeader('content-type','application/json; charset=UTF-8');if(completion){const sent=await new Promise<boolean>(resolve=>{const closed=()=>{response.off('finish',finished);resolve(false);},finished=()=>{response.off('close',closed);resolve(true);};response.once('close',closed);response.once('finish',finished);response.end(result??undefined);});if(!completion.complete(sent))response.destroy(completion.error);}else response.end(result??undefined);}
   }catch(error){
    // Early multipart policy rejection can otherwise close the TCP connection
    // while fetch is still writing the body, hiding a valid 401 behind EPIPE.
    // Keep the existing request slot and buffer reservation during this wait.
    if(isUpload&&reserved>=65536&&!response.headersSent)await discardRejectedUploadBody(request,signal);
    if(signal.aborted)this.#error(response,503,'Request cancelled');else if(!isRPC&&error instanceof ApiError)this.#error(response,Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:500,error.message);else this.#error(response,isRPC?400:500,isRPC?'Invalid request body':'Internal Server Error');}
   finally{if(completion&&!completion.complete(false))response.destroy(completion.error);this.#buffered-=reserved;this.#outputBytes-=outputReserved;signal.removeEventListener('abort',cancel);response.off('close',disconnected);}
  },parent.signal);
 }
 #connected(request:IncomingMessage,socket:WebSocket):void{
  const id=this.#nextId++;if(!Number.isSafeInteger(id)){socket.terminate();return;}
  const peer:Peer={socket,request,abort:new AbortController(),active:0,alive:true};this.#peers.set(id,peer);this.#clients.add(id);
  if(this.#notifications)this.#notifications.add(id,{signal:peer.abort.signal,authorize:(method,params,signal)=>this.#options.authorizeNotification!(method,params,{request,transport:'websocket',connectionId:id,signal}),send:message=>this.#send(peer,message),disconnect:reason=>{peer.abort.abort(reason);socket.terminate();}});
  if(this.#clientCalls)this.#clientCalls.add(id,{signal:peer.abort.signal,authorize:(method,params,signal)=>this.#options.authorizeClientCall!(method,params,{request,transport:'websocket',connectionId:id,signal}),send:message=>this.#send(peer,message),disconnect:reason=>{peer.abort.abort(reason);socket.terminate();}});
  if(this.#clientRequests)this.#clientRequests.add(id,{signal:peer.abort.signal,authorize:(method,params,signal)=>this.#options.authorizeClientRequest!(method,params,{request,transport:'websocket',connectionId:id,signal}),send:message=>this.#send(peer,message)});
  socket.on('error',()=>socket.terminate());socket.on('pong',()=>{peer.alive=true;});socket.on('close',()=>{peer.abort.abort(new Error('WebSocket client disconnected'));this.#peers.delete(id);const client=this.#clients.remove(id);if(client?.identity?.type==='agent')this.#agentEvent(id,{agent:client.identity.name,event:'disconnected'});});
  socket.on('message',data=>{
   const size=Array.isArray(data)?data.reduce((n,b)=>n+b.byteLength,0):data.byteLength;
   const decoded=this.#clientRequests?.acceptFrame(id,bytes(data));if(decoded&&decoded.value===undefined)return;
   if(this.#buffered+size>this.#maxBuffered){peer.abort.abort(new Error('Request buffer capacity exceeded'));socket.terminate();return;}
   if(this.#phase!=='listening'||peer.active>=this.#perSocket||this.#requests.size>=this.#maxRequests){peer.abort.abort(new Error('WebSocket request capacity exceeded'));socket.terminate();return;}
   peer.active++;this.#buffered+=size;this.#launch(async signal=>{let completion:ResponseCompletion|undefined;const cancelled=()=>socket.terminate();signal.addEventListener('abort',cancelled,{once:true});try{signal.throwIfAborted();const context=this.#context(request,'websocket',signal,id);context.afterResponse=callback=>{(completion??=new ResponseCompletion(signal)).add(callback);};const result=decoded?await this.#rpc.dispatchValue(decoded.value,context):await this.#rpc.dispatch(bytes(data),context);signal.throwIfAborted();const sent=result===null||this.#send(peer,result);if(completion&&!completion.complete(sent))socket.terminate();}finally{if(completion&&!completion.complete(false))socket.terminate();signal.removeEventListener('abort',cancelled);peer.active--;this.#buffered-=size; }},peer.abort.signal);
  });
 }
 #send(peer:Peer,message:string):boolean{
  if(peer.socket.readyState!==WebSocket.OPEN)return false;const size=Buffer.byteLength(message);
  if(size>maxBytes||peer.socket.bufferedAmount+size>maxBytes||this.#outputBytes+size>this.#maximumOutputBytes){peer.abort.abort(new Error('WebSocket output capacity exceeded'));peer.socket.terminate();return false;}
  this.#outputBytes+=size;let settled=false;const release=(error?:Error)=>{if(settled)return;settled=true;this.#outputBytes-=size;if(error){peer.abort.abort(new Error('WebSocket output failed'));peer.socket.terminate();}};
  try{peer.socket.send(message,release);return true;}catch{release(new Error('WebSocket output failed'));return false;}
 }
 notify(connectionId:number,method:string,params:readonly Json[]):boolean{const peer=this.#peers.get(connectionId);if(!peer||peer.abort.signal.aborted)return false;return this.#send(peer,encodeNotification(method,params));}
 /** Connection lifetime, distinct from any individual RPC request deadline. */
 connectionSignal(id:number):AbortSignal{const peer=this.#peers.get(id);if(!peer||peer.abort.signal.aborted)throw new ApiError(404,'Connection is no longer available');return peer.abort.signal;}
 disconnectClient(id:number):void{const peer=this.#peers.get(id);if(peer){peer.abort.abort(new Error('Client delivery stopped'));peer.socket.terminate();}}
 notifyAuthorized(id:number,method:string,params:readonly Json[]):Promise<DeliveryReport>{return Promise.resolve(this.dispatchNotification(id,method,params));}
 dispatchNotification(id:number,method:string,params:readonly Json[],signal?:AbortSignal):DeliveryReport|Promise<DeliveryReport>{if(!this.#notifications)throw new ApiError(503,'Notification authorization is required');if(this.#phase!=='listening')return Promise.reject(new Error('Network is not listening'));return this.#notifications.dispatchTo(id,method,params,signal);}
 dispatchClientCall(id:number,method:string,params:ClientArguments=null,signal?:AbortSignal):DeliveryReport|Promise<DeliveryReport>{if(!this.#clientCalls)throw new ApiError(503,'Client call authorization is required');if(this.#phase!=='listening')throw new ApiError(503,'Network is not listening');return this.#clientCalls.dispatchTo(id,method,params,signal);}
 requestClient(id:number,method:string,params:ClientArguments=null,options:ClientRequestOptions={}){if(!this.#clientRequests)throw new ApiError(503,'Client request authorization is required');if(this.#phase!=='listening')throw new ApiError(503,'Network is not listening');return this.#clientRequests.request(id,method,params,options);}
 broadcast(method:string,params:readonly Json[],excluded:readonly number[]=[]):Promise<DeliveryReport>{return Promise.resolve(this.dispatchBroadcast(method,params,excluded));}
 dispatchBroadcast(method:string,params:readonly Json[],excluded:readonly number[]=[],signal?:AbortSignal):DeliveryReport|Promise<DeliveryReport>{if(!this.#notifications)throw new ApiError(503,'Notification authorization is required');if(this.#phase!=='listening')return Promise.reject(new Error('Network is not listening'));return this.#notifications.dispatch(method,params,excluded,signal);}
 #agentEvent(id:number,event:Json):void{if(this.#notifications&&this.#phase==='listening')void this.broadcast('notify_agent_event',[event],[id]).catch(()=>{});}
 /** Abort requests and wait for cooperative handlers. Ignored cancellation is
  * reported after the shutdown deadline, never silently reported as drained. */
 close():Promise<void>{
  if(this.#close)return this.#close;if(this.#phase==='closed')return Promise.resolve();this.#phase='closing';clearInterval(this.#heartbeat);
  const clientRequestsClosed=this.#clientRequests?.close()??Promise.resolve();
  const clientCallsClosed=this.#clientCalls?.close()??Promise.resolve();
  const notificationsClosed=this.#notifications?.close()??Promise.resolve();
  for(const abort of this.#requests.keys())abort.abort(new Error('Moonraker network shutting down'));for(const peer of this.#peers.values()){peer.abort.abort(new Error('Moonraker network shutting down'));peer.socket.terminate();}for(const socket of this.#sockets)socket.destroy();
  const serverClosed=(async()=>{await this.#opening?.catch(()=>{});await new Promise<void>(resolve=>{if(!this.#server.listening)resolve();else this.#server.close(()=>resolve());});})();
  let timeout:ReturnType<typeof setTimeout>|undefined;
  this.#close=Promise.race([Promise.all([serverClosed,clientCallsClosed,notificationsClosed,clientRequestsClosed,...this.#requests.values()]),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Network tasks did not stop before shutdown deadline')),this.#shutdownTimeout);})]).then(()=>{this.#phase='closed';this.#rpc.remove('server.websocket.id');this.#rpc.remove('server.connection.identify');for(const client of this.#clients.all())this.#clients.remove(client.id);this.#ws.close();}).finally(()=>{clearTimeout(timeout);this.#close=undefined;});return this.#close;
 }
}
