// GPL-3.0-or-later. SAVE_CONFIG content generation; no filesystem side effects.
import {AUTOSAVE_HEADER,splitKlipperAutosave,stripAutosaveDuplicates} from './klipper-autosave.ts';
import {KlipperConfigText} from './klipper-text.ts';
export type SavedConfiguration=Readonly<Record<string,Readonly<Record<string,string>>>>;
const ws='\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u3000';
const edges=new RegExp(`^[${ws}]+|[${ws}]+$`,'g'),right=new RegExp(`[${ws}]+$`);
const trim=(s:string)=>s.replace(edges,'');
/** Builds a reviewable candidate. The caller must still expand the resulting
 * regular text and reject include conflicts before any durable replacement. */
export function buildKlipperSave(current:string,saved:SavedConfiguration,allowEmpty=false):{text:string;regular:string;autosave:string}|null{
 const parts=splitKlipperAutosave(current.replace(/\r\n|\r/g,'\n'));if(parts.status==='corrupt')throw new Error('Cannot save corrupted Klipper autosave');
 const names=Object.keys(saved);if(!allowEmpty&&!names.some(n=>n!=='DEFAULT'))return null;
 if(names.length>1024)throw new RangeError('Saved section budget exceeded');
 const expected:Record<string,Record<string,string>>=Object.create(null),blocks:string[]=[];let bytes=0,count=0;
 const order=[...names.filter(n=>n==='DEFAULT'&&Object.keys(saved[n]).length),...names.filter(n=>n!=='DEFAULT')];
 for(const name of order){if(!name||/[\r\n\0]/.test(name)||name.startsWith('include ')||!name.isWellFormed())throw new RangeError('Invalid saved section');
  const values=saved[name];if(!values||typeof values!=='object'||Array.isArray(values))throw new RangeError('Invalid saved values');expected[name]=Object.create(null);const lines=[`[${name}]`];
  for(const [raw,value] of Object.entries(values)){const key=raw.toLowerCase();if(!key||trim(key)!==key||/[\r\n\0:=#;]/.test(key)||key.startsWith('[')||!key.isWellFormed()||Object.hasOwn(expected[name],key)||typeof value!=='string'||value.includes('\0')||!value.isWellFormed())throw new RangeError('Invalid or duplicate saved option');
   if(++count>100000)throw new RangeError('Saved option budget exceeded');const line=`${key} = ${value.replaceAll('\n','\n\t')}`;bytes+=Buffer.byteLength(line)+1;if(bytes>8*1024*1024)throw new RangeError('Saved config byte budget exceeded');lines.push(line);expected[name][key]=value.split('\n').map(trim).join('\n').replace(right,'');
  }blocks.push(lines.join('\n')+'\n');
 }
 const body=trim(blocks.join('\n')),parser=new KlipperConfigText();parser.append(body);const actual=parser.values();
 for(const name of order){const want=Object.assign(Object.create(null),expected.DEFAULT??{},expected[name]);if(JSON.stringify(actual[name])!==JSON.stringify(want))throw new Error('Saved values cannot round-trip through Klipper config');}
 const regular=stripAutosaveDuplicates(parts.regular,(s,k)=>parser.hasOption(s,k)).replace(right,'');
 const autosave='\n'+AUTOSAVE_HEADER.replace(right,'')+'\n'+body.split('\n').map(line=>trim('#*# '+line)).join('\n')+'\n';
 const text=regular+autosave,verified=splitKlipperAutosave(text);if(verified.status!=='valid')throw new Error('Generated Klipper autosave failed validation');
 return {text,regular:verified.regular,autosave:verified.autosave};
}
