// Asynchronous callable/UI bridge for pinned Moonraker template.py.
// Original Copyright (C) 2021 Eric Callahan. GPL-3.0-or-later.
import {createRequire} from 'node:module';
import {ConfigurationError} from './config-source.ts';
import {bindSecretsTemplate,type SecretsStore} from './secrets.ts';
import {decodeTemplateCall,encodeTemplateValue,type TemplateCall,type TemplateValue} from './template-wire.ts';
interface Handle {addGlobal(name:string,value?:string):void;render(context:string,callables:string[],id:number,timeout:number):void;close():void;}
interface Executor {createTemplate(source:string,secrets:string,file:string,type:string,ui:boolean):Handle;respond(id:number,call:number,value?:string):boolean;respondFloat(id:number,call:number,value:number):boolean;cancel(id:number):void;close():void;}
/** Signal is created on first access and remains valid after the render ends. */
export interface TemplateInvocation extends TemplateCall {readonly signal:AbortSignal;}
export type TemplateCallable=(call:TemplateInvocation)=>TemplateValue|Promise<TemplateValue>;
export interface AsyncTemplateOptions {signal?:AbortSignal;timeoutMs?:number;callables?:ReadonlyMap<string,TemplateCallable>;}
interface Cancellation {controller?:AbortController;ended:boolean;reason?:unknown;}
interface Frame {lifetime:Cancellation;cancelled:boolean;callables:ReadonlyMap<string,TemplateCallable>;sequence:number;stop:(reason:unknown)=>void;finish:(output?:string)=>void;}
const strip=(text:string)=>text.replace(/^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,'');
const failure=()=>new ConfigurationError('Private asynchronous template operation failed');
const completedReason=new DOMException('Template render completed','AbortError');
function text(value:string,limit:number){if(typeof value!=='string'||!value.isWellFormed()||Buffer.byteLength(value)>limit)throw failure();}
function name(value:string){text(value,128);if(!value.length)throw failure();}
function end(lifetime:Cancellation,reason:unknown):void{if(lifetime.ended)return;lifetime.ended=true;lifetime.reason=reason;lifetime.controller?.abort(reason);}
class Invocation implements TemplateInvocation {
 readonly args:TemplateCall['args'];readonly kwargs:TemplateCall['kwargs'];readonly #lifetime:Cancellation;
 constructor(call:TemplateCall,lifetime:Cancellation){this.args=call.args;this.kwargs=call.kwargs;this.#lifetime=lifetime;Object.freeze(this);}
 get signal():AbortSignal{const lifetime=this.#lifetime;if(!lifetime.controller){lifetime.controller=new AbortController();if(lifetime.ended)lifetime.controller.abort(lifetime.reason);}return lifetime.controller.signal;}
}
/** Trusted component API. Native computation uses two dedicated threads;
 * callback capabilities remain on the Node event loop and receive cancellation.
 * Explicit close is required. This is not an OS process isolation boundary. */
export class MoonrakerAsyncTemplateOwner {
 #secrets:SecretsStore|undefined;#executor:Executor|undefined;#validation:Handle|undefined;
 readonly #handles=new Map<Handle,{ui:boolean;frames:Set<number>}>();
 readonly #globals=new Map<string,TemplateValue|TemplateCallable>();
 readonly #frames=new Map<number,Frame>();#next=0;
 constructor(secrets:SecretsStore){
  bindSecretsTemplate(secrets,()=>undefined);this.#secrets=secrets;
  try{const addon=createRequire(import.meta.url)('../../build/template.node') as {NativeTemplateExecutor:new(callback:(message:string)=>void)=>Executor};
   this.#executor=new addon.NativeTemplateExecutor(message=>{void this.#dispatch(message);});
   this.#validation=bindSecretsTemplate(secrets,data=>this.#executor!.createTemplate('',data.source,data.file,data.type,false));
  }catch{this.#validation?.close();this.#validation=undefined;this.#executor?.close();this.#executor=undefined;this.#secrets=undefined;throw failure();}
 }
 #check(){if(!this.#executor||!this.#secrets)throw new ConfigurationError('Template owner is closed');bindSecretsTemplate(this.#secrets,()=>undefined);return this.#executor;}
 addEnvironmentGlobal(key:string,value:TemplateValue|TemplateCallable):void{
  this.#check();name(key);if(this.#globals.size>=64||this.#globals.has(key))throw failure();
  const encoded=typeof value==='function'?undefined:encodeTemplateValue(value);
  // Validate native built-in collisions before updating existing environments.
  this.#validation!.addGlobal(key,encoded);
  for(const [handle,state] of this.#handles)if(!state.ui)handle.addGlobal(key,encoded);
  this.#globals.set(key,value);
 }
 createTemplate(source:string):MoonrakerAsyncTextTemplate{return this.#create(source,false);}
 createUiTemplate(source:string):MoonrakerAsyncTextTemplate{return this.#create(source,true);}
 #create(source:string,ui:boolean):MoonrakerAsyncTextTemplate{
  const executor=this.#check();text(source,65536);if(this.#handles.size>=64)throw failure();let handle:Handle|undefined;
  try{handle=ui?executor.createTemplate(source,'{}','','json',true):bindSecretsTemplate(this.#secrets!,data=>executor.createTemplate(source,data.source,data.file,data.type,false));
   if(!ui)for(const [key,value] of this.#globals)handle.addGlobal(key,typeof value==='function'?undefined:encodeTemplateValue(value));
  }catch{handle?.close();throw failure();}
  const created=handle;
  this.#handles.set(created,{ui,frames:new Set()});
  return new MoonrakerAsyncTextTemplate((context,options)=>this.#render(created,context,options),()=>this.#release(created));
 }
 async #render(handle:Handle,context:string,options:AsyncTemplateOptions):Promise<string>{
  const executor=this.#check(),state=this.#handles.get(handle);if(!state)throw new ConfigurationError('Template is closed');text(context,65536);
  const timeout=options.timeoutMs??10000;if(!Number.isInteger(timeout)||timeout<1||timeout>10000||this.#frames.size>=32)throw failure();
  options.signal?.throwIfAborted();const calls=new Map<string,TemplateCallable>();
  if(!state.ui)for(const [key,value] of this.#globals)if(typeof value==='function')calls.set(key,value);
  const keys:string[]=[];if(options.callables){if(options.callables.size>64)throw failure();for(const [key,fn] of options.callables){name(key);if(typeof fn!=='function')throw failure();calls.set(key,fn);keys.push(key);}}
  if(this.#next===0xffffffff)this.#next=0;const id=++this.#next;if(this.#frames.has(id))throw failure();
  const lifetime:Cancellation={ended:false};let stop!:(reason:unknown)=>void,finish!:(output?:string)=>void;
  const rendered=new Promise<string>((resolve,reject)=>{stop=reason=>{if(!frame.cancelled){frame.cancelled=true;end(lifetime,reason);executor.cancel(id);reject(reason);}};finish=output=>output===undefined?reject(failure()):resolve(output);});
  const frame:Frame={lifetime,cancelled:false,callables:calls,sequence:0,stop,finish};this.#frames.set(id,frame);state.frames.add(id);
  const abort=()=>stop(options.signal!.reason),timer=setTimeout(()=>stop(new ConfigurationError('Template render deadline exceeded')),timeout);
  options.signal?.addEventListener('abort',abort,{once:true});
  try{try{handle.render(context,keys,id,timeout);}catch{stop(failure());}return strip(await rendered);}
  finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);end(lifetime,completedReason);this.#frames.delete(id);state.frames.delete(id);calls.clear();}
 }
 async #dispatch(message:string):Promise<void>{
  let id:number|undefined,call:number|undefined;try{
   text(message,524288);const row=JSON.parse(message) as {render:number;call:number;name:string;args:unknown;kwargs:unknown;done?:boolean;text?:string;error?:boolean};
   if(!Number.isInteger(row.render)||row.render<1||row.render>0xffffffff)throw failure();id=row.render;
   const frame=this.#frames.get(id);if(!frame||frame.cancelled)return;
   if(row.done===true){if(row.error===true){frame.finish();return;}text(row.text!,65536);frame.finish(row.text);return;}
   text(message,65536);if(!Number.isInteger(row.call)||row.call<1||row.call>64)throw failure();call=row.call;name(row.name);
   if(call!==frame.sequence+1)throw failure();frame.sequence=call;const fn=frame.callables.get(row.name);if(!fn)throw failure();
   const args=decodeTemplateCall(row.args,row.kwargs),result=await fn(new Invocation(args,frame.lifetime));
   if(this.#frames.get(id)!==frame||frame.cancelled)return;
   if(result&&typeof result==='object'&&'kind'in result&&result.kind==='float'&&'value'in result&&typeof result.value==='number')this.#executor?.respondFloat(id,call,result.value);
   else this.#executor?.respond(id,call,encodeTemplateValue(result));
  }catch(error){const frame=id===undefined?undefined:this.#frames.get(id);
   if(error instanceof Error&&error.name==='AbortError')frame?.stop(error);
   else if(id!==undefined&&call!==undefined)this.#executor?.respond(id,call);
  }
 }
 #release(handle:Handle,reason:unknown=new ConfigurationError('Template is closed')):void{const state=this.#handles.get(handle);if(!state)return;for(const id of state.frames)this.#frames.get(id)?.stop(reason);handle.close();this.#handles.delete(handle);}
 close(reason:unknown=new ConfigurationError('Template is closed')):void{for(const handle of this.#handles.keys())this.#release(handle,reason);this.#validation?.close();this.#validation=undefined;this.#executor?.close();this.#executor=undefined;this.#secrets=undefined;this.#globals.clear();}
 toJSON(){return {closed:this.#executor===undefined,templates:this.#handles.size,renders:this.#frames.size};}
 [Symbol.for('nodejs.util.inspect.custom')](){return 'MoonrakerAsyncTemplateOwner <private>';}
}
export class MoonrakerAsyncTextTemplate {
 #render:((context:string,options:AsyncTemplateOptions)=>Promise<string>)|undefined;#release:(()=>void)|undefined;
 constructor(render:(context:string,options:AsyncTemplateOptions)=>Promise<string>,release:()=>void){this.#render=render;this.#release=release;}
 renderAsync(context='{}',options:AsyncTemplateOptions={}):Promise<string>{if(!this.#render)return Promise.reject(new ConfigurationError('Template is closed'));return this.#render(context,options);}
 close():void{this.#release?.();this.#release=undefined;this.#render=undefined;}
 toJSON(){return {closed:this.#render===undefined};}
 [Symbol.for('nodejs.util.inspect.custom')](){return 'MoonrakerAsyncTextTemplate <private>';}
}
