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
import {JsonRpcDispatcher,ApiError,encodeNotification,type Json,type RpcContext} from './rpc.ts';
export interface NetworkAuthorization {
 request:IncomingMessage;transport:'http'|'websocket';connectionId?:number;signal:AbortSignal;
}
export interface MoonrakerNetworkOptions {
 endpoints?:EndpointRegistry;
 authorize(method:string,params:Readonly<Record<string,Json>>,request:NetworkAuthorization):void|Promise<void>;
 /** Required to enable broadcasts; separate from inbound method authorization. */
 authorizeNotification?(method:string,params:readonly Json[],request:NetworkAuthorization):void|Promise<void>;
 /** Required to associate an HTTP subscription with a different transport.
  * Check authenticated ownership/permissions of source and target explicitly. */
 authorizeSubscriptionConnection?(source:NetworkAuthorization,target:NetworkAuthorization):void|Promise<void>;
 notificationLimits?:NotificationLimits;
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
 #clients=new RemoteClients();#notifications:NotificationFanout|undefined;#clientRequests:ClientRequests|undefined;
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
 get status(){return {phase:this.#phase,connections:this.#peers.size,requests:this.#requests.size,bufferedBytes:this.#buffered,outputBufferedBytes:this.#outputBytes,notifications:this.#notifications?.status??null,clientRequests:this.#clientRequests?.status??null};}
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
 #error(response:ServerResponse,status:number,message:string):void{if(response.destroyed||response.writableEnded)return;response.writeHead(status,{'content-type':'application/json; charset=UTF-8'});response.end(JSON.stringify({error:{code:status,message}}));}
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
  const url=request.url??'',at=url.indexOf('?'),path=at<0?url:url.slice(0,at),query=at<0?'':url.slice(at+1),isRPC=path==='/server/jsonrpc',allowed=isRPC?['POST']:this.#options.endpoints?.allowed(path);
  if(!allowed){this.#error(response,404,'Not Found');return;}
  if(!this.#origin(request)){this.#error(response,403,'Origin not allowed');return;}
  if(request.headers.origin&&this.#origins.has(request.headers.origin)){response.setHeader('access-control-allow-origin',request.headers.origin);response.setHeader('vary','Origin');response.setHeader('access-control-allow-credentials','true');}
  if(request.method==='OPTIONS'){response.writeHead(204,{'access-control-allow-methods':[...allowed,'OPTIONS'].join(', '),'access-control-allow-headers':'Content-Type, Authorization, X-Api-Key'});response.end();return;}
  if(!allowed.some(v=>v===request.method)){this.#error(response,405,'Method Not Allowed');return;}
  if(isRPC&&!request.headers['content-type']?.trim().startsWith('application/json')){this.#error(response,400,'Invalid content type, application/json required');return;}
  if(this.#requests.size>=this.#maxRequests){this.#error(response,429,'Too many active requests');return;}
  const parent=new AbortController(),disconnected=()=>{if(!response.writableEnded)parent.abort(new Error('HTTP client disconnected'));};response.once('close',disconnected);
  this.#launch(async signal=>{
   let reserved=0,completion:ResponseCompletion|undefined;const cancel=()=>{this.#error(response,503,'Request cancelled');request.destroy();};signal.addEventListener('abort',cancel,{once:true});
   try{
    signal.throwIfAborted();const chunks:Buffer[]=[];let length=0;
    for await(const chunk of request){signal.throwIfAborted();length+=chunk.length;if(length>maxBytes){this.#error(response,413,'Request too large');return;}if(this.#buffered+chunk.length>this.#maxBuffered){this.#error(response,429,'Request buffer capacity exceeded');return;}this.#buffered+=chunk.length;reserved+=chunk.length;chunks.push(chunk);}
    const body=Buffer.concat(chunks),context=this.#context(request,'http',signal);
    context.afterResponse=callback=>{(completion??=new ResponseCompletion(signal)).add(callback);};
    context.subscriptionConnection=()=>this.#subscriptionConnection(request,body,signal);
    const result=isRPC?await this.#rpc.dispatch(body,context):JSON.stringify({result:await this.#options.endpoints!.invoke(path,request.method!,this.#options.endpoints!.parse(path,query,body,request.headers['content-type']??''),context)});signal.throwIfAborted();
    if(result!==null&&Buffer.byteLength(result)>maxBytes){this.#error(response,500,'Response too large');return;}
    if(!response.destroyed){if(result!==null)response.setHeader('content-type','application/json; charset=UTF-8');if(completion){const sent=await new Promise<boolean>(resolve=>{const closed=()=>{response.off('finish',finished);resolve(false);},finished=()=>{response.off('close',closed);resolve(true);};response.once('close',closed);response.once('finish',finished);response.end(result??undefined);});if(!completion.complete(sent))response.destroy(completion.error);}else response.end(result??undefined);}
   }catch(error){if(signal.aborted)this.#error(response,503,'Request cancelled');else if(!isRPC&&error instanceof ApiError)this.#error(response,Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:500,error.message);else this.#error(response,isRPC?400:500,isRPC?'Invalid request body':'Internal Server Error');}
   finally{if(completion&&!completion.complete(false))response.destroy(completion.error);this.#buffered-=reserved;signal.removeEventListener('abort',cancel);response.off('close',disconnected);}
  },parent.signal);
 }
 #connected(request:IncomingMessage,socket:WebSocket):void{
  const id=this.#nextId++;if(!Number.isSafeInteger(id)){socket.terminate();return;}
  const peer:Peer={socket,request,abort:new AbortController(),active:0,alive:true};this.#peers.set(id,peer);this.#clients.add(id);
  if(this.#notifications)this.#notifications.add(id,{signal:peer.abort.signal,authorize:(method,params,signal)=>this.#options.authorizeNotification!(method,params,{request,transport:'websocket',connectionId:id,signal}),send:message=>this.#send(peer,message),disconnect:reason=>{peer.abort.abort(reason);socket.terminate();}});
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
 dispatchNotification(id:number,method:string,params:readonly Json[]):DeliveryReport|Promise<DeliveryReport>{if(!this.#notifications)throw new ApiError(503,'Notification authorization is required');if(this.#phase!=='listening')return Promise.reject(new Error('Network is not listening'));return this.#notifications.dispatchTo(id,method,params);}
 requestClient(id:number,method:string,params:ClientArguments=null,options:ClientRequestOptions={}){if(!this.#clientRequests)throw new ApiError(503,'Client request authorization is required');if(this.#phase!=='listening')throw new ApiError(503,'Network is not listening');return this.#clientRequests.request(id,method,params,options);}
 broadcast(method:string,params:readonly Json[],excluded:readonly number[]=[]):Promise<DeliveryReport>{if(!this.#notifications)throw new ApiError(503,'Notification authorization is required');if(this.#phase!=='listening')return Promise.reject(new Error('Network is not listening'));return this.#notifications.publish(method,params,excluded);}
 #agentEvent(id:number,event:Json):void{if(this.#notifications&&this.#phase==='listening')void this.broadcast('notify_agent_event',[event],[id]).catch(()=>{});}
 /** Abort requests and wait for cooperative handlers. Ignored cancellation is
  * reported after the shutdown deadline, never silently reported as drained. */
 close():Promise<void>{
  if(this.#close)return this.#close;if(this.#phase==='closed')return Promise.resolve();this.#phase='closing';clearInterval(this.#heartbeat);
  const clientRequestsClosed=this.#clientRequests?.close()??Promise.resolve();
  const notificationsClosed=this.#notifications?.close()??Promise.resolve();
  for(const abort of this.#requests.keys())abort.abort(new Error('Moonraker network shutting down'));for(const peer of this.#peers.values()){peer.abort.abort(new Error('Moonraker network shutting down'));peer.socket.terminate();}for(const socket of this.#sockets)socket.destroy();
  const serverClosed=(async()=>{await this.#opening?.catch(()=>{});await new Promise<void>(resolve=>{if(!this.#server.listening)resolve();else this.#server.close(()=>resolve());});})();
  let timeout:ReturnType<typeof setTimeout>|undefined;
  this.#close=Promise.race([Promise.all([serverClosed,notificationsClosed,clientRequestsClosed,...this.#requests.values()]),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Network tasks did not stop before shutdown deadline')),this.#shutdownTimeout);})]).then(()=>{this.#phase='closed';this.#rpc.remove('server.websocket.id');this.#rpc.remove('server.connection.identify');for(const client of this.#clients.all())this.#clients.remove(client.id);this.#ws.close();}).finally(()=>{clearTimeout(timeout);this.#close=undefined;});return this.#close;
 }
}
