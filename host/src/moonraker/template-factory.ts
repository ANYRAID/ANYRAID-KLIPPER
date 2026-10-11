// Shared environment and generation ownership for pinned template.py.
// Original Copyright (C) 2021 Eric Callahan. GPL-3.0-or-later.
import type {ConfigurationReader} from './config-reader.ts';
import {ConfigurationError} from './config-source.ts';
import {ApiError} from './rpc.ts';
import {loadSecrets,type SecretsContext,type SecretsStore} from './secrets.ts';
import {MoonrakerTemplateOwner,type MoonrakerTextTemplate,type SyncTemplateCallable,type SyncTemplateOptions} from './template-owner.ts';
import {MoonrakerAsyncTemplateOwner,type MoonrakerAsyncTextTemplate,type TemplateCallable,type AsyncTemplateOptions} from './template-async-owner.ts';
import type {TemplateCall,TemplateValue} from './template-wire.ts';
export interface TemplateFactoryOptions {debug?:(call:TemplateCall)=>void;}
export type FactoryTemplateCallable=(call:TemplateCall&{readonly signal?:AbortSignal})=>TemplateValue|Promise<TemplateValue>;
const failure=()=>new ApiError(500,'Error rending Jinja2 Template');
/** Explicit private component generation; static load owns its SecretsStore.
 * Async native workers are created only on first async/UI use. No public route. */
export class MoonrakerTemplateFactory {
 #secrets:SecretsStore|undefined;#sync:MoonrakerTemplateOwner|undefined;#async:MoonrakerAsyncTemplateOwner|undefined;
 #configured=false;#releaseReader:()=>void=()=>{};readonly #shutdown=new AbortController();
 readonly #globals=new Map<string,TemplateValue|FactoryTemplateCallable>();readonly #templates=new Set<MoonrakerRenderableTemplate>();
 readonly #options:TemplateFactoryOptions;#dataPath:string|undefined;
 private constructor(secrets:SecretsStore,context:SecretsContext,options:TemplateFactoryOptions){this.#secrets=secrets;this.#sync=new MoonrakerTemplateOwner(secrets);this.#options={...options};this.#dataPath=context.dataPath;}
 static async load(reader:ConfigurationReader,context:SecretsContext,options:TemplateFactoryOptions={}):Promise<MoonrakerTemplateFactory>{
  if(options.debug!==undefined&&typeof options.debug!=='function')throw new ConfigurationError('Invalid trusted template logger');
  const secrets=await loadSecrets(reader,context);let factory:MoonrakerTemplateFactory|undefined;
  try{factory=new MoonrakerTemplateFactory(secrets,context,options);factory.#releaseReader=reader.bindTemplates(factory);return factory;}
  catch{factory?.close();secrets.close();throw new ConfigurationError('Unable to load private template component');}
 }
 #check():MoonrakerTemplateOwner{if(!this.#sync||!this.#secrets)throw new ConfigurationError('Template component is closed');return this.#sync;}
 #asyncOwner():MoonrakerAsyncTemplateOwner{
  this.#check();if(!this.#async){let owner:MoonrakerAsyncTemplateOwner|undefined;
   try{owner=new MoonrakerAsyncTemplateOwner(this.#secrets!);for(const [key,value] of this.#globals)owner.addEnvironmentGlobal(key,value);this.#async=owner;}
   catch{owner?.close();throw failure();}
  }return this.#async;
 }
 markConfigured():void{this.#check();this.#configured=true;}
 /** Trusted application context for configuration getters, never serialized. */
 configurationDataPath():string{this.#check();return this.#dataPath!;}
 addEnvironmentGlobal(key:string,value:TemplateValue|FactoryTemplateCallable):void{
  const sync=this.#check();sync.addEnvironmentGlobal(key,value as TemplateValue|SyncTemplateCallable);
  try{this.#async?.addEnvironmentGlobal(key,value);this.#globals.set(key,value);}
  catch{this.close();throw failure();}
 }
 createTemplate(source:string,isAsync=false):MoonrakerRenderableTemplate{return this.#create(source,isAsync,false);}
 createUiTemplate(source:string):MoonrakerRenderableTemplate{return this.#create(source,true,true);}
 #debug(context:string,options:SyncTemplateOptions|AsyncTemplateOptions,ui:boolean):Map<string,SyncTemplateCallable|TemplateCallable>|undefined{
  if(ui||!this.#options.debug)return undefined;
  // Inspect only the key, never reencode lexical numbers or retain context.
  if(Object.hasOwn(JSON.parse(context),'log_debug')||options.callables?.has('log_debug'))return undefined;
  const calls=new Map<string,SyncTemplateCallable|TemplateCallable>(options.callables);
  calls.set('log_debug',(call:TemplateCall)=>{const args=call.args,kwargs=call.kwargs;
   if(!args.length&&!kwargs.has('msg')||args.length&&kwargs.has('msg'))throw failure();
   const result:unknown=this.#options.debug!(call);
   if(result!==null&&(typeof result==='object'||typeof result==='function')&&typeof (result as {then?:unknown}).then==='function'){
    void Promise.resolve(result).catch(()=>{});throw failure();
   }return null;
  });return calls;
 }
 #create(source:string,isAsync:boolean,ui:boolean):MoonrakerRenderableTemplate{
  this.#check();if(typeof isAsync!=='boolean'||this.#templates.size>=64)throw failure();
  const handle:MoonrakerTextTemplate|MoonrakerAsyncTextTemplate=isAsync?(ui?this.#asyncOwner().createUiTemplate(source):this.#asyncOwner().createTemplate(source)):this.#sync!.createTemplate(source);
  let template!:MoonrakerRenderableTemplate;
  template=new MoonrakerRenderableTemplate(source,isAsync,(context,options)=>{
   try{this.#check();const calls=this.#debug(context,options,ui);return (handle as MoonrakerTextTemplate).render(context,calls?{...options,callables:calls as ReadonlyMap<string,SyncTemplateCallable>}:options);}
   catch{if(!this.#configured)throw new ConfigurationError('Error rending Jinja2 Template');throw failure();}
  },async(context,options)=>{
   try{this.#check();this.#shutdown.signal.throwIfAborted();options.signal?.throwIfAborted();const calls=this.#debug(context,options,ui);
    // The executor already tracks every active frame. Generation close stops
    // them directly; do not attach another shared abort listener per render.
    return await (handle as MoonrakerAsyncTextTemplate).renderAsync(context,calls?{...options,callables:calls as ReadonlyMap<string,TemplateCallable>}:options);
   }catch(error){if(this.#shutdown.signal.aborted&&error===this.#shutdown.signal.reason)throw error;if(options.signal?.aborted&&error===options.signal.reason)throw error;throw failure();}
  },()=>{handle.close();this.#templates.delete(template);});this.#templates.add(template);return template;
 }
 close():void{if(!this.#secrets)return;this.#shutdown.abort(new DOMException('Template component is closing','AbortError'));this.#async?.close(this.#shutdown.signal.reason);this.#async=undefined;for(const template of this.#templates)template.close();this.#sync?.close();this.#sync=undefined;this.#globals.clear();delete this.#options.debug;this.#dataPath=undefined;this.#releaseReader();this.#releaseReader=()=>{};this.#secrets.close();this.#secrets=undefined;}
 toJSON(){return {closed:this.#secrets===undefined,templates:this.#templates.size,asyncInitialized:this.#async!==undefined};}
 [Symbol.for('nodejs.util.inspect.custom')](){return 'MoonrakerTemplateFactory <private>';}
}
/** Source access is explicit for trusted configuration recording; inspection
 * and JSON never expose it. Closing drops the source and render closures. */
export class MoonrakerRenderableTemplate {
 readonly isAsync:boolean;#source:string|undefined;
 #sync:((context:string,options:SyncTemplateOptions)=>string)|undefined;
 #async:((context:string,options:AsyncTemplateOptions)=>Promise<string>)|undefined;#release:(()=>void)|undefined;
 constructor(source:string,isAsync:boolean,sync:(context:string,options:SyncTemplateOptions)=>string,async:(context:string,options:AsyncTemplateOptions)=>Promise<string>,release:()=>void){this.#source=source;this.isAsync=isAsync;this.#sync=sync;this.#async=async;this.#release=release;}
 toString():string{if(this.#source===undefined)throw new ConfigurationError('Template is closed');return this.#source;}
 render(context='{}',options:SyncTemplateOptions={}):string{if(!this.#sync)throw new ConfigurationError('Template is closed');if(this.isAsync)throw new ApiError(400,'Cannot render async templates with the render() method, use render_async()');return this.#sync(context,options);}
 renderAsync(context='{}',options:AsyncTemplateOptions={}):Promise<string>{if(!this.#async)return Promise.reject(new ConfigurationError('Template is closed'));if(!this.isAsync)return Promise.reject(failure());return this.#async(context,options);}
 close():void{this.#release?.();this.#release=undefined;this.#source=undefined;this.#sync=undefined;this.#async=undefined;}
 toJSON(){return {closed:this.#source===undefined,isAsync:this.isAsync};}
 [Symbol.for('nodejs.util.inspect.custom')](){return 'MoonrakerRenderableTemplate <private>';}
}
