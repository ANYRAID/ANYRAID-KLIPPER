// Dispatch behavior based on Moonraker common.JsonRPC, pinned in contracts/.
// Original Copyright (C) 2020 Eric Callahan. GPL-3.0-or-later.
export type Json=null|boolean|number|string|Json[]|{[key:string]:Json};
export type RpcId=number|string|null;
export type Transport='http'|'websocket'|'unix'|'mqtt';
export interface RpcContext {
  transport:Transport;
  signal:AbortSignal;
  connectionId?:number;
  /** Required authorization hook, called before each method invocation. */
  authorize(method:string,params:Readonly<Record<string,Json>>):void|Promise<void>;
  receiveResponse?(id:RpcId,response:{result?:Json;error?:Json}):void;
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
  remove(name:string):void {this.#methods.delete(name);}
  async dispatch(input:string|Uint8Array,context:RpcContext):Promise<string|null> {
    const size=typeof input==='string'?Buffer.byteLength(input):input.byteLength;
    if(size>1024*1024) return JSON.stringify(failure(-32600,'Request too large'));
    let value:unknown;
    try {value=JSON.parse(typeof input==='string'?input:new TextDecoder('utf-8',{fatal:true}).decode(input));}
    catch {return JSON.stringify(failure(-32700,'Parse error'));}
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
      await context.authorize(value.method,params);
      context.signal.throwIfAborted();
      const result=await method.handler(params,context);
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
function validateJson(value:unknown):asserts value is Json {
  const pending:[unknown,number,boolean?][]=[[value,0]];let count=0;
  const seen=new Set<object>();
  while(pending.length) {
    const [item,depth,leaving]=pending.pop()!;
    if(leaving) {seen.delete(item as object);continue;}
    if(++count>100000||depth>64) throw new Error('JSON structure limit');
    if(item===null||typeof item==='string'||typeof item==='boolean') continue;
    if(typeof item==='number'&&Number.isFinite(item)) continue;
    if(typeof item!=='object'||!item) throw new Error('Non-JSON result');
    if(seen.has(item)) throw new Error('Cyclic JSON result');seen.add(item);
    if(!Array.isArray(item)&&Object.getPrototypeOf(item)!==Object.prototype&&Object.getPrototypeOf(item)!==null) throw new Error('Non-JSON object');
    pending.push([item,depth,true]);
    for(const child of Object.values(item)) pending.push([child,depth+1]);
  }
}

export function encodeNotification(method:string,params:readonly Json[]):string {
  if(!/^notify_[A-Za-z0-9_]+$/.test(method)||method.length>256)throw new Error('Invalid notification name');
  validateJson(params);return JSON.stringify({jsonrpc:'2.0',method,params});
}
