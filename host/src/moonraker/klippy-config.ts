import {lstat,readlink} from 'node:fs/promises';
import {isAbsolute,join,dirname} from 'node:path';
import {ConfigurationError} from './config-source.ts';
import type {ConfigurationReader} from './config-reader.ts';
import {expandConfigurationUserPath} from './config-path.ts';
const strip=(value:string)=>value.replace(/^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,'');
export interface KlippyPathContext {
 cwd?:string;home?:string;
 /** Legacy unbound renderer. A bound reader keeps its private template owner. */
 render?:(source:string)=>string|Promise<string>;
}
/** Resolve components in order: normalizing '..' before following a symlink
 * would silently select a different socket than pathlib.Path.resolve(). */
export async function resolveKlippyPath(source:string,context:KlippyPathContext={}):Promise<string>{
 let value=strip(source);
 if(context.render)value=await context.render(value);
 else if(/[{}]/u.test(value))throw new ConfigurationError('Klippy path template renderer is required');
 if(typeof value!=='string'||!strip(value)||value.includes('\0')||Buffer.byteLength(value)>4096)throw new ConfigurationError('Invalid Klippy Unix socket path');
 value=strip(value);
 if(value.split('/').find(part=>part&&part!=='.')==='~'&&context.home!==undefined&&!isAbsolute(context.home))throw new ConfigurationError('Klippy home directory must be absolute');
 value=expandConfigurationUserPath(value,context.home);
 const cwd=context.cwd??process.cwd();if(!isAbsolute(cwd))throw new ConfigurationError('Klippy path working directory must be absolute');
 if(!isAbsolute(value))value=cwd+'/'+value;
 let current='/';const seen=new Map<string,string|null>(),steps:({part:string}|{link:string})[]=value.split('/').reverse().map(part=>({part}));
 try{while(steps.length){const step=steps.pop()!;if('link'in step){seen.set(step.link,current);continue;}
  const part=step.part;if(!part||part==='.')continue;if(part==='..'){current=dirname(current);continue;}const next=join(current,part);let link=false;
  try{link=(await lstat(next)).isSymbolicLink();}catch(error){if(typeof(error as NodeJS.ErrnoException).errno!=='number')throw error;}
  if(!link){current=next;continue;}
  if(seen.has(next)){const cached=seen.get(next);if(cached===null)throw new ConfigurationError('Klippy path contains a symlink loop');current=cached!;continue;}
  seen.set(next,null);const target=await readlink(next);if(isAbsolute(target))current='/';steps.push({link:next});for(const part of target.split('/').reverse())steps.push({part});
 }}catch{throw new ConfigurationError('Unable to resolve Klippy Unix socket path (symlink or filesystem error)');}
 // Node/libuv must not silently truncate an overlong sockaddr_un pathname.
 if(Buffer.byteLength(current)>107)throw new ConfigurationError('Klippy Unix socket path exceeds Linux pathname capacity');
 return current;
}
export async function readKlippyBinding(reader:ConfigurationReader,context:KlippyPathContext={},retryDelayMs=250){
 if(!Number.isSafeInteger(retryDelayMs)||retryDelayMs<1||retryDelayMs>60000)throw new ConfigurationError('Invalid Klippy retry delay');
 if(reader.hasTemplates()&&context.render)throw new ConfigurationError('Choose one Klippy template dependency');
 if(reader.hasTemplates()&&context.cwd===undefined&&context.home===undefined&&context.render===undefined){
  const path=reader.section('server').getPath('klippy_uds_address',{defaultValue:'/tmp/klippy_uds'});
  if(!isAbsolute(path)||path.includes('\0')||Buffer.byteLength(path)>107)throw new ConfigurationError('Invalid Klippy Unix socket path');
  return Object.freeze({path,retryDelayMs});
 }
 if(reader.hasTemplates()){
  const template=reader.section('server').getTemplate('klippy_uds_address',{defaultValue:'/tmp/klippy_uds'});
  if(typeof template==='string')return Object.freeze({path:template,retryDelayMs});
  try{const value=template.render(JSON.stringify({data_path:reader.templates().configurationDataPath()}));return Object.freeze({path:await resolveKlippyPath(value||'.',{...context,render:source=>source}),retryDelayMs});}
  finally{template.close();}
 }
 const section=reader.section('server'),source=section.get('klippy_uds_address',{defaultValue:'/tmp/klippy_uds'});
 // Upstream getpath returns its Path default without rendering or resolving it.
 return Object.freeze({path:section.hasOption('klippy_uds_address')?await resolveKlippyPath(source,context):source,retryDelayMs});
}
