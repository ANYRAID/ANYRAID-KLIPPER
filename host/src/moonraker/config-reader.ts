// Component getters follow pinned Moonraker confighelper.py (GPL-3.0-or-later).
import {ConfigurationError,ConfigurationSource} from './config-source.ts';
import {ServerConfiguration,type ConfigurationSnapshot} from './metadata.ts';
import {validateJson,type Json} from './rpc.ts';
export interface ReadOptions<D extends Json=never>{defaultValue?:D;deprecate?:boolean;}
export interface NumericOptions<D extends Json=never> extends ReadOptions<D>{above?:number;below?:number;minval?:number;maxval?:number;}
export type ListType='string'|'int'|'float';
export interface ListOptions<D extends Json=never> extends ReadOptions<D>{type?:ListType;separators?:readonly (string|null)[];count?:readonly (number|null)[];}
export interface DictionaryOptions<D extends Json=never> extends ReadOptions<D>{type?:ListType;separators?:readonly [string|null,string|null];allowEmptyFields?:boolean;}
const dict=<T>():Record<string,T>=>Object.create(null);
const whitespace='\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const edges=new RegExp(`^[${whitespace}]+|[${whitespace}]+$`,'g'),spaces=new RegExp(`[${whitespace}]+`);
const strip=(text:string)=>text.replace(edges,'');
const numericEdges=new RegExp(`^[${whitespace.replace('\\x1c-\\x1f','')}]+|[${whitespace.replace('\\x1c-\\x1f','')}]+$`,'g');
// Unicode 15 Nd zeros, matching the reference Python 3.12 decimal conversion.
const decimalZeros=[0x30,0x660,0x6f0,0x7c0,0x966,0x9e6,0xa66,0xae6,0xb66,0xbe6,0xc66,0xce6,0xd66,0xde6,0xe50,0xed0,0xf20,0x1040,0x1090,0x17e0,0x1810,0x1946,0x19d0,0x1a80,0x1a90,0x1b50,0x1bb0,0x1c40,0x1c50,0xa620,0xa8d0,0xa900,0xa9d0,0xa9f0,0xaa50,0xabf0,0xff10,0x104a0,0x10d30,0x11066,0x110f0,0x11136,0x111d0,0x112f0,0x11450,0x114d0,0x11650,0x116c0,0x11730,0x118e0,0x11950,0x11c50,0x11d50,0x11da0,0x11f50,0x16a60,0x16ac0,0x16b50,0x1d7ce,0x1d7d8,0x1d7e2,0x1d7ec,0x1d7f6,0x1e140,0x1e2f0,0x1e4f0,0x1e950,0x1fbf0];
const decimalMap=new Map<string,string>();for(const zero of decimalZeros)for(let i=0;i<10;i++)decimalMap.set(String.fromCodePoint(zero+i),String(i));
function numericText(value:string):string{value=value.replace(numericEdges,'');return /[^\x00-\x7f]/.test(value)?[...value].map(c=>decimalMap.get(c)??c).join(''):value;}
const digits='[0-9](?:_?[0-9])*';
const integer=new RegExp(`^[+-]?${digits}$`),floating=new RegExp(`^[+-]?(?:${digits}(?:\\.(?:${digits})?)?|\\.${digits})(?:[eE][+-]?${digits})?$`);
function convert(type:ListType,value:string):string|number{
 if(type==='string')return value;
 const token=numericText(value);if(!(type==='int'?integer:floating).test(token))throw new ConfigurationError(`Invalid ${type} configuration value`);
 const number=Number(token.replaceAll('_',''));if(!Number.isFinite(number)||type==='int'&&!Number.isSafeInteger(number))throw new ConfigurationError('Configuration number exceeds finite/safe integer range');
 return type==='int'&&number===0?0:number;
}
/** Parse nested dictionary integers using the same Python-compatible lexical rules. */
export function parseConfigurationInteger(value:string):number{return convert('int',value) as number;}
const booleans=new Map<string,boolean>([['1',true],['yes',true],['true',true],['on',true],['0',false],['no',false],['false',false],['off',false]]);
function split(text:string,separator:string|null):string[]{if(separator===null)return strip(text).split(spaces);if(!separator)throw new ConfigurationError('Empty configuration separator');return text.split(separator);}
function firstSplit(text:string,separator:string|null):string[]{if(separator===null){const match=spaces.exec(text);return match?[text.slice(0,match.index),text.slice(match.index+match[0].length)]:[text];}if(!separator)throw new ConfigurationError('Empty configuration separator');const index=text.indexOf(separator);return index<0?[text]:[text.slice(0,index),text.slice(index+separator.length)];}
function checkName(name:string):void{if(typeof name!=='string'||!name||name.length>65536||name.includes('\0'))throw new ConfigurationError('Invalid configuration section/option name');}
function clone<T extends Json>(value:T):T{validateJson(value);return structuredClone(value);}
/** One load generation: getters share first-read records and warnings. Source is
 * immutable; publication explicitly copies records into the server's snapshot. */
export class ConfigurationReader {
 readonly source:ConfigurationSource;
 #parsed:ConfigurationSnapshot['parsed']=dict();#warnings=new Set<string>();
 constructor(source:ConfigurationSource,initialSection:string|null='server'){this.source=source;if(initialSection!==null)this.ensure(initialSection);}
 ensure(section:string):void{checkName(section);this.#parsed[section]??=dict();}
 section(name:string,fallback?:string):ConfigSection{this.ensure(name);if(fallback!==undefined)checkName(fallback);return new ConfigSection(this,name,fallback);}
 sections():string[]{return Object.keys(this.source.original).filter(s=>s!=='DEFAULT');}
 hasSection(name:string):boolean{return name!=='DEFAULT'&&Object.hasOwn(this.source.original,name);}
 prefixSections(prefix:string):string[]{return this.sections().filter(s=>s.startsWith(prefix));}
 parsed():ConfigurationSnapshot['parsed']{return structuredClone(this.#parsed);}
 snapshot():ConfigurationSnapshot{return this.source.snapshot(this.parsed());}
 publish(target:ServerConfiguration):void{target.replace(this.snapshot());}
 warnings():readonly string[]{return Object.freeze([...this.#warnings]);}
 warn(message:string):void{this.#warnings.add(message);}
 error(section:string):void{this.ensure(section);this.#parsed[section].__CONFIG_ERROR__=true;}
 record(section:string,option:string,value:Json):void{this.ensure(section);if(!Object.hasOwn(this.#parsed[section],option))this.#parsed[section][option]=clone(value);}
 validate():readonly string[]{for(const section of this.sections()){
  if(!Object.hasOwn(this.#parsed,section)){this.warn(`Unparsed config section [${section}] detected. This may be the result of a component that failed to load.`);continue;}
  if(Object.hasOwn(this.#parsed[section],'__CONFIG_ERROR__'))continue;
  for(const option of Object.keys(this.source.original[section]))if(!Object.hasOwn(this.#parsed[section],option))this.warn(`Unparsed config option '${option}' detected in section [${section}].`);
 }return this.warnings();}
}
export class ConfigSection {
 #reader:ConfigurationReader;readonly name:string;readonly fallback:string|undefined;
 constructor(reader:ConfigurationReader,name:string,fallback?:string){this.#reader=reader;this.name=name;this.fallback=fallback;reader.ensure(name);}
 hasOption(option:string):boolean{return Object.hasOwn(this.#reader.source.original[this.name]??{},option.toLowerCase());}
 options():Readonly<Record<string,string>>{return this.#reader.source.original[this.name]??Object.freeze({});}
 section(name:string,fallback?:string):ConfigSection{return this.#reader.section(name,fallback);}
 #get<T extends Json,D extends Json>(option:string,parse:(value:string)=>T,options:ReadOptions<D>,bounds?:NumericOptions<D>):T|D{
  checkName(option);let section=this.name;const source=this.#reader.source.original;
  const fallback=!Object.hasOwn(source,section)&&this.fallback!==undefined;if(fallback)section=this.fallback!;
  const exists=Object.hasOwn(source[section]??{},option.toLowerCase());let value:T|D;
  try{
   if(exists)value=parse(source[section][option.toLowerCase()]);
   else{if(!Object.hasOwn(options,'defaultValue'))throw new ConfigurationError('Required configuration option is missing');value=options.defaultValue!;section=this.name;validateJson(value);}
  }catch(error){this.#reader.error(this.name);throw new ConfigurationError(`[${this.name}]: Unable to parse option '${option}'`,{cause:error});}
  if(exists){
   if(options.deprecate)this.#reader.warn(`[${this.name}]: Option '${option}' is deprecated, see the configuration documentation at https://moonraker.readthedocs.io/en/latest/configuration/`);
   if(fallback)this.#reader.warn(`[${section}]: Option '${option}' has been moved to section [${this.name}].  Please correct your configuration, see https://moonraker.readthedocs.io/en/latest/configuration/#option-moved-deprecations for detailed documentation.`);
   if(bounds&&typeof value==='number'){
    for(const limit of [bounds.above,bounds.below,bounds.minval,bounds.maxval])if(limit!==undefined&&!Number.isFinite(limit))throw new ConfigurationError('Configuration bounds must be finite');
    if(bounds.above!==undefined&&value<=bounds.above||bounds.below!==undefined&&value>=bounds.below||bounds.minval!==undefined&&value<bounds.minval||bounds.maxval!==undefined&&value>bounds.maxval)throw new ConfigurationError(`[${this.name}]: Option '${option}' is outside its permitted range`);
   }
  }
  this.#reader.record(section,option,value);return value;
 }
 get<D extends Json=never>(option:string,options:ReadOptions<D>={}):string|D{return this.#get(option,v=>v,options);}
 getInt<D extends Json=never>(option:string,options:NumericOptions<D>={}):number|D{if(typeof options.defaultValue==='number'&&!Number.isSafeInteger(options.defaultValue))throw new ConfigurationError('Integer default must be a safe integer');return this.#get(option,v=>convert('int',v) as number,options,options);}
 getFloat<D extends Json=never>(option:string,options:NumericOptions<D>={}):number|D{return this.#get(option,v=>convert('float',v) as number,options,options);}
 getBoolean<D extends Json=never>(option:string,options:ReadOptions<D>={}):boolean|D{return this.#get(option,v=>{const value=booleans.get(v.toLowerCase());if(value===undefined)throw new ConfigurationError('Invalid boolean');return value;},options);}
 getChoice<T extends Json>(option:string,choices:readonly string[]|Record<string,T>,options:ReadOptions<string>&{forceLowercase?:boolean}={}):string|T{
  let result=this.get(option,options);if(options.forceLowercase)result=result.toLowerCase();
  if(Array.isArray(choices)){if(choices.includes(result))return result;}else if(Object.hasOwn(choices,result))return (choices as Record<string,T>)[result];
  throw new ConfigurationError(`[${this.name}]: Option '${option}' is not a permitted choice`);
 }
 getLists<D extends Json=never>(option:string,options:ListOptions<D>={}):Json[]|D{
  const separators=options.separators??['\n'],counts=options.count??separators.map(()=>null),type=options.type??'string';
  if(!separators.length||separators.length>8||counts.length!==separators.length||counts.some(n=>n!==null&&(!Number.isSafeInteger(n)||n<0)))throw new ConfigurationError('Invalid configuration list dimensions');
  return this.#get(option,text=>{let total=0;const parse=(value:string,level:number):Json[]=>{const result:Json[]=[];for(const item of split(value,separators[level])){const text=strip(item);if(!text)continue;if(++total>100000)throw new ConfigurationError('Configuration list exceeds item limit');result.push(level+1<separators.length?parse(text,level+1):convert(type,text));}if(counts[level]!==null&&result.length!==counts[level])throw new ConfigurationError('Configuration list length mismatch');return result;};return parse(text,0);},options);
 }
 getList<D extends Json=never>(option:string,options:ReadOptions<D>&{separator?:string|null;count?:number|null}={}):string[]|D{return this.getLists(option,{...options,type:'string',separators:[options.separator===undefined?'\n':options.separator],count:[options.count??null]}) as string[]|D;}
 getIntList<D extends Json=never>(option:string,options:ReadOptions<D>&{separator?:string|null;count?:number|null}={}):number[]|D{return this.getLists(option,{...options,type:'int',separators:[options.separator===undefined?'\n':options.separator],count:[options.count??null]}) as number[]|D;}
 getFloatList<D extends Json=never>(option:string,options:ReadOptions<D>&{separator?:string|null;count?:number|null}={}):number[]|D{return this.getLists(option,{...options,type:'float',separators:[options.separator===undefined?'\n':options.separator],count:[options.count??null]}) as number[]|D;}
 getDictionary<D extends Json=never>(option:string,options:DictionaryOptions<D>={}):Record<string,Json>|D{
  const separators=options.separators??['\n','='];if(separators.length!==2)throw new ConfigurationError('Dictionary requires two separators');
  return this.#get(option,text=>{const result=dict<Json>();let total=0;for(const line of split(text,separators[0])){const value=strip(line);if(!value)continue;if(++total>100000)throw new ConfigurationError('Configuration dictionary exceeds item limit');const parts=firstSplit(value,separators[1]);if(parts.length===1&&!options.allowEmptyFields)throw new ConfigurationError('Missing configuration dictionary delimiter');result[strip(parts[0])]=parts.length===1?null:convert(options.type??'string',strip(parts[1]));}return result;},options);
 }
}
