import {parseRequestJson,JsonNumberError} from './json.ts';
// Dispatch behavior based on Moonraker common.JsonRPC, pinned in contracts/.
// Original Copyright (C) 2020 Eric Callahan. GPL-3.0-or-later.
export type Json=null|boolean|number|string|Json[]|{[key:string]:Json};
export type RpcId=number|string|null;
export type Transport='http'|'websocket'|'unix'|'mqtt';
export interface AuthorizedUser {readonly username:string;}
export type AuthorizationResult=AuthorizedUser|null|void;
export interface RpcContext {
  /** Per-method identity from the successful authorization result, never params. */
  readonly user?:AuthorizedUser;
  /** Network-frame handoff, after the complete batch response. Synchronous
   * callback; false on cancellation/failure. Not a remote receipt guarantee. */
  afterResponse?(callback:(sent:boolean)=>void):void;
  /** HTTP-only, explicitly authorized association with a live WebSocket. */
  subscriptionConnection?():Promise<{id:number;signal:AbortSignal}>;
  transport:Transport;
  signal:AbortSignal;
  /** Internal device lifetime captured at network admission, never client data.
   * Process methods ignore it; native handlers reject stale request bodies. */
  nativeGenerationSignal?:AbortSignal;
  connectionId?:number;
  /** Required authorization hook, called before each method invocation. */
  authorize(method:string,params:Readonly<Record<string,Json>>):AuthorizationResult|Promise<AuthorizationResult>;
  receiveResponse?(id:RpcId,response:{result?:Json;error?:Json}):void;
}
/** Copy only the non-secret identity into a fresh method context. A shared
 * transport/batch context must never retain another request's identity. */
export function authorizedContext(context:RpcContext,value:AuthorizationResult):RpcContext{
  context.signal.throwIfAborted();
  let user:AuthorizedUser|undefined;
  if(value!==undefined&&value!==null){
    if(typeof value!=='object'||Array.isArray(value)||typeof value.username!=='string'||!value.username||!value.username.isWellFormed()||value.username.includes('\0')||Buffer.byteLength(value.username)>4096)throw new ApiError(500,'Invalid authorization identity');
    user=Object.freeze({username:value.username});
  }
  return {...context,user};
}
export class ApiError extends Error {
  readonly status:number;
  readonly data?:Json;
  constructor(status:number,message:string,data?:Json) {super(message);this.status=status;this.data=data;}
}
type Handler=(params:Readonly<Record<string,Json>>,context:RpcContext)=>Json|Promise<Json>;
interface Method {transports:ReadonlySet<Transport>;handler:Handler;}
const isObject=(value:unknown):value is Record<string,Json>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const validId=(value:unknown):value is RpcId=>value===null||typeof value==='string'||(typeof value==='number'&&Number.isSafeInteger(value));
const failure=(code:number,message:string,id:RpcId=null,data?:Json):Json=>({jsonrpc:'2.0',error:{code,message,...(data===undefined?{}:{data})},id});
export class JsonRpcDispatcher {
  #methods=new Map<string,Method>();
  register(name:string,transports:readonly Transport[],handler:Handler):void {
    if(!name||!transports.length||this.#methods.has(name)) throw new Error('Invalid or duplicate RPC registration');
    this.#methods.set(name,{transports:new Set(transports),handler});
  }
  has(name:string):boolean{return this.#methods.has(name);}
  remove(name:string):void {this.#methods.delete(name);}
  async dispatch(input:string|Uint8Array,context:RpcContext):Promise<string|null> {
    const size=typeof input==='string'?Buffer.byteLength(input):input.byteLength;
    if(size>1024*1024) return JSON.stringify(failure(-32600,'Request too large'));
    let value:unknown;
    try {value=parseRequestJson(typeof input==='string'?input:new TextDecoder('utf-8',{fatal:true}).decode(input));}
    catch(error) {return JSON.stringify(error instanceof JsonNumberError?failure(-32600,error.message):failure(-32700,'Parse error'));}
    return this.dispatchValue(value,context);
  }
  /** Transport-owned decoded input. The transport must enforce the wire byte
   * limit before decoding; shape/depth limits still apply here. */
  async dispatchValue(value:unknown,context:RpcContext):Promise<string|null> {
    // Validate shape depth before recursively passing arbitrary client data to handlers.
    try {validateJson(value);} catch {return JSON.stringify(failure(-32600,'Invalid Request'));}
    if(Array.isArray(value)) {
      if(value.length>256) return JSON.stringify(failure(-32600,'Batch too large'));
      const results:Json[]=[];
      // Preserve upstream execution ordering for state-changing calls in a batch.
      for(const item of value) {
        const result=await this.#process(item,context);if(result!==null) results.push(result);
      }
      return results.length?JSON.stringify(results):null;
    }
    const result=await this.#process(value,context);
    return result===null?null:JSON.stringify(result);
  }
  async #process(value:unknown,context:RpcContext):Promise<Json|null> {
    if(!isObject(value)) return failure(-32600,'Invalid Request');
    const id=value.id??null;
    if(!validId(id)||value.jsonrpc!=='2.0') return failure(-32600,'Invalid Request',validId(id)?id:null);
    if(!Object.hasOwn(value,'method')) {
      if(id!==null && context.receiveResponse && (Object.hasOwn(value,'result')!==Object.hasOwn(value,'error')))
        context.receiveResponse(id,Object.hasOwn(value,'result')?{result:value.result}:{error:value.error});
      return null;
    }
    if(typeof value.method!=='string') return failure(-32600,'Invalid Request',id);
    const method=this.#methods.get(value.method);
    if(!method) return failure(-32601,'Method not found',id);
    if(!method.transports.has(context.transport)) return failure(-32601,`Method not found for transport ${context.transport.toUpperCase()}`,id);
    const params=value.params===undefined?{}:value.params;
    if(!isObject(params)) return failure(-32602,'Invalid params:',id);
    try {
      context.signal.throwIfAborted();
      const authorized=authorizedContext(context,await context.authorize(value.method,params));
      const result=await method.handler(params,authorized);
      context.signal.throwIfAborted();
      validateJson(result);
      return id===null?null:{jsonrpc:'2.0',result,id};
    } catch(error) {
      // Keep Moonraker's status mapping, including error replies to notifications.
      if(error instanceof ApiError) return failure(error.status===404?-32601:error.status===401?-32602:error.status,error.message,id,error.data);
      if(error instanceof TypeError) return failure(-32602,`Invalid params:\n${error.message}`,id);
      // Internal exception details can contain paths or credentials; do not expose them.
      return failure(500,context.signal.aborted?'Request cancelled':'Internal Server Error',id);
    }
  }
}
export function validateJson(value:unknown):asserts value is Json {
  // Depth is checked on entry before any further descent. The old
  // explicit stack allocated a tuple for every value and every leave marker.
  let count=0;const ancestors=new Set<object>();
  function visit(item:unknown,depth:number):void {
    if(++count>100000||depth>64) throw new Error('JSON structure limit');
    if(item===null||typeof item==='string'||typeof item==='boolean') return;
    if(typeof item==='number'&&Number.isFinite(item)) return;
    if(typeof item!=='object'||!item) throw new Error('Non-JSON result');
    if(ancestors.has(item)) throw new Error('Cyclic JSON result');
    if(!Array.isArray(item)&&Object.getPrototypeOf(item)!==Object.prototype&&Object.getPrototypeOf(item)!==null) throw new Error('Non-JSON object');
    ancestors.add(item);
    for(const child of Object.values(item)) visit(child,depth+1);
    ancestors.delete(item);
  }
  visit(value,0);
}

export function encodeNotification(method:string,params:readonly Json[]):string {
  if(!/^notify_[A-Za-z0-9_]+$/.test(method)||method.length>256)throw new Error('Invalid notification name');
  if(!Array.isArray(params))throw new Error('Notification parameters must be an array');
  validateJson(params);return JSON.stringify({jsonrpc:'2.0',method,...(params.length?{params}:{})});
}
