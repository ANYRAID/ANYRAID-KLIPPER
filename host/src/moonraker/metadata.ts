// Server metadata contracts follow pinned moonraker/server.py (GPL-3.0-or-later).
import {dirname,isAbsolute,sep,normalize} from 'node:path';
import {ApiError,validateJson,type Json} from './rpc.ts';
import {EndpointRegistry} from './endpoints.ts';
export type KlippyState='disconnected'|'startup'|'ready'|'error'|'shutdown';
export interface InformationSnapshot {
 connected:boolean;state:KlippyState;components:readonly string[];failedComponents:readonly string[];
 directories:readonly string[];warnings:readonly string[];version:string;missingRequirements:readonly string[];
}
export interface ConfigurationSnapshot {
 /** Canonical absolute primary filename, resolved by the configuration loader. */
 primaryFile:string;parsed:Record<string,Record<string,Json>>;original:Record<string,Record<string,string>>;
 files:readonly {filename:string;sections:readonly string[]}[];
}
const states=new Set(['disconnected','startup','ready','error','shutdown']);
function strings(values:readonly string[],maximum:number):readonly string[]{if(!Array.isArray(values)||values.length>maximum||values.some(v=>typeof v!=='string'||v.includes('\0')||v.length>65536))throw new Error('Invalid metadata string list');return Object.freeze([...values]);}
function checkJson(value:unknown):void{validateJson(value);}
function freeze<T>(value:T):T{const pending:unknown[]=[value];while(pending.length){const item=pending.pop();if(item&&typeof item==='object'&&!Object.isFrozen(item)){pending.push(...Object.values(item));Object.freeze(item);}}return value;}
/** Replace one coherent lifecycle snapshot, never infer ready from a network
 * connection. Runtime owners supply only successfully loaded components. */
export class ServerInformation {
 #raw!:Record<string,Json>;#formatted!:Record<string,Json>;
 constructor(snapshot:InformationSnapshot){this.replace(snapshot);}
 replace(s:InformationSnapshot):void{
  if(typeof s.connected!=='boolean'||!states.has(s.state)||typeof s.version!=='string'||!s.version||s.version.length>1024)throw new Error('Invalid server information');
  const warnings=strings(s.warnings,1024),base={klippy_connected:s.connected,klippy_state:s.state,components:strings(s.components,256),failed_components:strings(s.failedComponents,256),registered_directories:strings(s.directories,256),warnings,moonraker_version:s.version,missing_klippy_requirements:strings(s.missingRequirements,256),api_version:[1,5,0],api_version_string:'1.5.0'};
  checkJson(base);const raw=freeze(base) as unknown as Record<string,Json>,formatted=freeze({...base,warnings:warnings.map(w=>w.replaceAll('\n','<br/>'))}) as unknown as Record<string,Json>;
  this.#raw=raw;this.#formatted=formatted;
 }
 read(raw:boolean,websocketCount:number):Record<string,Json>{if(!Number.isSafeInteger(websocketCount)||websocketCount<0)throw new Error('Invalid WebSocket connection count');return {...(raw?this.#raw:this.#formatted),websocket_count:websocketCount};}
}
/** Immutable parsed/original configuration views. Parsing includes, templates,
 * defaults and redaction policy remain the configuration loader's responsibility. */
export class ServerConfiguration {
 #view!:Record<string,Json>;
 constructor(snapshot:ConfigurationSnapshot){this.replace(snapshot);}
 replace(s:ConfigurationSnapshot):void{
  if(!isAbsolute(s.primaryFile)||normalize(s.primaryFile)!==s.primaryFile||s.primaryFile.includes('\0')||s.files.length>1024)throw new Error('Configuration requires canonical absolute paths');
  if(!s.parsed||typeof s.parsed!=='object'||Array.isArray(s.parsed)||!s.original||typeof s.original!=='object'||Array.isArray(s.original))throw new Error('Invalid configuration sections');
  for(const section of Object.values(s.parsed))if(!section||typeof section!=='object'||Array.isArray(section))throw new Error('Parsed configuration sections must be objects');
  for(const section of Object.values(s.original))if(!section||typeof section!=='object'||Array.isArray(section)||Object.values(section).some(v=>typeof v!=='string'))throw new Error('Original configuration values must be strings');
  // Upstream Path.relative_to is lexical: a source loaded through ../ keeps
  // that provenance, including symlink/.. paths with different real targets.
  const parent=dirname(s.primaryFile),prefix=parent.endsWith(sep)?parent:parent+sep,files=s.files.map(file=>{if(!isAbsolute(file.filename)||file.filename.includes('\0'))throw new Error('Configuration requires absolute source paths');const filename=file.filename.split(sep).filter(part=>part!==''&&part!=='.').join(sep);const absolute=sep+filename;return {filename:absolute.startsWith(prefix)?absolute.slice(prefix.length):absolute,sections:strings(file.sections,1024)};});
  const view={config:s.parsed,orig:s.original,files};checkJson(view);this.#view=freeze(structuredClone(view)) as unknown as Record<string,Json>;
 }
 read():Record<string,Json>{return this.#view;}
}
export function registerServerMetadata(registry:EndpointRegistry,information:ServerInformation,configuration:ServerConfiguration,connections:()=>number):()=>void{
 const releases:(()=>void)[]=[];
 try{
  releases.push(registry.register({endpoint:'/server/info',methods:['GET']},params=>{const raw=Object.hasOwn(params,'raw')?params.raw:false;if(typeof raw!=='boolean'&&(typeof raw!=='string'||!['true','false'].includes(raw.toLowerCase())))throw new ApiError(400,'Unable to convert argument [raw] to boolean');return information.read(raw===true||typeof raw==='string'&&raw.toLowerCase()==='true',connections());}));
  releases.push(registry.register({endpoint:'/server/config',methods:['GET']},()=>configuration.read()));
 }catch(error){for(const release of releases.reverse())release();throw error;}
 let closed=false;return ()=>{if(closed)return;closed=true;for(const release of releases.reverse())release();};
}
