import {redirectArgument,safeRedirectTarget} from './redirect-target.ts';
import {relativeRouteUrl,validateRoutePrefix} from './route-prefix.ts';
import type {ThumbnailDownloads} from './thumbnail-download.ts';
import {ApplicationLogFiles,applicationLogRange} from './application-log-files.ts';
import {CorsPolicy} from './cors-policy.ts';
import {NativePrintUploads} from './native-print-uploads.ts';
import type {NativeConfigFiles} from './native-config-files.ts';
import {discardRejectedUploadBody} from './rejected-upload-body.ts';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {setImmediate as yieldImmediate} from 'node:timers/promises';
import {ClientCalls} from './client-calls.ts';
import {ClientRequests,type ClientArguments,type ClientRequestLimits,type ClientRequestOptions} from './client-requests.ts';
import {ResponseCompletion} from './response-completion.ts';
import {transportProtocol,type RequestProtocol} from './proxy-address.ts';
import {subscriptionConnectionId} from './subscription-connection.ts';
import {NotificationFanout,type NotificationLimits,type DeliveryReport} from './notifications.ts';
import {RemoteClients} from './clients.ts';
import {EndpointRegistry} from './endpoints.ts';
import {createServer,type IncomingMessage,type ServerResponse,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createServer as createSecureServer,type Server as SecureServer} from 'node:https';
import type {Duplex} from 'node:stream';
import {WebSocketServer,WebSocket,type RawData} from 'ws';
import {JsonRpcDispatcher,ApiError,encodeNotification,type Json,type RpcContext,type AuthorizationResult} from './rpc.ts';
export interface NetworkAuthorization {
 request:IncomingMessage;transport:'http'|'websocket';connectionId?:number;signal:AbortSignal;useXheaders?:boolean;routePrefix?:string;
}
export interface MoonrakerTlsOptions {readonly port:number;readonly cert:Uint8Array;readonly key:Uint8Array;readonly handshakeTimeoutMs?:number;}
export interface MoonrakerAddress extends AddressInfo {routePrefix?:string;secure?:AddressInfo;}
export interface MoonrakerNetworkOptions {
 endpoints?:EndpointRegistry;
 /** Explicit process-owned TLS material; listeners share every admission budget. */
 tls?:MoonrakerTlsOptions;
 /** Configuration-owned application status; never an alternate auth policy. */
 redirect?:{authorizationAvailable():boolean};
 /** Process-owned complete welcome renderer; request capacity/lifetime stays here. */
 welcome?:{render(context:NetworkAuthorization):Promise<string>};
 /** Configuration-owned xheaders selection; identity trust remains separate. */
 /** Canonical encoded configured prefix; default root remains empty. */
 routePrefix?:string;
 useXheaders?:boolean;
 /** Verified request URL protocol, never an identity or forwarded host grant.
  * The configuration-owned authorization policy supplies this resolver. */
 resolveRequestProtocol?(request:NetworkAuthorization):RequestProtocol|Promise<RequestProtocol>;
 /** Synchronous immutable metadata capture, without granting authorization. */
 captureRequestMetadata?(request:NetworkAuthorization):void;
 thumbnails?:ThumbnailDownloads;
 /** Native multipart HTTP admission; lifetime belongs to the composition owner. */
 nativeUploads?:NativePrintUploads;
 /** Configuration-owned slicer upload alias, same publication owner and limits. */
 octoprint?:{enableUfp:boolean};
 /** Explicit process config reads, separately owned from the print device. */
 configFiles?:NativeConfigFiles;
 /** Fixed process-owned log aliases; never a caller-selected filesystem path. */
 logs?:ApplicationLogFiles;
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
 /** Configuration-owned CORS admission, independent of method authentication. */
 cors?:CorsPolicy;
 requestTimeoutMs?:number;shutdownTimeoutMs?:number;maxBufferedBytes?:number;maxOutputBytes?:number;
}
interface Peer{socket:WebSocket;request:IncomingMessage;abort:AbortController;active:number;alive:boolean;}
interface OriginAdmission{allowed:boolean;cors:boolean;}
const maxBytes=1024*1024;
function bounded(value:number|undefined,fallback:number,max:number):number{const n=value??fallback;if(!Number.isInteger(n)||n<1||n>max)throw new RangeError('Invalid network capacity or timeout');return n;}
function bytes(data:RawData):Buffer{return Buffer.isBuffer(data)?data:Array.isArray(data)?Buffer.concat(data):Buffer.from(data);}
/** Moonraker JSON-RPC network transport. Business APIs and authorization storage
 * remain separate components; the required authorize callback never defaults to allow. */
export class MoonrakerNetwork {
 #clientCalls:ClientCalls|undefined;#clients=new RemoteClients();#notifications:NotificationFanout|undefined;#clientRequests:ClientRequests|undefined;
 #rpc:JsonRpcDispatcher;#options:MoonrakerNetworkOptions;#server:Server;#secure:SecureServer|undefined;#securePort:number|undefined;#ws:WebSocketServer;
 #peers=new Map<number,Peer>();#nextId=1;#requests=new Map<AbortController,Promise<void>>();#sockets=new Set<Duplex>();
 #upgrades=new Set<Duplex>();
 #outputBytes=0;#maximumOutputBytes:number;
 #buffered=0;#maxBuffered:number;#maxConnections:number;#maxRequests:number;#perSocket:number;#timeout:number;#shutdownTimeout:number;#origins:Set<string>;
 #opening:Promise<void>|undefined;#heartbeat:ReturnType<typeof setInterval>|undefined;#phase:'new'|'starting'|'listening'|'closing'|'closed'='new';#close:Promise<void>|undefined;
 #nativeLifetime:AbortSignal|undefined;
 constructor(rpc:JsonRpcDispatcher,options:MoonrakerNetworkOptions,nativeLifetime?:AbortSignal){
  if(nativeLifetime!==undefined&&(!(nativeLifetime instanceof AbortSignal)||nativeLifetime.aborted))throw new Error('Invalid native request lifetime');this.#nativeLifetime=nativeLifetime;
  if(rpc.has('server.websocket.id')||rpc.has('server.connection.identify'))throw new Error('Network RPC method already registered');
  validateRoutePrefix(options.routePrefix??'');
  if(options.redirect!==undefined&&(!options.redirect||typeof options.redirect.authorizationAvailable!=='function'||options.endpoints?.allowed('/server/redirect')))throw new TypeError('Invalid or conflicting application redirect owner');
  if(options.welcome!==undefined&&(!options.welcome||typeof options.welcome.render!=='function'||options.endpoints?.allowed('/')))throw new TypeError('Invalid or conflicting application welcome owner');
  if(options.useXheaders!==undefined&&typeof options.useXheaders!=='boolean')throw new TypeError('Invalid xheaders policy');
  if(options.resolveRequestProtocol!==undefined&&typeof options.resolveRequestProtocol!=='function')throw new TypeError('Invalid request protocol resolver');
  if(options.captureRequestMetadata!==undefined&&typeof options.captureRequestMetadata!=='function')throw new TypeError('Invalid request metadata capture');
  if(typeof options.authorize!=='function')throw new TypeError('Network authorization is required');if(options.endpoints&&options.endpoints.dispatcher!==rpc)throw new Error('Endpoint registry must share the network dispatcher');this.#rpc=rpc;this.#options={...options};
  this.#maximumOutputBytes=bounded(options.maxOutputBytes,8*maxBytes,64*maxBytes);
  this.#maxBuffered=bounded(options.maxBufferedBytes,8*maxBytes,64*maxBytes);this.#maxConnections=bounded(options.maxConnections,50,10000);this.#maxRequests=bounded(options.maxRequests,256,10000);this.#perSocket=bounded(options.maxRequestsPerSocket,32,1000);this.#timeout=bounded(options.requestTimeoutMs,300000,2147483647);this.#shutdownTimeout=bounded(options.shutdownTimeoutMs,5000,60000);
  this.#origins=new Set((options.origins??[]).map(origin=>{const url=new URL(origin);if(!['http:','https:'].includes(url.protocol)||url.origin!==origin)throw new Error('Invalid allowed origin');return origin;}));
  if(options.cors!==undefined&&!(options.cors instanceof CorsPolicy))throw new TypeError('Invalid CORS policy');
  if(options.authorizeNotification!==undefined&&typeof options.authorizeNotification!=='function')throw new TypeError('Invalid notification authorization');
  if(options.authorizeSubscriptionConnection!==undefined&&typeof options.authorizeSubscriptionConnection!=='function')throw new TypeError('Invalid subscription connection authorization');
  if(options.authorizeNotification)this.#notifications=new NotificationFanout(options.notificationLimits);
  if(options.authorizeClientCall!==undefined&&typeof options.authorizeClientCall!=='function')throw new TypeError('Invalid client call authorization');
  if(options.authorizeClientCall)this.#clientCalls=new ClientCalls(options.clientCallLimits);
  if(options.authorizeClientRequest!==undefined&&typeof options.authorizeClientRequest!=='function')throw new TypeError('Invalid client request authorization');
  if(options.authorizeClientRequest)this.#clientRequests=new ClientRequests(options.clientRequestLimits);
  const httpOptions={maxHeaderSize:16384,requestTimeout:30000,headersTimeout:10000},listener=(request:IncomingMessage,response:ServerResponse)=>this.#http(request,response);
  if(options.tls!==undefined){const tls=options.tls;if(!tls||!Number.isInteger(tls.port)||tls.port<0||tls.port>65535||!(tls.cert instanceof Uint8Array)||!tls.cert.byteLength||tls.cert.byteLength>256*1024||!(tls.key instanceof Uint8Array)||!tls.key.byteLength||tls.key.byteLength>64*1024)throw new TypeError('Invalid process TLS options');this.#securePort=tls.port;this.#secure=createSecureServer({...httpOptions,cert:Buffer.from(tls.cert),key:Buffer.from(tls.key),handshakeTimeout:bounded(tls.handshakeTimeoutMs,10000,10000),minVersion:'TLSv1.2'},listener);this.#secure.on('tlsClientError',(_error,socket)=>socket.destroy());}
  this.#server=createServer(httpOptions,listener);
  this.#ws=new WebSocketServer({noServer:true,maxPayload:maxBytes,perMessageDeflate:false});
  for(const server of [this.#server,...this.#secure?[this.#secure]:[]]){server.maxConnections=this.#maxConnections+this.#maxRequests;server.on('connection',socket=>{if(this.#phase==='closing'||this.#phase==='closed'||this.#sockets.size>=this.#maxConnections+this.#maxRequests){socket.destroy();return;}this.#sockets.add(socket);socket.on('close',()=>this.#sockets.delete(socket));});server.on('upgrade',(request,socket,head)=>this.#upgrade(request,socket,head));server.on('clientError',(_error,socket)=>{if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');});}
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
 /** Composition-only handoff. Every admitted HTTP request captures its old
  * owner before body/authorization awaits; it cannot switch to a new printer. */
 replaceNativeUploads(next?:NativePrintUploads,nativeLifetime?:AbortSignal):void{
  const previous=this.#options.nativeUploads,status=previous?.status;
  const retained=previous!==undefined&&previous===next&&!status!.closed;
  if(this.#phase!=='listening'||previous&&!retained&&(!status!.closed||status!.pending||status!.downloads||status!.authorizing||status!.metadata.pending))throw new Error('Native upload generation has not retired');
  if(next!==undefined&&(!(next instanceof NativePrintUploads)||next.status.closed||!retained&&(next.status.pending||next.status.downloads||next.status.authorizing||next.status.metadata.pending)))throw new Error('New native uploads are unavailable');
  if(this.#nativeLifetime&&!this.#nativeLifetime.aborted||nativeLifetime!==undefined&&(!(nativeLifetime instanceof AbortSignal)||nativeLifetime.aborted))throw new Error('Native request lifetime is not retired');
  this.#options.nativeUploads=next;this.#nativeLifetime=nativeLifetime;
 }
 async listen(port=0,host='127.0.0.1'):Promise<MoonrakerAddress>{
  if(this.#phase!=='new'||!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid network listen state or port');
  if(this.#secure&&port!==0&&port===this.#securePort)throw new Error('HTTP and HTTPS ports must differ');
  this.#phase='starting';try{this.#opening=(async()=>{await this.#listenServer(this.#server,port,host);if(this.#phase!=='starting')throw new Error('Network startup cancelled');if(this.#secure)await this.#listenServer(this.#secure,this.#securePort!,host);})();await this.#opening;if(this.#phase!=='starting')throw new Error('Network startup cancelled');this.#phase='listening';}
  catch(error){for(const socket of this.#sockets)socket.destroy();await Promise.all([this.#server,...this.#secure?[this.#secure]:[]].map(server=>this.#closeServer(server)));if(this.#phase==='starting')this.#phase='new';throw error;}
  this.#heartbeat=setInterval(()=>{for(const peer of this.#peers.values()){if(peer.socket.readyState!==WebSocket.OPEN)continue;if(!peer.alive){peer.socket.terminate();continue;}peer.alive=false;peer.socket.ping();}},10000);this.#heartbeat.unref();const address=this.#server.address() as AddressInfo;return this.#secure?{...address,...this.#options.routePrefix?{routePrefix:this.#options.routePrefix}:{},secure:this.#secure.address() as AddressInfo}:this.#options.routePrefix?{...address,routePrefix:this.#options.routePrefix}:address;
 }
 #listenServer(server:Server|SecureServer,port:number,host:string):Promise<void>{return new Promise((resolve,reject)=>{const fail=(error:Error)=>{server.off('listening',ready);reject(error);},ready=()=>{server.off('error',fail);resolve();};server.once('error',fail);server.once('listening',ready);server.listen(port,host);});}
 #closeServer(server:Server|SecureServer):Promise<void>{return new Promise(resolve=>{if(!server.listening)resolve();else server.close(()=>resolve());});}
 #origin(request:IncomingMessage,signal:AbortSignal):OriginAdmission|Promise<OriginAdmission>{
  const origin=request.headers.origin;if(origin===undefined)return {allowed:true,cors:false};
  try{
   if(this.#origins.has(origin)||this.#options.cors?.matches(origin)===true)return {allowed:true,cors:true};
   const url=new URL(origin);if(['http:','https:'].includes(url.protocol)&&url.origin===origin&&url.host.toLowerCase()===request.headers.host?.toLowerCase())return {allowed:true,cors:false};
  }catch{return {allowed:false,cors:false};}
  const grant=this.#options.cors?.check(origin,signal)??false;return grant instanceof Promise?grant.then(allowed=>({allowed,cors:allowed})):{allowed:grant,cors:grant};
 }
 #upgrade(request:IncomingMessage,socket:Duplex,head:Buffer):void{
  if(this.#phase!=='listening'||this.#peers.size+this.#upgrades.size>=this.#maxConnections||this.#requests.size>=this.#maxRequests){this.#rejectUpgrade(socket,503);return;}
  if(relativeRouteUrl(request.url??'',this.#options.routePrefix??'')?.split('?')[0]!=='/websocket'){this.#rejectUpgrade(socket,404);return;}
  const parent=new AbortController(),disconnected=()=>parent.abort(new Error('Upgrade client disconnected'));socket.once('close',disconnected);socket.once('end',disconnected);this.#upgrades.add(socket);
  this.#launch(async signal=>{
   const cancelled=()=>socket.destroy();signal.addEventListener('abort',cancelled,{once:true});
   try{
    signal.throwIfAborted();const check=this.#origin(request,signal),admission=check instanceof Promise?await check:check;signal.throwIfAborted();
    if(!admission.allowed){this.#rejectUpgrade(socket,403);return;}
    if(this.#phase!=='listening'||this.#peers.size>=this.#maxConnections){this.#rejectUpgrade(socket,503);return;}
    if(!socket.destroyed)this.#ws.handleUpgrade(request,socket,head,ws=>this.#connected(request,ws));
   }catch{if(!socket.destroyed)this.#rejectUpgrade(socket,503);}
   finally{signal.removeEventListener('abort',cancelled);socket.off('close',disconnected);socket.off('end',disconnected);this.#upgrades.delete(socket);}
  },parent.signal);
 }
 #error(response:ServerResponse,status:number,message:string,data?:Json):void{if(response.destroyed||response.writableEnded)return;if(response.headersSent){response.destroy();return;}response.writeHead(status,{'content-type':'application/json; charset=UTF-8'});response.end(JSON.stringify({error:{code:status,message,...data===undefined?{}:{data}}}));}
 #rejectUpgrade(socket:Duplex,status:number):void{socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);}
 #launch(run:(signal:AbortSignal)=>Promise<void>,parent?:AbortSignal):void{
  const abort=new AbortController(),cancel=()=>abort.abort(parent?.reason??new Error('Client disconnected'));parent?.addEventListener('abort',cancel,{once:true});if(parent?.aborted)cancel();
  const timeout=setTimeout(()=>abort.abort(new Error('RPC request timed out')),this.#timeout);
  // Publish the task before invoking handlers so reentrant shutdown sees it.
  const job=Promise.resolve().then(()=>run(abort.signal)).catch(()=>{}).finally(()=>{clearTimeout(timeout);parent?.removeEventListener('abort',cancel);this.#requests.delete(abort);});this.#requests.set(abort,job);
 }
 #context(request:IncomingMessage,transport:'http'|'websocket',signal:AbortSignal,id?:number,nativeGenerationSignal=this.#nativeLifetime,nativeGenerationRetiredAtAdmission=!!nativeGenerationSignal?.aborted):RpcContext{
  return {transport,signal,nativeGenerationSignal,nativeGenerationRetiredAtAdmission,connectionId:id,authorize:(method,params)=>this.#options.authorize(method,params,{request,transport,connectionId:id,signal,useXheaders:this.#options.useXheaders,routePrefix:this.#options.routePrefix??''}),receiveResponse:transport==='websocket'&&id!==undefined?(responseId,value)=>{this.#clientRequests?.receive(id,responseId,value);}:undefined};
 }
 async #subscriptionConnection(request:IncomingMessage,body:Uint8Array,signal:AbortSignal):Promise<{id:number;signal:AbortSignal}>{
  if(!this.#options.authorizeSubscriptionConnection)throw new ApiError(503,'Subscription connection authorization is required');signal.throwIfAborted();
  const id=subscriptionConnectionId(request.url??'',body,request.headers['content-type']??''),peer=this.#peers.get(id);if(!peer||peer.abort.signal.aborted)throw new ApiError(404,'Subscription connection is no longer available');
  const combined=AbortSignal.any([signal,peer.abort.signal]);await this.#options.authorizeSubscriptionConnection({request,transport:'http',signal:combined,useXheaders:this.#options.useXheaders,routePrefix:this.#options.routePrefix??''},{request:peer.request,transport:'websocket',connectionId:id,signal:combined,useXheaders:this.#options.useXheaders,routePrefix:this.#options.routePrefix??''});combined.throwIfAborted();if(this.#peers.get(id)!==peer)throw new ApiError(404,'Subscription connection changed');return {id,signal:peer.abort.signal};
 }
 #http(request:IncomingMessage,response:ServerResponse):void{
  if(this.#phase!=='listening'){this.#error(response,503,'Server is shutting down');return;}
  const rawUrl=request.url??'',prefix=this.#options.routePrefix??'',bareWelcome=!!this.#options.welcome&&!!prefix&&rawUrl.split('?')[0]===prefix;
  const routed=bareWelcome?'/'+rawUrl.slice(prefix.length):relativeRouteUrl(rawUrl,prefix);if(routed===undefined){this.#error(response,404,'Not Found');return;}
  const isWelcome=!!this.#options.welcome&&routed.split('?')[0]==='/';
  const isRedirect=!!this.#options.redirect&&routed.split('?')[0]==='/server/redirect';
  const octoprint=this.#options.octoprint,isOctoUpload=!!octoprint&&routed.split('?')[0]==='/api/files/local';
  const nativeUploads=this.#options.nativeUploads,nativeGenerationSignal=this.#nativeLifetime,receiveUpload=nativeUploads?.captureUpload(isOctoUpload?undefined:this.#options.configFiles,isOctoUpload?{enableUfp:octoprint!.enableUfp}:undefined),nativeGenerationRetiredAtAdmission=!!nativeGenerationSignal?.aborted;
  const url=routed,at=url.indexOf('?'),path=at<0?url:url.slice(0,at),query=at<0?'':url.slice(at+1),isRPC=path==='/server/jsonrpc',isUpload=!!nativeUploads&&(path==='/server/files/upload'||isOctoUpload),isDownload=nativeUploads?.matchesDownload(path)??false,isConfigDownload=this.#options.configFiles?.matchesDownload(path)??false,isLogDownload=this.#options.logs?.matches(path)??false,isNativeThumbnail=!!nativeUploads&&!isDownload&&nativeUploads.matchesThumbnail(path)&&(!this.#options.thumbnails||nativeUploads.hasThumbnail(path)),isThumbnail=isNativeThumbnail||(this.#options.thumbnails?.matches(path)??false),allowed=isWelcome||isRedirect?['GET']:isRPC||isUpload?['POST']:isDownload&&nativeUploads!.canRemove?['GET','HEAD','DELETE']:isDownload||isConfigDownload||isLogDownload||isThumbnail?['GET','HEAD']:this.#options.endpoints?.allowed(path);
  if(!allowed){this.#error(response,404,'Not Found');return;}
  if(this.#requests.size>=this.#maxRequests){this.#error(response,429,'Too many active requests');return;}
  const parent=new AbortController(),disconnected=()=>{if(!response.writableEnded)parent.abort(new Error('HTTP client disconnected'));};response.once('close',disconnected);
  const address=request.socket.localAddress??'127.0.0.1',locationHost=request.headers.host??`${address.includes(':')?'['+address+']':address}:${request.socket.localPort}`;
  this.#launch(async signal=>{
   let reserved=0,outputReserved=0,completion:ResponseCompletion|undefined;const cancel=()=>{this.#error(response,503,'Request cancelled');request.destroy();};signal.addEventListener('abort',cancel,{once:true});
   try{
    let uploadProtocol:RequestProtocol=transportProtocol(request);
    if(isUpload||isRedirect||isWelcome||isLogDownload)this.#options.captureRequestMetadata?.({request,transport:'http',signal,useXheaders:this.#options.useXheaders,routePrefix:this.#options.routePrefix??''});
    signal.throwIfAborted();const originCheck=isWelcome?{allowed:true,cors:false}:this.#origin(request,signal),originAdmission=originCheck instanceof Promise?await originCheck:originCheck;signal.throwIfAborted();
    if(!originAdmission.allowed){this.#error(response,403,'Origin not allowed');return;}
    if(request.headers.origin&&originAdmission.cors){response.setHeader('access-control-allow-origin',request.headers.origin);response.setHeader('vary','Origin');response.setHeader('access-control-allow-credentials','true');response.setHeader('access-control-expose-headers','ETag, Content-Disposition, Content-Length, Content-Range, Accept-Ranges, Location');}
    if(request.method==='OPTIONS'){if(isWelcome){this.#error(response,405,'Method Not Allowed');return;}if(isRedirect&&(!this.#options.redirect!.authorizationAvailable()||!this.#options.cors||!originAdmission.cors)){this.#error(response,405,'Method Not Allowed');return;}response.writeHead(204,{'access-control-allow-methods':[...allowed,'OPTIONS'].join(', '),'access-control-allow-headers':'Content-Type, Authorization, X-Api-Key, X-Access-Token, If-None-Match, Range, If-Range'+(isLogDownload?', If-Modified-Since':'')});response.end();return;}
    if(!allowed.some(v=>v===request.method)){this.#error(response,405,'Method Not Allowed');return;}
    if(isRPC&&!request.headers['content-type']?.trim().startsWith('application/json')){this.#error(response,400,'Invalid content type, application/json required');return;}
    if(isRedirect&&this.#options.redirect!.authorizationAvailable()){await this.#options.authorize('access.info',{}, {request,transport:'http',signal,useXheaders:this.#options.useXheaders,routePrefix:this.#options.routePrefix??''});signal.throwIfAborted();}
    if(isUpload){
     signal.throwIfAborted();if(isOctoUpload)await this.#options.authorize('api.files.local',{}, {request,transport:'http',signal,useXheaders:this.#options.useXheaders,routePrefix:this.#options.routePrefix??''});signal.throwIfAborted();response.setHeader('connection','close');
     const budget=8*65536;if(this.#buffered+budget>this.#maxBuffered)throw new ApiError(429,'Request buffer capacity exceeded');
     this.#buffered+=budget;reserved=budget;
     const context=this.#context(request,'http',signal,undefined,nativeGenerationSignal,nativeGenerationRetiredAtAdmission),authorize=context.authorize;let selectedProtocol=false;
     if(this.#options.resolveRequestProtocol)context.authorize=(method,params)=>{
      const afterGrant=(grant:AuthorizationResult):AuthorizationResult|Promise<AuthorizationResult>=>{
       if(selectedProtocol)return grant;
       const selected=this.#options.resolveRequestProtocol!({request,transport:'http',signal:context.signal,useXheaders:this.#options.useXheaders,routePrefix:this.#options.routePrefix??''});
       const accept=(protocol:RequestProtocol)=>{context.signal.throwIfAborted();if(protocol!=='http'&&protocol!=='https')throw new ApiError(500,'Invalid request protocol');uploadProtocol=protocol;selectedProtocol=true;};
       // A new protocol wait cannot preserve a stale key/JWT/network grant.
       if(selected instanceof Promise)return selected.then(protocol=>{accept(protocol);return authorize(method,params);});
       accept(selected);return grant;
      };
      const grant=authorize(method,params);return grant instanceof Promise?grant.then(afterGrant):afterGrant(grant);
     };
     const result=await receiveUpload!(request,context);signal.throwIfAborted();
     if(!result||typeof result!=='object'||Array.isArray(result))throw new ApiError(500,'Invalid upload receipt');
     // Multipart clients consume top-level item/action; result remains a native
     // compatibility alias for previously issued SDKs and receipts.
     const item=result.item;
     if(item&&typeof item==='object'&&!Array.isArray(item)&&typeof item.root==='string'&&typeof item.path==='string'){
      const encoded=item.path.split('/').map(part=>encodeURIComponent(part).replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase())).join('/');
      // The original owner verifies the proxy; forwarded host/query are unused.
      response.setHeader('location',`${uploadProtocol}://${locationHost}${this.#options.routePrefix??''}/${isOctoUpload?'api/files/moonraker':'server/files'}/${item.root}/${encoded}`);
     }
     response.statusCode=201;
     response.setHeader('content-type','application/json; charset=UTF-8');response.end(JSON.stringify({...result,result}));return;
    }
    signal.throwIfAborted();const chunks:Buffer[]=[];let length=0;
    for await(const chunk of request){signal.throwIfAborted();length+=chunk.length;if(length>maxBytes){this.#error(response,413,'Request too large');return;}if(this.#buffered+chunk.length>this.#maxBuffered){this.#error(response,429,'Request buffer capacity exceeded');return;}this.#buffered+=chunk.length;reserved+=chunk.length;chunks.push(chunk);}
    const body=Buffer.concat(chunks),context=this.#context(request,'http',signal,undefined,nativeGenerationSignal,nativeGenerationRetiredAtAdmission);
    if(isWelcome){const budget=1024*1024;if(budget>this.#maximumOutputBytes-this.#outputBytes)throw new ApiError(429,'Response buffer capacity exceeded');this.#outputBytes+=budget;outputReserved=budget;const html=await this.#options.welcome!.render({request,transport:'http',signal,useXheaders:this.#options.useXheaders,routePrefix:this.#options.routePrefix??''});signal.throwIfAborted();if(typeof html!=='string'||!html.isWellFormed()||Buffer.byteLength(html)>budget)throw new ApiError(500,'Invalid welcome output');response.writeHead(200,{'content-type':'text/html; charset=UTF-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'});await new Promise<void>(resolve=>{const finish=()=>{response.off('close',finish);response.off('finish',finish);resolve();};response.once('close',finish);response.once('finish',finish);response.end(html);});return;}
    if(isRedirect){const argument=redirectArgument(query,body),target=safeRedirectTarget(argument);if(target===undefined||!this.#options.redirect!.authorizationAvailable()||!this.#options.cors)throw new ApiError(400,'Unauthorized URL redirect');const grant=this.#options.cors.checkRedirect(argument,signal),allowed=grant instanceof Promise?await grant:grant;signal.throwIfAborted();if(!allowed)throw new ApiError(400,'Unauthorized URL redirect');await this.#options.authorize('access.info',{}, {request,transport:'http',signal,useXheaders:this.#options.useXheaders,routePrefix:this.#options.routePrefix??''});signal.throwIfAborted();response.writeHead(302,{location:target,'cache-control':'no-store','referrer-policy':'no-referrer'});response.end();return;}
    if(isDownload&&request.method==='DELETE'){
     if(query||body.length)throw new ApiError(400,'File deletion does not accept a query or body');
     const result=await nativeUploads!.remove({path:decodeURIComponent(path.slice('/server/files/'.length))},context);signal.throwIfAborted();response.setHeader('content-type','application/json; charset=UTF-8');response.end(JSON.stringify({result}));return;
    }
    if(isLogDownload){
     const budget=3*65536;if(budget>this.#maximumOutputBytes-this.#outputBytes)throw new ApiError(429,'Response buffer capacity exceeded');this.#outputBytes+=budget;outputReserved=budget;
     await this.#options.logs!.download(path,context,async(file,downloadSignal)=>{
      const modified=new Date(file.modifiedMs).toUTCString(),ascii=Array.from(file.name,char=>char.codePointAt(0)!>127?'?':char).join('').replace(/"/g,'\\"'),encoded=encodeURIComponent(file.name).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
      response.setHeader('content-type','text/plain; charset=UTF-8');response.setHeader('cache-control','private, no-cache');response.setHeader('x-content-type-options','nosniff');response.setHeader('last-modified',modified);response.setHeader('accept-ranges','bytes');response.setHeader('content-disposition',`attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`);
      const since=request.headers['if-modified-since'];if(since&&Math.floor(file.modifiedMs/1000)*1000<=Date.parse(since)){response.writeHead(304);response.end();return;}
      // Original log handler ignores If-None-Match and applies ranges to HEAD
      // too; full-file ranges remain 200. Integer header bounds stay exact.
      const range=applicationLogRange(request.headers.range,file.size);if(range.status===416){response.setHeader('content-range','bytes */'+file.size);response.writeHead(416);response.end();return;}
      response.statusCode=range.status;if(range.status===206)response.setHeader('content-range',`bytes ${range.start}-${range.end-1}/${file.size}`);response.setHeader('content-length',range.end-range.start);
      if(request.method==='HEAD'){response.end();return;}
      await pipeline(Readable.from(file.chunks(downloadSignal,range.start,range.end),{objectMode:false,highWaterMark:65536}),response,{signal:downloadSignal});
     });return;
    }
    if(isDownload||isConfigDownload){
     // Source copy, generator and transport each hold bounded chunks. Kernel
     // snapshot content has an independent owner quota, not this JS buffer pool.
     const budget=3*65536;if(budget>this.#maximumOutputBytes-this.#outputBytes)throw new ApiError(429,'Response buffer capacity exceeded');this.#outputBytes+=budget;outputReserved=budget;
     const downloads=isConfigDownload?this.#options.configFiles!:nativeUploads!;
     await downloads.download(path,context,async(file,downloadSignal)=>{
      const etag='"'+file.sha256+'"';response.setHeader('content-type','application/octet-stream');response.setHeader('cache-control','private, no-cache');response.setHeader('x-content-type-options','nosniff');response.setHeader('etag',etag);response.setHeader('accept-ranges','bytes');
      const encoded=encodeURIComponent(file.record.name).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
      const fallback=isConfigDownload?'config.txt':file.record.id+'.gcode';response.setHeader('content-disposition',`attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`);
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
     const download=isNativeThumbnail?await nativeUploads!.resolveThumbnail(path,context):await this.#options.thumbnails!.resolve(path,context);signal.throwIfAborted();
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
    let result:string|null;if(isRPC)result=await this.#rpc.dispatch(body,context);else{const endpoints=this.#options.endpoints!,value=await endpoints.invoke(path,request.method!,endpoints.parse(path,query,body,request.headers['content-type']??''),context);if(endpoints.wrapResult(path))result=JSON.stringify({result:value});else if(value===null){response.statusCode=204;result=null;}else result=JSON.stringify(value);}signal.throwIfAborted();
    if(result!==null&&Buffer.byteLength(result)>maxBytes){this.#error(response,500,'Response too large');return;}
    if(!response.destroyed){if(result!==null)response.setHeader('content-type','application/json; charset=UTF-8');if(completion){const sent=await new Promise<boolean>(resolve=>{const closed=()=>{response.off('finish',finished);resolve(false);},finished=()=>{response.off('close',closed);resolve(true);};response.once('close',closed);response.once('finish',finished);response.end(result??undefined);});if(!completion.complete(sent))response.destroy(completion.error);}else response.end(result??undefined);}
   }catch(error){
    // Early multipart policy rejection can otherwise close the TCP connection
    // while fetch is still writing the body, hiding a valid 401 behind EPIPE.
    // Keep the existing request slot and buffer reservation during this wait.
    if(isUpload&&reserved>=65536&&!response.headersSent)await discardRejectedUploadBody(request,signal);
    if(signal.aborted)this.#error(response,503,'Request cancelled');else if(!isRPC&&error instanceof ApiError)this.#error(response,Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:500,error.message,error.data);else this.#error(response,isRPC?400:500,isRPC?'Invalid request body':'Internal Server Error');}
   finally{if(completion&&!completion.complete(false))response.destroy(completion.error);this.#buffered-=reserved;this.#outputBytes-=outputReserved;signal.removeEventListener('abort',cancel);response.off('close',disconnected);}
  },parent.signal);
 }
 #connected(request:IncomingMessage,socket:WebSocket):void{
  const id=this.#nextId++;if(!Number.isSafeInteger(id)){socket.terminate();return;}
  const peer:Peer={socket,request,abort:new AbortController(),active:0,alive:true};this.#peers.set(id,peer);this.#clients.add(id);
  if(this.#notifications)this.#notifications.add(id,{signal:peer.abort.signal,authorize:(method,params,signal)=>this.#options.authorizeNotification!(method,params,{request,transport:'websocket',connectionId:id,signal,useXheaders:this.#options.useXheaders,routePrefix:this.#options.routePrefix??''}),send:message=>this.#send(peer,message),disconnect:reason=>{peer.abort.abort(reason);socket.terminate();}});
  if(this.#clientCalls)this.#clientCalls.add(id,{signal:peer.abort.signal,authorize:(method,params,signal)=>this.#options.authorizeClientCall!(method,params,{request,transport:'websocket',connectionId:id,signal,useXheaders:this.#options.useXheaders,routePrefix:this.#options.routePrefix??''}),send:message=>this.#send(peer,message),disconnect:reason=>{peer.abort.abort(reason);socket.terminate();}});
  if(this.#clientRequests)this.#clientRequests.add(id,{signal:peer.abort.signal,authorize:(method,params,signal)=>this.#options.authorizeClientRequest!(method,params,{request,transport:'websocket',connectionId:id,signal,useXheaders:this.#options.useXheaders,routePrefix:this.#options.routePrefix??''}),send:message=>this.#send(peer,message)});
  socket.on('error',()=>socket.terminate());socket.on('pong',()=>{peer.alive=true;});socket.on('close',()=>{peer.abort.abort(new Error('WebSocket client disconnected'));this.#peers.delete(id);const client=this.#clients.remove(id);if(client?.identity?.type==='agent')this.#agentEvent(id,{agent:client.identity.name,event:'disconnected'});});
  socket.on('message',data=>{
   const size=Array.isArray(data)?data.reduce((n,b)=>n+b.byteLength,0):data.byteLength;
   const decoded=this.#clientRequests?.acceptFrame(id,bytes(data));if(decoded&&decoded.value===undefined)return;
   if(this.#buffered+size>this.#maxBuffered){peer.abort.abort(new Error('Request buffer capacity exceeded'));socket.terminate();return;}
   if(this.#phase!=='listening'||peer.active>=this.#perSocket||this.#requests.size>=this.#maxRequests){peer.abort.abort(new Error('WebSocket request capacity exceeded'));socket.terminate();return;}
   const nativeGenerationSignal=this.#nativeLifetime,nativeGenerationRetiredAtAdmission=!!nativeGenerationSignal?.aborted;
   peer.active++;this.#buffered+=size;this.#launch(async signal=>{let completion:ResponseCompletion|undefined;const cancelled=()=>socket.terminate();signal.addEventListener('abort',cancelled,{once:true});try{signal.throwIfAborted();const context=this.#context(request,'websocket',signal,id,nativeGenerationSignal,nativeGenerationRetiredAtAdmission);context.afterResponse=callback=>{(completion??=new ResponseCompletion(signal)).add(callback);};const result=decoded?await this.#rpc.dispatchValue(decoded.value,context):await this.#rpc.dispatch(bytes(data),context);signal.throwIfAborted();const sent=result===null||this.#send(peer,result);if(completion&&!completion.complete(sent))socket.terminate();}finally{if(completion&&!completion.complete(false))socket.terminate();signal.removeEventListener('abort',cancelled);peer.active--;this.#buffered-=size; }},peer.abort.signal);
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
  const serverClosed=(async()=>{await this.#opening?.catch(()=>{});await Promise.all([this.#server,...this.#secure?[this.#secure]:[]].map(server=>this.#closeServer(server)));})();
  let timeout:ReturnType<typeof setTimeout>|undefined;
  this.#close=Promise.race([Promise.all([serverClosed,clientCallsClosed,notificationsClosed,clientRequestsClosed,...this.#requests.values()]),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Network tasks did not stop before shutdown deadline')),this.#shutdownTimeout);})]).then(()=>{this.#phase='closed';this.#rpc.remove('server.websocket.id');this.#rpc.remove('server.connection.identify');for(const client of this.#clients.all())this.#clients.remove(client.id);this.#ws.close();}).finally(()=>{clearTimeout(timeout);this.#close=undefined;});return this.#close;
 }
}
