import {ApiError,type Json} from './rpc.ts';
export type ClientType='web'|'mobile'|'desktop'|'display'|'bot'|'agent'|'other';
export interface ClientIdentity {readonly name:string;readonly version:string;readonly type:ClientType;readonly url:string;}
export interface RemoteClient {readonly id:number;readonly identity:ClientIdentity|null;}
const types=new Set<string>(['web','mobile','desktop','display','bot','agent','other']);
function field(params:Readonly<Record<string,Json>>,name:string):string{
 if(!Object.hasOwn(params,name))throw new ApiError(400,`No data for argument: ${name}`);
 const value=params[name];if(typeof value!=='string'||value.length>4096)throw new ApiError(400,`Argument [${name}] must be a string of at most 4096 characters`);return value;
}
/** Per-transport live identities, never an authentication or credential store.
 * All mutations are synchronous so concurrent RPC authorizations cannot commit
 * two identities to the same connection. Agent names are case-sensitive. */
export class RemoteClients {
 #clients=new Map<number,RemoteClient>();#agents=new Map<string,number>();
 add(id:number):void{if(!Number.isSafeInteger(id)||id<1||this.#clients.has(id))throw new Error('Invalid or duplicate client ID');this.#clients.set(id,Object.freeze({id,identity:null}));}
 get(id:number):RemoteClient|undefined{return this.#clients.get(id);}
 all():readonly RemoteClient[]{return Object.freeze([...this.#clients.values()]);}
 byName(name:string):readonly RemoteClient[]{return name?Object.freeze([...this.#clients.values()].filter(c=>c.identity?.name.toLowerCase()===name.toLowerCase())):Object.freeze([]);}
 byType(type:string):readonly RemoteClient[]{return type?Object.freeze([...this.#clients.values()].filter(c=>c.identity?.type===type.toLowerCase())):Object.freeze([]);}
 unidentified():readonly RemoteClient[]{return Object.freeze([...this.#clients.values()].filter(c=>!c.identity));}
 agent(name:string):RemoteClient|undefined{const id=this.#agents.get(name);return id===undefined?undefined:this.#clients.get(id);}
 identify(id:number,params:Readonly<Record<string,Json>>):RemoteClient{
  const previous=this.#clients.get(id);if(!previous)throw new ApiError(400,'Connection is no longer available');if(previous.identity)throw new ApiError(400,'Connection already identified');
  const name=field(params,'client_name'),version=field(params,'version'),type=field(params,'type').toLowerCase(),url=field(params,'url');
  if(!types.has(type))throw new ApiError(400,'Invalid Client Type');
  if(type==='agent'&&this.#agents.has(name))throw new ApiError(400,'Agent already registered and connected');
  const identity:ClientIdentity=Object.freeze({name,version,type:type as ClientType,url}),client=Object.freeze({id,identity});
  if(type==='agent')this.#agents.set(name,id);this.#clients.set(id,client);return client;
 }
 remove(id:number):RemoteClient|undefined{const client=this.#clients.get(id);if(!client)return;this.#clients.delete(id);if(client.identity?.type==='agent'&&this.#agents.get(client.identity.name)===id)this.#agents.delete(client.identity.name);return client;}
}
