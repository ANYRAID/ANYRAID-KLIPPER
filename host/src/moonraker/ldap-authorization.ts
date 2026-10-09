// Directory authentication contracts from pinned Moonraker ldap.py; GPL-3.0-or-later.
import {connect as connectTcp,isIP,type Socket} from 'node:net';
import {connect as connectTls,type TLSSocket} from 'node:tls';
import {Client,type ClientOptions} from 'ldapts';
import {ApiError} from './rpc.ts';
import type {LdapAuthenticator} from './local-user-authorization.ts';
export interface LdapOptions {
 host:string;port?:number;secure?:boolean;baseDn:string;groupDn?:string;
 bindDn?:string;bindPassword?:string;userFilter?:string;
 membershipAttribute?:'memberOf'|'isMemberOf';checkDnCase?:boolean;activeDirectory?:boolean;
 /** Native resource limits. TLS always validates the certificate and host. */
 ca?:string;timeoutMs?:number;maxResponseBytes?:number;
}
function validText(value:unknown,max:number,empty=false):value is string{return typeof value==='string'&&value.isWellFormed()&&(empty||value.length>0)&&Buffer.byteLength(value)<=max&&!value.includes('\0');}
function options(input:LdapOptions):Readonly<LdapOptions>{
 if(!input||!validText(input.host,253)||/[\s/@?#]/u.test(input.host)||!validText(input.baseDn,65535))throw new ApiError(400,'Invalid LDAP settings');
 for(const name of ['secure','checkDnCase','activeDirectory'] as const)if(input[name]!==undefined&&typeof input[name]!=='boolean')throw new ApiError(400,'Invalid LDAP settings');
 for(const name of ['port','timeoutMs','maxResponseBytes'] as const)if(input[name]!==undefined&&(!Number.isSafeInteger(input[name])||input[name]!<1||input[name]!>(name==='port'?65535:name==='timeoutMs'?60000:16*1024*1024)))throw new ApiError(400,'Invalid LDAP resource limit');
 for(const name of ['groupDn','bindDn','bindPassword','userFilter','ca'] as const)if(input[name]!==undefined&&!validText(input[name],name==='ca'?1024*1024:65535,true))throw new ApiError(400,'Invalid LDAP settings');
 if(input.bindDn&&!input.bindPassword||input.bindPassword&&!input.bindDn||input.ca&&!input.secure||input.userFilter!==undefined&&!input.userFilter.includes('USERNAME')||input.membershipAttribute!==undefined&&!['memberOf','isMemberOf'].includes(input.membershipAttribute))throw new ApiError(400,'Invalid LDAP settings');
 // A host is a host, never a URL containing credentials, a path or a query.
 try{const url=new URL(`ldap://${input.host}:${input.port??389}`);if(!url.hostname||url.username||url.password||url.pathname||url.search||url.hash)throw Error();}catch{throw new ApiError(400,'Invalid LDAP host');}
 return Object.freeze({...input});
}
/** RFC4515 escaping of user-supplied assertion values, never filter syntax. */
export function escapeLdapFilter(value:string):string{return value.replace(/[\0()*\\]/gu,character=>'\\'+character.charCodeAt(0).toString(16).padStart(2,'0'));}
function cancelled<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 signal.throwIfAborted();let abort=()=>{};
 const stop=new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
 return Promise.race([work,stop]).finally(()=>signal.removeEventListener('abort',abort));
}
/** Per-login sockets, serialized bounded operations, no remembered bind replay.
 * This independent dependency does not enable LDAP in standard server config. */
export class LdapAuthorization implements LdapAuthenticator {
 readonly #options:Readonly<LdapOptions>;readonly #lifetime=new AbortController();
 #tail:Promise<unknown>=Promise.resolve();#pending=0;#closed=false;
 constructor(input:LdapOptions){this.#options=options(input);}
 get status(){return {closed:this.#closed,pending:this.#pending};}
 authenticate(username:string,password:string,request:AbortSignal):Promise<void>{
  if(this.#closed)throw new ApiError(503,'LDAP authorization closed');request.throwIfAborted();
  if(!validText(username,256)||!validText(password,4096))throw new ApiError(400,'Invalid LDAP credentials');
  if(this.#pending>=32)throw new ApiError(429,'LDAP authorization queue is full');
  const lifetime=AbortSignal.any([request,this.#lifetime.signal]);this.#pending++;
  const run=this.#tail.then(()=>{lifetime.throwIfAborted();return this.#authenticate(username,password,lifetime);});
  this.#tail=run.catch(()=>{});void run.finally(()=>{this.#pending--;}).catch(()=>{});
  return cancelled(run,lifetime);
 }
 async #authenticate(username:string,password:string,lifetime:AbortSignal){
  const config=this.#options,timeout=config.timeoutMs??10000;
  const budget=new AbortController(),signal=AbortSignal.any([lifetime,AbortSignal.timeout(timeout),budget.signal]),clients:Client[]=[],sockets=new Set<Socket|TLSSocket>();
  let received=0;
  const stop=()=>{for(const socket of sockets)socket.destroy(new Error('LDAP operation stopped'));};
  signal.addEventListener('abort',stop,{once:true});
  const create=()=>{
   let created=false;
   const capture=(socket:Socket|TLSSocket)=>{
    sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
    socket.prependListener('data',(data:Buffer)=>{received+=data.length;if(received>(config.maxResponseBytes??1024*1024))budget.abort(new Error('LDAP response limit exceeded'));});
    // Gate the library's data callback before parsing. Destroying a socket in
    // a prepended listener alone does not stop other listeners for that chunk.
    // Malformed BER/parser exceptions must reject this login, not the process.
    const on=socket.on.bind(socket);
    socket.on=((event:string|symbol,listener:(...args:any[])=>void)=>event==='data'?on(event,(data:Buffer)=>{
     if(signal.aborted)return;try{listener.call(socket,data);}catch{budget.abort(new Error('LDAP response parsing failed'));}
    }):on(event,listener)) as typeof socket.on;
    return socket;
   };
   const beforeConnect=()=>{signal.throwIfAborted();if(created)throw Error('LDAP session reconnect refused');created=true;};
   const transport:ClientOptions={url:`${config.secure?'ldaps':'ldap'}://${config.host}:${config.port??(config.secure?636:389)}`,connectTimeout:Math.min(timeout,10000),timeout,autoRebind:false,
    createConnection:((...args:Parameters<typeof connectTcp>)=>{beforeConnect();return capture(connectTcp(...args));}) as typeof connectTcp,
    createSecureConnection:((...args:Parameters<typeof connectTls>)=>{beforeConnect();return capture(connectTls(...args));}) as typeof connectTls,
    ...config.secure?{tlsOptions:{minVersion:'TLSv1.2',rejectUnauthorized:true,...!isIP(config.host.replace(/^\[|\]$/g,''))?{servername:config.host}:{},...config.ca?{ca:config.ca}:{}}}:{}};
   const client=new Client(transport);clients.push(client);return client;
  };
  const work=async()=>{
   const client=create();await client.bind(config.bindDn??'',config.bindPassword??'');signal.throwIfAborted();
   const escaped=escapeLdapFilter(username),filter=config.userFilter?.replaceAll('USERNAME',escaped)??`(&(objectClass=Person)(${config.activeDirectory?'sAMAccountName':'uid'}=${escaped}))`;
   const result=await client.search(config.baseDn,{scope:'sub',filter,attributes:config.groupDn?[config.membershipAttribute??'memberOf']:['1.1'],sizeLimit:1024,timeLimit:Math.max(1,Math.ceil(timeout/1000)),paged:false});signal.throwIfAborted();
   const entry=result.searchEntries[0];if(!entry||!validText(entry.dn,65535))throw Error('LDAP user missing');
   try{await client.bind(entry.dn,password);}catch{
    signal.throwIfAborted();await client.unbind().catch(()=>{});
    // Some directories reject rebind; retry only a fresh authenticated user session.
    await create().bind(entry.dn,password);
   }
   signal.throwIfAborted();
   if(config.groupDn){
    const attribute=config.membershipAttribute??'memberOf';
    const key=Object.keys(entry).find(name=>name.toLowerCase()===attribute.toLowerCase());
    const value=key===undefined?[]:entry[key],members=Array.isArray(value)?value:[value];
    const normalize=(dn:string)=>config.checkDnCase===false?dn.toLowerCase():dn;
    if(!members.some(member=>typeof member==='string'&&normalize(member)===normalize(config.groupDn!)))throw Error('LDAP group mismatch');
   }
  };
  try{signal.throwIfAborted();await cancelled(work(),signal);signal.throwIfAborted();}
  catch{lifetime.throwIfAborted();throw new ApiError(401,'LDAP authentication failed');}
  finally{signal.removeEventListener('abort',stop);stop();await Promise.allSettled(clients.map(client=>client.unbind()));}
 }
 async close(){this.#closed=true;this.#lifetime.abort(new ApiError(503,'LDAP authorization closed'));await this.#tail;}
}
