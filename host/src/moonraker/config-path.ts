// Linux pathlib.Path.expanduser().resolve() semantics for pinned Moonraker.
// Follow each symlink before processing '..'; a valid long chain is not a loop.
import {lstatSync,readlinkSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {ConfigurationError} from './config-source.ts';
import {unixUserHome} from './unix-peer.ts';
const invalid=()=>new ConfigurationError('Unable to resolve configuration path');
const append=(base:string,part:string)=>base?(base==='/'?'/'+part:base+'/'+part):part;
type Step={part:string}|{link:string};
/** Startup only. Resolved values are private: errors never expose them. Missing
 * and inaccessible components remain paths, as upstream strict=False does. */
export function resolveConfigurationPath(source:string):string{
 try{
  if(typeof source!=='string'||source.includes('\0'))throw invalid();
  let absolute=source.startsWith('/'),parts=source.split('/').filter(part=>part&&part!=='.');
  if(!absolute&&parts[0]?.startsWith('~')){
   const user=parts.shift()!.slice(1),home=user?unixUserHome(user):process.env.HOME??unixUserHome();
   if(home===null)throw invalid();const expanded=home||'/';absolute=expanded.startsWith('/');parts=[...expanded.split('/').filter(part=>part&&part!=='.'),...parts];
  }
  let current=absolute?'/':'';const seen=new Map<string,string|null>(),steps:Step[]=parts.reverse().map(part=>({part}));
  while(steps.length){const step=steps.pop()!;
   if('link'in step){seen.set(step.link,current);continue;}
   const part=step.part;if(!part||part==='.')continue;
   if(part==='..'){if(current==='/'||current==='')current=current===''?'..':'/';else if(current==='..'||current.endsWith('/..'))current+='/..';else current=dirname(current)==='.'?'':dirname(current);continue;}
   const next=append(current,part);let link=false;
   try{link=lstatSync(next).isSymbolicLink();}catch(error){if(typeof(error as NodeJS.ErrnoException).errno!=='number')throw error;}
   if(!link){current=next;continue;}
   if(seen.has(next)){const cached=seen.get(next);if(cached===null)throw invalid();current=cached!;continue;}
   seen.set(next,null);const target=readlinkSync(next);if(target.startsWith('/'))current='/';
   steps.push({link:next});for(const part of target.split('/').reverse())steps.push({part});
  }
  return resolve(current||'.');
 }catch{throw invalid();}
}
