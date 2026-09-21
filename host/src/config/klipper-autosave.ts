// GPL-3.0-or-later. ConfigAutoSave text rules from klippy/configfile.py.
export const AUTOSAVE_HEADER='\n#*# <---------------------- SAVE_CONFIG ---------------------->\n#*# DO NOT EDIT THIS BLOCK OR BELOW. The contents are auto-generated.\n#*#\n';
const whitespace='\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u3000';
const edges=new RegExp(`^[${whitespace}]+|[${whitespace}]+$`,'g'),right=new RegExp(`[${whitespace}]+$`),firstSpace=new RegExp(`^[${whitespace}]`);
function bounded(data:string):void{if(typeof data!=='string'||Buffer.byteLength(data,'utf8')>8*1024*1024)throw new RangeError('Klipper config text limit exceeded');}
export interface AutosaveParts {regular:string;autosave:string;status:'absent'|'valid'|'corrupt';reason?:'duplicate-or-stray-marker'|'modified-tail';}
/** Input has already undergone text-file newline normalization. Corruption is
 * reported explicitly; callers must not silently treat it as a usable save. */
export function splitKlipperAutosave(data:string):AutosaveParts {
 bounded(data);const position=data.indexOf(AUTOSAVE_HEADER),regular=position<0?data:data.slice(0,position),saved=position<0?'':data.slice(position+AUTOSAVE_HEADER.length).replace(edges,'');
 if(regular.includes('\n#*# ')||saved.includes(AUTOSAVE_HEADER))return {regular:data,autosave:'',status:'corrupt',reason:'duplicate-or-stray-marker'};
 const out=[''];for(const line of saved.split('\n')){if(saved&&(!line.startsWith('#*#')||(line.length>=4&&!line.startsWith('#*# '))))return {regular:data,autosave:'',status:'corrupt',reason:'modified-tail'};out.push(line.slice(4));}out.push('');
 return {regular,autosave:out.join('\n'),status:position<0?'absent':'valid'};
}
/** Ordinary/include values win. Comments out complete duplicate value blocks;
 * does not rewrite or save a file. Section names remain case-sensitive. */
export function stripAutosaveDuplicates(data:string,hasOption:(section:string|null,option:string)=>boolean):string {
 bounded(data);const lines=data.split('\n');let section:string|null=null,duplicate=false;
 for(let i=0;i<lines.length;i++){const pruned=lines[i].replace(/[#;].*$/,'').replace(right,'');if(!pruned)continue;if(firstSpace.test(pruned)){if(duplicate)lines[i]='#'+lines[i];continue;}duplicate=false;if(pruned[0]==='['){section=pruned.slice(1,-1).replace(edges,'');continue;}const field=pruned.replace(/[^A-Za-z0-9_].*$/,'');if(hasOption(section,field)){duplicate=true;lines[i]='#'+lines[i];}}
 return lines.join('\n');
}
