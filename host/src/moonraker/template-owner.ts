// Synchronous text/private-data bridge for pinned Moonraker template.py.
// Original Copyright (C) 2021 Eric Callahan. GPL-3.0-or-later.
import {createRequire} from 'node:module';
import {ConfigurationError} from './config-source.ts';
import {bindSecretsTemplate,type SecretsStore} from './secrets.ts';
interface Handle {render(context:string):string;close():void;}
const strip=(text:string)=>text.replace(/^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,'');
/** Owns native environments and a borrowed private-file generation. Explicit
 * construction only; arbitrary JS/async callables and UI environments are not
 * claimed by this synchronous candidate. A closed dependency rejects renders. */
export class MoonrakerTemplateOwner {
 #secrets:SecretsStore|undefined;readonly #handles=new Set<Handle>();
 constructor(secrets:SecretsStore){bindSecretsTemplate(secrets,()=>undefined);this.#secrets=secrets;}
 createTemplate(source:string):MoonrakerTextTemplate{
  if(!this.#secrets)throw new ConfigurationError('Template owner is closed');
  if(typeof source!=='string'||!source.isWellFormed()||Buffer.byteLength(source)>65536)throw new ConfigurationError('Invalid template source or resource limit');
  let handle:Handle;
  try{handle=bindSecretsTemplate(this.#secrets,data=>{
   const addon=createRequire(import.meta.url)('../../build/template.node') as {NativeTextTemplate:new(source:string,secrets:string,file:string,type:string)=>Handle};
   return new addon.NativeTextTemplate(source,data.source,data.file,data.type);
  });}catch{throw new ConfigurationError('Unable to create bounded private template');}
  this.#handles.add(handle);
  return new MoonrakerTextTemplate(context=>{
   if(!this.#secrets||!this.#handles.has(handle))throw new ConfigurationError('Template owner is closed');
   // Check the borrowed generation without exposing/copying its private data.
   this.#secrets.getType();bindSecretsTemplate(this.#secrets,()=>undefined);
   if(typeof context!=='string'||!context.isWellFormed()||Buffer.byteLength(context)>65536)throw new ConfigurationError('Invalid template context or resource limit');
   try{return strip(handle.render(context));}catch{throw new ConfigurationError('Error rendering private template');}
  },()=>{handle.close();this.#handles.delete(handle);});
 }
 close():void{for(const handle of this.#handles)handle.close();this.#handles.clear();this.#secrets=undefined;}
 toJSON(){return {closed:this.#secrets===undefined,templates:this.#handles.size};}
 [Symbol.for('nodejs.util.inspect.custom')](){return 'MoonrakerTemplateOwner <private>';}
}
/** Raw JSON context is deliberate: callers with lexical numeric types must
 * not pass through JSON.stringify(Number). No context is retained per render. */
export class MoonrakerTextTemplate {
 #render:((context:string)=>string)|undefined;#release:(()=>void)|undefined;
 constructor(render:(context:string)=>string,release:()=>void){this.#render=render;this.#release=release;}
 render(context='{}'):string{if(!this.#render)throw new ConfigurationError('Template is closed');return this.#render(context);}
 close():void{this.#release?.();this.#release=undefined;this.#render=undefined;}
 toJSON(){return {closed:this.#render===undefined};}
 [Symbol.for('nodejs.util.inspect.custom')](){return 'MoonrakerTextTemplate <private>';}
}
