// File ownership and format contract: pinned Moonraker components/secrets.py.
// Original Copyright (C) 2021 Eric Callahan. GPL-3.0-or-later.
import {constants} from 'node:fs';
import {open,stat} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {ConfigurationReader} from './config-reader.ts';
import {ConfigurationError} from './config-source.ts';
import {resolveConfigurationPath} from './config-path.ts';
import {parseExactJson} from './json-exact.ts';

export type SecretValue=null|boolean|string|number|bigint|readonly SecretValue[]|SecretObject;
export interface SecretObject {readonly [name:string]:SecretValue;}
export interface SecretsLimits {bytes?:number;depth?:number;items?:number;integerDigits?:number;}
export interface SecretsContext extends SecretsLimits {dataPath:string;}
type Format='json'|'ini'|'invalid';
// Private lexical source: Number alone cannot distinguish JSON 1 from 1.0.
// Weak keys do not retain retired generations. Never attach this to snapshots.
const templateSources=new WeakMap<SecretObject,string>();
const templateBindings=new WeakMap<SecretsStore,()=>{source:string;file:string;type:Format}>();
function templateJson(value:SecretValue):string{
 if(typeof value==='bigint')return value.toString();
 if(typeof value==='number'){if(!Number.isFinite(value))invalid();return Object.is(value,-0)?'-0.0':String(value);}
 if(Array.isArray(value))return '['+value.map(templateJson).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).map(([key,item])=>JSON.stringify(key)+':'+templateJson(item)).join(',')+'}';
 return JSON.stringify(value);
}
/** Trusted template dependency only. The callback receives a private lexical
 * snapshot; neither public JSON, inspection nor network routes use this bridge. */
export function bindSecretsTemplate<T>(store:SecretsStore,consume:(data:{source:string;file:string;type:Format})=>T):T{
 const binding=templateBindings.get(store);if(!binding)throw new ConfigurationError('Secrets generation is closed');return consume(binding());
}
const dictionary=<T>():Record<string,T>=>Object.create(null);
const whitespace='\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const edges=new RegExp(`^[${whitespace}]+|[${whitespace}]+$`,'g'),leading=new RegExp(`^[${whitespace}]*`);
const strip=(value:string)=>value.replace(edges,'');
function invalid():never{throw new ConfigurationError('Invalid secrets file format or resource limit');}
function limits(options:SecretsLimits){
 const maximum={bytes:options.bytes??1024*1024,depth:options.depth??64,items:options.items??65536,integerDigits:options.integerDigits??4096};
 if(Object.values(maximum).some(value=>!Number.isSafeInteger(value)||value<1))throw new ConfigurationError('Invalid secrets resource limit');
 return maximum;
}
/** ConfigParser(interpolation=None): unlike the public configuration source,
 * inline comments and percent strings are literal, includes are not executed,
 * and empty lines inside a multiline value are retained. */
function parseIni(text:string):Record<string,SecretValue>{
 const sections=dictionary<Record<string,string>>(),defaults=dictionary<string>(),seen=new Set<string>();
 let current:Record<string,string>|undefined,section='',option:string|undefined,previousIndent=0;
 for(const line of text.split(/\r\n|[\n\r]/)){
  const value=strip(line);
  if(!value){if(current&&option!==undefined)current[option]+='\n';continue;}
  if(value.startsWith('#')||value.startsWith(';'))continue;
  const indentation=line.match(leading)![0].length;
  if(current&&option!==undefined&&indentation>previousIndent){current[option]+='\n'+value;continue;}
  previousIndent=indentation;
  const header=value.match(/^\[(.+)\]/s);
  if(header){section=header[1];if(section==='DEFAULT')current=defaults;else{if(Object.hasOwn(sections,section))invalid();current=sections[section]=dictionary<string>();}option=undefined;continue;}
  if(!current)invalid();const match=value.match(/^(.+?)(?:=|:)(.*)$/s);if(!match)invalid();
  option=strip(match[1]).toLowerCase();if(!option)invalid();
  const identity=JSON.stringify([section,option]);if(seen.has(identity))invalid();seen.add(identity);current![option]=strip(match[2]);
 }
 const result=dictionary<SecretValue>();
 for(const [name,values]of Object.entries(sections)){
  const merged=dictionary<SecretValue>();for(const [key,value]of Object.entries({...defaults,...values}))merged[key]=strip(value);
  result[name]=merged;
 }
 return result;
}
/** No JavaScript integer rounding at the private-file boundary. Unsafe JSON
 * integers become BigInt; float tokens retain binary64 semantics. Nothing here
 * grants a number permission to enter motion or public JSON APIs. */
export function parseSecretsText(text:string,options:SecretsLimits={}):{type:'json'|'ini';values:SecretObject}{
 const maximum=limits(options);if(typeof text!=='string'||Buffer.byteLength(text)>maximum.bytes)invalid();
 let parsed:unknown,type:'json'|'ini'='json';
 try{
  parsed=parseExactJson(text,{integerDigits:maximum.integerDigits});
 }catch(error){if(!(error instanceof SyntaxError))invalid();type='ini';parsed=parseIni(text);}
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))invalid();
 let count=0;
 function copy(value:unknown,depth:number):SecretValue{
  if(++count>maximum.items||depth>maximum.depth)invalid();
  if(value===null||typeof value==='boolean'||typeof value==='number'||typeof value==='bigint')return value;
  if(typeof value==='string'){if(!value.isWellFormed())invalid();return value;}
  if(Array.isArray(value))return Object.freeze(value.map(item=>copy(item,depth+1)));
  if(!value||typeof value!=='object')invalid();const result=dictionary<SecretValue>();
  for(const [key,item]of Object.entries(value)){if(!key.isWellFormed())invalid();result[key]=copy(item,depth+1);}
  return Object.freeze(result);
 }
 const values=copy(parsed,0) as SecretObject;if(type==='json')templateSources.set(values,text);return {type,values};
}
/** Process-private immutable generation. Inspection and JSON serialization
 * expose only status; closing drops the owner's references to secret values.
 * JavaScript GC is not a cryptographic zeroization guarantee. */
export class SecretsStore {
 readonly #file:string;#type:Format;#values:SecretObject;#closed=false;
 constructor(file:string,type:Format,values:SecretObject){this.#file=file;this.#type=type;this.#values=values;templateBindings.set(this,()=>{this.#assertOpen();return {source:templateSources.get(this.#values)??templateJson(this.#values),file:this.#file,type:this.#type};});}
 getFile():string{return this.#file;}
 getType():Format{return this.#type;}
 get(name:string,defaultValue:SecretValue=null):SecretValue{this.#assertOpen();return Object.hasOwn(this.#values,name)?this.#values[name]:defaultValue;}
 item(name:string):SecretValue{this.#assertOpen();if(!Object.hasOwn(this.#values,name))throw new ConfigurationError('Secrets item is not available');return this.#values[name];}
 #assertOpen():void{if(this.#closed)throw new ConfigurationError('Secrets generation is closed');}
 close():void{this.#closed=true;templateBindings.delete(this);this.#values=Object.freeze(dictionary<SecretValue>());this.#type='invalid';}
 toJSON():{type:Format;closed:boolean}{return {type:this.#type,closed:this.#closed};}
 [Symbol.for('nodejs.util.inspect.custom')]():string{return 'SecretsStore <private>';}
}
const expand=resolveConfigurationPath;
async function regular(path:string):Promise<boolean>{try{return (await stat(path)).isFile();}catch(error){if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))return false;throw new ConfigurationError('Unable to inspect secrets file');}}
/** Private startup selection, also used to reserve the actual physical source
 * before public configuration capabilities open. Never returns secret bytes. */
export async function selectSecretsMaterialPath(reader:ConfigurationReader,dataPath:string):Promise<{file:string;found:boolean;legacyConfigured:boolean}>{
 if(typeof dataPath!=='string'||!isAbsolute(dataPath)||dataPath.includes('\0'))throw new ConfigurationError('Secrets require an absolute data directory');
 const legacy=reader.section('secrets').get('secrets_path',{defaultValue:null,deprecate:true});if(legacy!==null&&legacy.includes('\0'))throw new ConfigurationError('Invalid legacy secrets filename');
 let file=join(dataPath,'moonraker.secrets'),found=await regular(file);if(!found&&legacy!==null){file=expand(legacy);found=await regular(file);}return {file,found,legacyConfigured:legacy!==null};
}
/** Explicit dependency assembly for template/configuration owners. No public
 * snapshot, database namespace, network endpoint, watcher or per-request I/O.
 * The data-directory file wins even if invalid; legacy files never silently
 * replace an existing selected file. Caller owns the returned generation. */
export async function loadSecrets(reader:ConfigurationReader,context:SecretsContext):Promise<SecretsStore>{
 const maximum=limits(context);
 const {file,found,legacyConfigured}=await selectSecretsMaterialPath(reader,context.dataPath);
 if(!found){if(legacyConfigured)reader.warn('[secrets]: Configured secrets file does not exist.');return new SecretsStore(file,'invalid',Object.freeze(dictionary<SecretValue>()));}
 let handle:Awaited<ReturnType<typeof open>>|undefined,text:string;
 try{
  handle=await open(file,constants.O_RDONLY|constants.O_NONBLOCK);const info=await handle.stat();if(!info.isFile()||info.size>maximum.bytes)invalid();
  const chunks:Buffer[]=[];let total=0;
  for(;;){const buffer=Buffer.allocUnsafe(Math.min(65536,maximum.bytes-total+1)),{bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;if(total>maximum.bytes)invalid();chunks.push(buffer.subarray(0,bytesRead));}
  text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks));
 }catch{throw new ConfigurationError('Unable to read bounded regular secrets file');}
 finally{await handle?.close();}
 try{const parsed=parseSecretsText(text!,maximum);return new SecretsStore(file,parsed.type,parsed.values);}
 catch{reader.warn('[secrets]: Invalid secrets file; expected a bounded JSON object or INI document.');return new SecretsStore(file,'invalid',Object.freeze(dictionary<SecretValue>()));}
}
