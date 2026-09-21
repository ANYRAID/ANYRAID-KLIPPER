// GPL-3.0-or-later. Klipper file/include loading; bounded asynchronous I/O.
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {open,opendir,stat} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';
import {ConfigurationSource} from '../moonraker/config-source.ts';
import {KlipperConfigText} from './klipper-text.ts';
import {splitKlipperAutosave,stripAutosaveDuplicates} from './klipper-autosave.ts';
function globExpression(pattern:string):RegExp{
 let result='^';const literal=(s:string)=>s.replace(/[\\^$.*+?()[\]{}|]/g,'\\$&');
 for(let i=0;i<pattern.length;i++){const c=pattern[i];if(c==='*')result+='.*';else if(c==='?')result+='.';else if(c==='['){let end=i+1;if(pattern[end]==='!')end++;if(pattern[end]===']')end++;end=pattern.indexOf(']',end);if(end<0){result+='\\[';continue;}let inner=pattern.slice(i+1,end);const negate=inner.startsWith('!');if(negate)inner=inner.slice(1);inner=inner.replaceAll('\\','\\\\').replaceAll('^','\\^').replaceAll('[','\\[');result+='['+(negate?'^':'')+inner+']';i=end;}else result+=literal(c);}
 try{return new RegExp(result+'$','su');}catch{return /$a/;}
}

export interface KlipperFileVersion {readonly filename:string;readonly identity:string;readonly size:string;readonly mtimeNs:string;readonly ctimeNs:string;readonly mode:string;readonly uid:string;readonly gid:string;readonly sha256:string;}
export interface KlipperInspection {source:ConfigurationSource;regular:ConfigurationSource;versions:readonly KlipperFileVersion[];}
export interface KlipperFileLimits {bytes?:number;files?:number;depth?:number;directoryEntries?:number;signal?:AbortSignal;}
export async function loadKlipperConfiguration(filename:string,options:KlipperFileLimits={}):Promise<ConfigurationSource>{return (await load(filename,options)).source;}
/** Read-only candidate inspection: includes resolve relative to the real main
 * path; the original main file is opened and checked, never replaced. */
export async function inspectKlipperConfigurationCandidate(filename:string,text:string,options:KlipperFileLimits={},expectedMainText?:string):Promise<KlipperInspection>{return load(filename,options,text,expectedMainText);}
async function load(filename:string,options:KlipperFileLimits,mainText?:string,expectedMainText?:string):Promise<KlipperInspection>{
 const limits={bytes:options.bytes??8*1024*1024,files:options.files??256,depth:options.depth??64,directoryEntries:options.directoryEntries??16384};
 for(const n of Object.values(limits))if(!Number.isSafeInteger(n)||n<1)throw new RangeError('Invalid Klipper configuration limits');
 if(!filename||filename.includes('\0'))throw new RangeError('Invalid configuration path');
 const check=()=>options.signal?.throwIfAborted();check();
 const versions:KlipperFileVersion[]=[];
 const parsed=new KlipperConfigText(),active=new Set<string>(),files:{filename:string;sections:string[]}[]=[];let bytes=0,entries=0,autosave='';
 async function expand(pattern:string):Promise<string[]>{
  const parts=pattern.split('/').filter(Boolean);if(parts.length>limits.depth)throw new RangeError('Include path depth exceeded');
  let candidates=['/'];for(const part of parts){const next:string[]=[];for(const base of candidates){check();const path=base+(base.endsWith('/')?'':'/')+part;
    if(!/[*?[]/.test(part)){next.push(path);continue;}
    let directory;try{directory=await opendir(base);}catch(error){if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))continue;throw error;}
    const expression=globExpression(part);for await(const entry of directory){check();if(++entries>limits.directoryEntries)throw new RangeError('Include directory budget exceeded');if(entry.name.startsWith('.')&&!part.startsWith('.'))continue;if(expression.test(entry.name))next.push(base+(base.endsWith('/')?'':'/')+entry.name);}
   }candidates=next;}
  const found:string[]=[];for(const path of candidates){try{await stat(path);found.push(path);}catch(error){if(!['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))throw error;}}
  // Python sorts by Unicode scalar value rather than UTF-16 code unit.
  found.sort((a,b)=>{const aa=Array.from(a),bb=Array.from(b);for(let i=0;i<Math.min(aa.length,bb.length);i++){const d=aa[i].codePointAt(0)!-bb[i].codePointAt(0)!;if(d)return d;}return aa.length-bb.length;});return found;
 }
 async function read(path:string,depth:number,main=false):Promise<void>{
  check();if(depth>limits.depth||files.length>=limits.files)throw new RangeError('Configuration include budget exceeded');
  const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);let identity='',text='';
  try{const info=await file.stat({bigint:true});if(!info.isFile())throw new Error('Configuration must be a regular file');identity=String(info.dev)+':'+String(info.ino);if(active.has(identity))throw new Error('Recursive Klipper include');if(info.size>BigInt(limits.bytes-bytes))throw new RangeError('Configuration byte budget exceeded');
   const chunks:Buffer[]=[],hash=createHash('sha256');for(;;){check();const buffer=Buffer.allocUnsafe(Math.min(65536,limits.bytes-bytes+1));const result=await file.read(buffer,0,buffer.length,null);if(!result.bytesRead)break;bytes+=result.bytesRead;if(bytes>limits.bytes)throw new RangeError('Configuration byte budget exceeded');const chunk=buffer.subarray(0,result.bytesRead);chunks.push(chunk);hash.update(chunk);}const after=await file.stat({bigint:true});if(info.dev!==after.dev||info.ino!==after.ino||info.size!==after.size||info.mtimeNs!==after.mtimeNs||info.ctimeNs!==after.ctimeNs||info.mode!==after.mode||info.uid!==after.uid||info.gid!==after.gid)throw new Error('Configuration changed during read');versions.push(Object.freeze({filename:path,identity,size:String(info.size),mtimeNs:String(info.mtimeNs),ctimeNs:String(info.ctimeNs),mode:String(info.mode),uid:String(info.uid),gid:String(info.gid),sha256:hash.digest('hex')}));text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks)).replace(/\r\n|\r/g,'\n');
  }finally{await file.close();}
  active.add(identity);const metadata={filename:path,sections:[] as string[]};files.push(metadata);
  try{if(main){if(expectedMainText!==undefined&&text!==expectedMainText.replace(/\r\n|\r/g,'\n'))throw new Error('Main configuration changed during save preparation');if(mainText!==undefined){bytes+=Buffer.byteLength(mainText);if(bytes>limits.bytes)throw new RangeError('Configuration byte budget exceeded');text=mainText.replace(/\r\n|\r/g,'\n');}const parts=splitKlipperAutosave(text);if(parts.status==='corrupt')throw new Error('Corrupt Klipper autosave: '+parts.reason);text=parts.regular;autosave=parts.autosave;}
   let buffer:string[]=[];const append=()=>{for(const section of parsed.append(buffer.join('\n')))if(!metadata.sections.includes(section))metadata.sections.push(section);buffer=[];};
   for(const raw of text.split('\n')){check();const line=raw.split('#',1)[0],header=line.match(/^\[(.+)\]/)?.[1];if(header?.startsWith('include ')){append();const spec=header.slice(8).trim();if(!spec)throw new Error('Empty Klipper include');const pattern=isAbsolute(spec)?spec:dirname(path)+'/'+spec;const matches=await expand(pattern);if(!matches.length&&!/[*?[]/.test(pattern))throw new Error('Missing Klipper include: '+spec);for(const child of matches)await read(child,depth+1);}else buffer.push(line);}append();
  }finally{active.delete(identity);}
 }
 const main=resolve(filename);await read(main,0,true);const regularValues=parsed.values(),regularFiles=files.map(f=>({...f,sections:[...f.sections]}));const saved=stripAutosaveDuplicates(autosave,(s,k)=>parsed.hasOption(s,k));for(const section of parsed.append(saved))if(!files[0].sections.includes(section))files[0].sections.push(section);check();return {versions:Object.freeze(versions),source:new ConfigurationSource(main,parsed.values(),files),regular:new ConfigurationSource(main,regularValues,regularFiles)};
}
