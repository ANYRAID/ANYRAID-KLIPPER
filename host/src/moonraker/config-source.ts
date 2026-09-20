// File source semantics from pinned Moonraker confighelper.py (GPL-3.0-or-later).
import {constants} from 'node:fs';
import {open,opendir,realpath,stat} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {homedir} from 'node:os';
import {ServerConfiguration,type ConfigurationSnapshot} from './metadata.ts';

export class ConfigurationError extends Error {}
export interface ConfigurationLimits {bytes?:number;files?:number;depth?:number;directoryEntries?:number;}
type Values=Record<string,string>;
const dictionary=<T>():Record<string,T>=>Object.create(null);
const fail=(message:string):never=>{throw new ConfigurationError(message);};
// Python str.strip/splitlines whitespace, without JavaScript's BOM whitespace.
const whitespace='\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const left=new RegExp(`^[${whitespace}]*`),edges=new RegExp(`^[${whitespace}]+|[${whitespace}]+$`,'g');
const strip=(s:string)=>s.replace(edges,'');
const indent=(s:string)=>s.match(left)![0].length;
const append=(directory:string,name:string)=>`${directory===sep?'':directory}/${name}`;
function expandTabs(s:string):string{let out='',column=0;for(const c of s){if(c==='\t'){const count=4-column%4;out+=' '.repeat(count);column+=count;}else{out+=c;column++;}}return out;}
// pathlib patterns have no brace, extglob, or backslash-escape syntax.
function globExpression(pattern:string):RegExp{
 let result='^';const literal=(s:string)=>s.replace(/[\\^$.*+?()[\]{}|]/g,'\\$&');
 for(let i=0;i<pattern.length;i++){const c=pattern[i];if(c==='*')result+='.*';else if(c==='?')result+='.';else if(c==='['){let end=i+1;if(pattern[end]==='!')end++;if(pattern[end]===']')end++;end=pattern.indexOf(']',end);if(end<0){result+='\\[';continue;}let inner=pattern.slice(i+1,end);const negate=inner.startsWith('!');if(negate)inner=inner.slice(1);inner=inner.replaceAll('\\','\\\\').replaceAll('^','\\^').replaceAll('[','\\[');result+='['+(negate?'^':'')+inner+']';i=end;}else result+=literal(c);}
 try{return new RegExp(result+'$','u');}catch{return /$a/;}
}
/** Immutable file-backed raw source. Typed/defaulted values are recorded by
 * component config readers later; raw strings must never masquerade as parsed. */
export class ConfigurationSource {
 readonly primaryFile:string;
 readonly original:Record<string,Values>;
 readonly files:readonly {filename:string;sections:readonly string[]}[];
 constructor(primaryFile:string,original:Record<string,Values>,files:{filename:string;sections:string[]}[]){
  this.primaryFile=primaryFile;for(const values of Object.values(original))Object.freeze(values);this.original=Object.freeze(original);
  this.files=Object.freeze(files.map(f=>Object.freeze({...f,sections:Object.freeze(f.sections)})));Object.freeze(this);
 }
 snapshot(parsed:ConfigurationSnapshot['parsed']):ConfigurationSnapshot{return {primaryFile:this.primaryFile,original:this.original,files:this.files,parsed};}
 publish(target:ServerConfiguration,parsed:ConfigurationSnapshot['parsed']):void{target.replace(this.snapshot(parsed));}
}
/** Read completely before publication. Includes cannot start a partial reload.
 * Async filesystem access; no writes, template execution, or device effects. */
export async function loadConfiguration(filename:string,limits:ConfigurationLimits={}):Promise<ConfigurationSource>{
 const maximum={bytes:limits.bytes??8*1024*1024,files:limits.files??256,depth:limits.depth??64,directoryEntries:limits.directoryEntries??16384};
 for(const n of Object.values(maximum))if(!Number.isSafeInteger(n)||n<1)fail('Invalid configuration resource limit');
 if(typeof filename!=='string'||!filename||filename.includes('\0'))fail('Invalid configuration filename');
 if(filename==='~'||filename.startsWith('~/'))filename=join(homedir(),filename.slice(2));
 const main=resolve(filename),defaults:Values=dictionary(),sections:Record<string,Values>=dictionary();
 const files:{filename:string;sections:string[]}[]=[],sectionFiles=new Map<string,number[]>(),visited=new Set<string>();
 let bytes=0,entries=0;
 async function matches(pattern:string,base:string):Promise<string[]>{
  if(pattern.includes('\0'))fail('Invalid include filename');
  const directoriesOnly=!isAbsolute(pattern)&&pattern.endsWith('/');
  let root=base,parts=pattern.split('/').filter(part=>part!==''&&part!=='.');
  if(isAbsolute(pattern)){
   // Path.resolve(strict=False), then parent.glob(name): absolute includes
   // resolve symlinks before '..' and only glob the final path component.
   let resolved:string=sep;
   for(const part of parts){if(part==='..'){resolved=dirname(resolved);continue;}const next=join(resolved,part);try{resolved=await realpath(next);}catch(error){if(!['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))throw error;resolved=next;}}
   root=dirname(resolved);parts=[basename(resolved)];
  }
  const found=new Set<string>();
  async function walk(directory:string,index:number,level:number):Promise<void>{
   if(level>maximum.depth)fail('Include directory depth limit exceeded');
   if(index===parts.length){try{const info=await stat(directory);if(!directoriesOnly||info.isDirectory())found.add(directory);}catch(e){if(!['ENOENT','ENOTDIR'].includes((e as NodeJS.ErrnoException).code??''))throw e;}return;}
   const part=parts[index];
   if(part==='..'){await walk(append(directory,part),index+1,level+1);return;}
   if(part.includes('**')&&part!=='**')fail('Invalid recursive include pattern');
   if(part==='**')await walk(directory,index+1,level+1);
   let children;try{children=await opendir(directory);}catch(e){if(['ENOENT','ENOTDIR'].includes((e as NodeJS.ErrnoException).code??''))return;throw e;}
   const matcher=globExpression(part);
   for await(const child of children){if(++entries>maximum.directoryEntries)fail('Include directory entry limit exceeded');const path=append(directory,child.name);if(part==='**'){if(child.isDirectory())await walk(path,index,level+1);}else if(matcher.test(child.name))await walk(path,index+1,level+1);}
  }
  await walk(root,0,0);
  // Python sorts Unicode code points, not UTF-16 surrogate units.
  return [...found].sort((a,b)=>{const x=[...a],y=[...b];for(let i=0;i<Math.min(x.length,y.length);i++){const d=x[i].codePointAt(0)!-y[i].codePointAt(0)!;if(d)return d;}return x.length-y.length;});
 }
 function parseBuffer(lines:string[],path:string):void{
  let current:Values|undefined,sectionName='',option:string|undefined,previousIndent=0;
  const seenSections=new Set<string>(),seenOptions=new Set<string>();
  for(const line of lines){const value=strip(line);if(!value||value.startsWith('#')||value.startsWith(';'))continue;
   const level=indent(line);
   if(current&&option!==undefined&&level>previousIndent){current[option]+='\n'+value;continue;}
   previousIndent=level;
   // ConfigParser's section expression is greedy, unlike the source scanner.
   const section=value.match(/^\[(.+)\]/s);
   if(section){const name=section[1];sectionName=name;if(name==='DEFAULT')current=defaults;else{if(seenSections.has(name))fail(`Duplicate section in ${path}`);seenSections.add(name);current=sections[name]??(sections[name]=dictionary());}option=undefined;continue;}
   if(!current)fail(`Option outside a section in ${path}`);
   const match=value.match(/^(.+?)(?:=|:)(.*)$/s);if(!match)fail(`Invalid configuration option in ${path}`);
   option=strip(match![1]).toLowerCase();if(!option)fail(`Empty configuration option in ${path}`);
   const key=JSON.stringify([sectionName,option]);
   if(seenOptions.has(key))fail(`Duplicate option in ${path}`);seenOptions.add(key);current![option]=strip(match![2]);
  }
 }
 async function read(path:string,depth:number):Promise<void>{
  if(depth>maximum.depth||files.length>=maximum.files)fail('Configuration include limit exceeded');
  const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);
  let text:string;
  try{const info=await file.stat({bigint:true});if(!info.isFile())fail(`Configuration is not a regular file: ${path}`);const identity=`${info.dev}:${info.ino}`;if(visited.has(identity))fail(`Recursive include directive detected: ${path}`);visited.add(identity);
   if(info.size>BigInt(maximum.bytes-bytes))fail('Configuration byte limit exceeded');
   const chunks:Buffer[]=[];for(;;){const buffer=Buffer.allocUnsafe(Math.min(65536,maximum.bytes-bytes+1));const {bytesRead}=await file.read(buffer,0,buffer.length,null);if(!bytesRead)break;bytes+=bytesRead;if(bytes>maximum.bytes)fail('Configuration byte limit exceeded');chunks.push(buffer.subarray(0,bytesRead));}
   text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks));
  }finally{await file.close();}
  const index=files.length;files.push({filename:path,sections:[]});let buffer:string[]=[],lastSection='',optionIndent=-1;const options=new Set<string>();
  for(let line of text!.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)){
   const trimmed=strip(line);if(!trimmed||trimmed.startsWith('#')||trimmed.startsWith(';'))continue;
   line=expandTabs(line).replace(/ +[#;].*$/s,'').replace(/ \\([#;])/g,' $1');
   const level=indent(line);if(optionIndent!==-1&&level>optionIndent){buffer.push(line);continue;}
   const match=line.slice(level).match(/^\[([^\]]+)\]/s);
   if(match){optionIndent=-1;const section=match[1];if(section.startsWith('include ')){
    const pattern=strip(section.slice(8));if(!pattern)fail('Invalid include directive');const paths=await matches(pattern,dirname(path));if(!paths.length)fail(`No files matching include directive in ${path}`);
    parseBuffer(buffer,path);buffer=[];for(const child of paths)await read(child,depth+1);continue;
   }
   lastSection=section;const owners=sectionFiles.get(section)??[];if(owners.includes(index))fail(`Duplicate section in ${path}`);owners.unshift(index);sectionFiles.set(section,owners);
   }else{optionIndent=level;const option=strip(line.split(/[:=]/,1)[0]),key=JSON.stringify([lastSection,option]);if(options.has(key))fail(`Duplicate option in ${path}`);options.add(key);}
   buffer.push(line);
  }
  parseBuffer(buffer,path);
 }
 try{await read(main,0);if(!Object.hasOwn(sections,'server'))fail('No section [server] in config');
  const original:Record<string,Values>=dictionary();original.DEFAULT={...defaults};for(const [key,values]of Object.entries(sections))original[key]=Object.assign(dictionary<string>(),defaults,values);
  for(const [section,owners]of sectionFiles)for(const owner of owners)files[owner].sections.push(section);
  return new ConfigurationSource(await realpath(main),original,files);
 }catch(error){if(error instanceof ConfigurationError)throw error;throw new ConfigurationError('Unable to read configuration source',{cause:error});}
}
