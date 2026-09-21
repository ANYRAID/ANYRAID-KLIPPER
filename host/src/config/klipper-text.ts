// GPL-3.0-or-later. ConfigFileReader / RawConfigParser text semantics.
import {ConfigurationSource} from '../moonraker/config-source.ts';
import {splitKlipperAutosave,stripAutosaveDuplicates} from './klipper-autosave.ts';
const ws='\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u3000',edges=new RegExp(`^[${ws}]+|[${ws}]+$`,'g'),leading=new RegExp(`^[${ws}]*`),space=new RegExp(`[${ws}]`);
const trim=(s:string)=>s.replace(edges,'');
const dict=<T>():Record<string,T>=>Object.create(null);
/** Appends already-expanded text buffers. Each append starts without a section,
 * like read_file; failed buffers do not publish partially parsed values. */
export class KlipperConfigText {
 #sections:Record<string,Record<string,string>>=dict();
 append(text:string):string[]{
  const touched=new Set<string>();
  if(typeof text!=='string'||Buffer.byteLength(text)>8*1024*1024)throw new RangeError('Klipper config text limit exceeded');
  const staged:Record<string,Record<string,string[]>>=dict();for(const [section,values] of Object.entries(this.#sections)){staged[section]=dict();for(const [key,value] of Object.entries(values))staged[section][key]=[value];}
  let current:Record<string,string[]>|undefined,option:string|undefined,indent=0,items=0;
  for(const raw of text.split('\n')){
   let line=raw.split('#',1)[0],comment=line!==raw;
   for(let i=0;i<line.length;i++)if(line[i]===';'&&(i===0||space.test(line[i-1]))){line=line.slice(0,i);comment=true;break;}
   const value=trim(line);
   if(!value){if(!comment&&current&&option!==undefined)current[option].push('');continue;}
   const level=line.match(leading)![0].length;
   if(current&&option!==undefined&&level>indent){current[option].push(value);continue;}
   indent=level;const header=value.match(/^\[(.+)\]/);
   if(header){const name=header[1];touched.add(name);current=staged[name]??(staged[name]=dict());option=undefined;if(++items>100000)throw new RangeError('Config item limit exceeded');continue;}
   if(!current)throw new Error('Klipper config option outside a section');
   const match=value.match(/^(.*?)\s*[:=]\s*(.*)$/);if(!match||!trim(match[1]))throw new Error('Invalid Klipper config line');
   option=trim(match[1]).toLowerCase();current[option]=[trim(match[2])];if(++items>100000)throw new RangeError('Config item limit exceeded');
  }
  const complete:Record<string,Record<string,string>>=dict();for(const [name,values] of Object.entries(staged)){complete[name]=dict();for(const [key,value] of Object.entries(values))complete[name][key]=value.join('\n').replace(new RegExp(`[${ws}]+$`),'');}this.#sections=complete;return [...touched].filter(s=>s!=='DEFAULT');
 }
 sections():string[]{return Object.keys(this.#sections).filter(s=>s!=='DEFAULT');}
 hasOption(section:string|null,option:string):boolean{const key=option.toLowerCase();if(!section||section==='DEFAULT')return Object.hasOwn(this.#sections.DEFAULT??{},key);if(!Object.hasOwn(this.#sections,section))return false;return Object.hasOwn(this.#sections[section],key)||Object.hasOwn(this.#sections.DEFAULT??{},key);}
 /** Explicit options only: persistence must not materialize DEFAULT inheritance. */
 rawValues():Record<string,Record<string,string>>{const result:Record<string,Record<string,string>>=dict();for(const [name,values] of Object.entries(this.#sections))result[name]=Object.assign(dict<string>(),values);return result;}
 values():Record<string,Record<string,string>>{const result:Record<string,Record<string,string>>=dict();result.DEFAULT={...(this.#sections.DEFAULT??{})};for(const name of this.sections())result[name]=Object.assign(dict<string>(),result.DEFAULT,this.#sections[name]);return result;}
}
/** Main-file text path without include expansion. Rejects includes explicitly;
 * never silently omits their settings. No disk writes or device activation. */
export function parseKlipperMainText(text:string,filename:string):ConfigurationSource {
 const parts=splitKlipperAutosave(text.replace(/\r\n|\r/g,'\n'));if(parts.status==='corrupt')throw new Error(`Corrupt Klipper autosave: ${parts.reason}`);
 const parsed=new KlipperConfigText();parsed.append(parts.regular);
 if(parsed.sections().some(s=>s.startsWith('include ')))throw new Error('Klipper include expansion is required');
 parsed.append(stripAutosaveDuplicates(parts.autosave,(s,k)=>parsed.hasOption(s,k)));
 if(parsed.sections().some(s=>s.startsWith('include ')))throw new Error('Klipper include expansion is required');
 return new ConfigurationSource(filename,parsed.values(),[{filename,sections:parsed.sections()}]);
}
