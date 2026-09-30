import {ApiError,type RpcContext} from './rpc.ts';
import type {EndpointHandler,EndpointWrapper} from './endpoints.ts';
/** Each route captures its device generation at registration. Authorization can
 * finish after retirement, but cannot admit a call into that old generation.
 * Only accepted asynchronous handlers are tracked; drain never starts hardware. */
export class NativeRequestScope {
 readonly #abort=new AbortController();readonly #pending=new Set<Promise<unknown>>();
 readonly #handlers=new Set<{handler:EndpointHandler|undefined}>();
 get signal(){return this.#abort.signal;}
 get status(){return {closed:this.signal.aborted,pending:this.#pending.size};}
 readonly wrap:EndpointWrapper=(path,handler)=>{
  if(!(path.startsWith('/printer/')&&path!=='/printer/info'&&!path.startsWith('/printer/host/')||path.startsWith('/server/history/')||path.startsWith('/server/files/')))return handler;
  return this.#bind(handler);
 };
 #bind(handler:EndpointHandler):EndpointHandler{
  if(this.signal.aborted)return ()=>{throw new ApiError(503,'Native printer generation has retired');};
  const owner={handler:handler as EndpointHandler|undefined};this.#handlers.add(owner);return (params,verb,context)=>{
  this.signal.throwIfAborted();context.signal.throwIfAborted();context.nativeGenerationSignal?.throwIfAborted();
  if(context.nativeGenerationSignal&&context.nativeGenerationSignal!==this.signal)throw new ApiError(503,'Native request belongs to another generation');
  const bound:RpcContext={...context,signal:AbortSignal.any([context.signal,this.signal])};
  const value=owner.handler!(params,verb,bound);
  if(!value||typeof value!=='object'||!('then' in value)||typeof value.then!=='function'){bound.signal.throwIfAborted();return value;}
  const task=Promise.resolve(value).then(result=>{bound.signal.throwIfAborted();return result;});
  this.#pending.add(task);void task.then(()=>this.#pending.delete(task),()=>this.#pending.delete(task));return task;
 };}
 retire(){for(const owner of this.#handlers)owner.handler=undefined;this.#handlers.clear();this.#abort.abort(new ApiError(503,'Native printer generation has retired'));}
 async drain(){this.retire();await Promise.allSettled([...this.#pending]);}
}
