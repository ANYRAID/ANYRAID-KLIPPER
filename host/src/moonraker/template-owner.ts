// Synchronous text/private-data bridge for pinned Moonraker template.py.
// Original Copyright (C) 2021 Eric Callahan. GPL-3.0-or-later.
import {createRequire} from 'node:module';
import {ConfigurationError} from './config-source.ts';
import {bindSecretsTemplate,type SecretsStore} from './secrets.ts';
import {decodeTemplateCall,encodeTemplateValue,type TemplateCall,type TemplateValue} from './template-wire.ts';
import type {NativeReading} from './native-template.ts';
interface Handle {render(context:string):string;renderWithFunctions(context:string,names:string[],callback:(message:string)=>string|undefined):string;renderSensor(payload:string):NativeReading[];renderSensorWithFunctions(payload:string,names:string[],callback:(message:string)=>string|undefined):NativeReading[];addGlobal(name:string,value?:string):void;close():void;}
export type SyncTemplateCallable=(call:TemplateCall)=>TemplateValue;
export interface SyncTemplateOptions {callables?:ReadonlyMap<string,SyncTemplateCallable>;}
const failure=()=>new ConfigurationError('Error rendering private template');
function name(key:string){if(typeof key!=='string'||!key.length||!key.isWellFormed()||Buffer.byteLength(key)>128)throw failure();}
const strip=(text:string)=>text.replace(/^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,'');
/** Owns native environments and a borrowed private-file generation. Trusted
 * synchronous functions stay on the current Node thread. No Promise waiting
 * or forced JS preemption; async and UI environments have a separate owner. */
export class MoonrakerTemplateOwner {
 #secrets:SecretsStore|undefined;readonly #handles=new Set<Handle>();#validation:Handle|undefined;
 readonly #globals=new Map<string,TemplateValue|SyncTemplateCallable>();
 constructor(secrets:SecretsStore){bindSecretsTemplate(secrets,()=>undefined);this.#secrets=secrets;}
 #check(){if(!this.#secrets)throw new ConfigurationError('Template owner is closed');bindSecretsTemplate(this.#secrets,()=>undefined);return this.#secrets;}
 #native(source:string):Handle{
  return bindSecretsTemplate(this.#check(),data=>{
   const addon=createRequire(import.meta.url)('../../build/template.node') as {NativeTextTemplate:new(source:string,secrets:string,file:string,type:string)=>Handle};
   return new addon.NativeTextTemplate(source,data.source,data.file,data.type);
  });
 }
 addEnvironmentGlobal(key:string,value:TemplateValue|SyncTemplateCallable):void{
  this.#check();name(key);if(this.#globals.size>=64||this.#globals.has(key))throw failure();const encoded=typeof value==='function'?undefined:encodeTemplateValue(value);
  this.#validation??=this.#native('');this.#validation.addGlobal(key,encoded);
  for(const handle of this.#handles)handle.addGlobal(key,encoded);this.#globals.set(key,value);
 }
 #calls(created:Handle,options:SyncTemplateOptions){
  const calls=new Map<string,SyncTemplateCallable>();for(const [key,value] of this.#globals)if(typeof value==='function')calls.set(key,value);
  const keys:string[]=[];if(options.callables){if(options.callables.size>64)throw failure();for(const [key,fn] of options.callables){name(key);if(typeof fn!=='function')throw failure();calls.set(key,fn);keys.push(key);}}
  let sequence=0;
  return {calls,keys,callback:(message:string):string|undefined=>{
   try{this.#check();if(!this.#handles.has(created))throw failure();if(typeof message!=='string'||!message.isWellFormed()||Buffer.byteLength(message)>65536)throw failure();
    const row=JSON.parse(message) as {call:number;name:string;args:unknown;kwargs:unknown};name(row.name);if(row.call!==sequence+1||row.call>64)throw failure();sequence=row.call;
    const fn=calls.get(row.name);if(!fn)throw failure();const result=fn(decodeTemplateCall(row.args,row.kwargs));
    if(result instanceof Promise){void result.catch(()=>{});throw failure();}return encodeTemplateValue(result);
   }catch{return undefined;}
  }};
 }
 createTemplate(source:string):MoonrakerTextTemplate{
  if(!this.#secrets)throw new ConfigurationError('Template owner is closed');
  if(typeof source!=='string'||!source.isWellFormed()||Buffer.byteLength(source)>65536)throw new ConfigurationError('Invalid template source or resource limit');
  if(this.#handles.size>=64)throw failure();let handle:Handle|undefined;
  try{handle=this.#native(source);for(const [key,value] of this.#globals)handle.addGlobal(key,typeof value==='function'?undefined:encodeTemplateValue(value));}
  catch{handle?.close();throw new ConfigurationError('Unable to create bounded private template');}
  this.#handles.add(handle);
  const created=handle;
  return new MoonrakerTextTemplate((context,options)=>{
   if(!this.#secrets||!this.#handles.has(created))throw new ConfigurationError('Template owner is closed');
   // Check the borrowed generation without exposing/copying its private data.
   this.#secrets.getType();bindSecretsTemplate(this.#secrets,()=>undefined);
   if(typeof context!=='string'||!context.isWellFormed()||Buffer.byteLength(context)>65536)throw new ConfigurationError('Invalid template context or resource limit');
   const {calls,keys,callback}=this.#calls(created,options);
   try{const output=calls.size?created.renderWithFunctions(context,keys,callback):created.render(context);this.#check();if(!this.#handles.has(created))throw failure();return strip(output);
   }catch{throw failure();}finally{calls.clear();}
  },()=>{created.close();this.#handles.delete(created);},(payload,options)=>{
   this.#check();if(!this.#handles.has(created)||typeof payload!=='string'||!payload.isWellFormed()||Buffer.byteLength(payload)>65536||options.callables?.has('set_result'))throw failure();
   const {calls,keys,callback}=this.#calls(created,options);
   try{const result=calls.size?created.renderSensorWithFunctions(payload,keys,callback):created.renderSensor(payload);this.#check();if(!this.#handles.has(created))throw failure();return result;}
   catch{throw failure();}finally{calls.clear();}
  });
 }
 close():void{for(const handle of this.#handles)handle.close();this.#handles.clear();this.#validation?.close();this.#validation=undefined;this.#globals.clear();this.#secrets=undefined;}
 toJSON(){return {closed:this.#secrets===undefined,templates:this.#handles.size};}
 [Symbol.for('nodejs.util.inspect.custom')](){return 'MoonrakerTemplateOwner <private>';}
}
/** Raw JSON context is deliberate: callers with lexical numeric types must
 * not pass through JSON.stringify(Number). No context is retained per render. */
export class MoonrakerTextTemplate {
 #render:((context:string,options:SyncTemplateOptions)=>string)|undefined;#release:(()=>void)|undefined;
 #sensor:((payload:string,options:SyncTemplateOptions)=>NativeReading[])|undefined;
 constructor(render:(context:string,options:SyncTemplateOptions)=>string,release:()=>void,sensor:(payload:string,options:SyncTemplateOptions)=>NativeReading[]){this.#render=render;this.#release=release;this.#sensor=sensor;}
 render(context='{}',options:SyncTemplateOptions={}):string{if(!this.#render)throw new ConfigurationError('Template is closed');return this.#render(context,options);}
 renderSensor(payload:string,options:SyncTemplateOptions={}):NativeReading[]{if(!this.#sensor)throw new ConfigurationError('Template is closed');return this.#sensor(payload,options);}
 close():void{this.#release?.();this.#release=undefined;this.#render=undefined;this.#sensor=undefined;}
 toJSON(){return {closed:this.#render===undefined};}
 [Symbol.for('nodejs.util.inspect.custom')](){return 'MoonrakerTextTemplate <private>';}
}
