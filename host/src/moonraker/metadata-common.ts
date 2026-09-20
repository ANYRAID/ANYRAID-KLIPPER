import {metadataPattern} from './slicer-identification.ts';
import type {MetadataWindow} from './metadata-window.ts';
const startPattern=metadataPattern(String.raw`\n[MG]\d+\s.*\n`);
export function parseCommonMetadata(window:Pick<MetadataWindow,'header'|'footer'|'size'>):Record<string,number>{
 const result:Record<string,number>={},start=startPattern.exec(window.header);
 if(start)result.gcode_start_byte=Buffer.byteLength(window.header.slice(0,start.index));
 // A match spans at most two lines (its whitespace can be LF). The last
 // valid command start therefore has the rightmost terminating LF. Search native
 // string prefixes backwards, then test only its one/two-line candidate.
 let g=window.footer.lastIndexOf('\nG'),m=window.footer.lastIndexOf('\nM');
 while(g>=0||m>=0){
  const begin=Math.max(g,m),firstEnd=window.footer.indexOf('\n',begin+1);
  if(firstEnd>=0){const secondEnd=window.footer.indexOf('\n',firstEnd+1),candidate=window.footer.slice(begin,(secondEnd>=0?secondEnd:firstEnd)+1),match=startPattern.exec(candidate);
   if(match?.index===0){result.gcode_end_byte=window.size-Buffer.byteLength(window.footer.slice(begin+match[0].length));break;}
  }
  if(g===begin)g=begin>0?window.footer.lastIndexOf('\nG',begin-1):-1;
  if(m===begin)m=begin>0?window.footer.lastIndexOf('\nM',begin-1):-1;
 }
 return result;
}
const height=metadataPattern(String.raw`G1\sZ([0-9]*\.?[0-9]+)\s`,'g');
const temperatures=[['first_layer_extr_temp',/M109 S([0-9]*\.?[0-9]+)/u],['first_layer_bed_temp',/M190 S([0-9]*\.?[0-9]+)/u],['chamber_temp',/M191 S([0-9]*\.?[0-9]+)/u]] as const;
function finite(value:string):number{const number=Number(value);if(!Number.isFinite(number))throw new RangeError('Metadata numeric value is not finite');return number;}
/** Only the original UnknownSlicer fallback fields. Known families require their own parsers. */
export function parseUnknownMetadata(window:Pick<MetadataWindow,'header'|'footer'|'size'>):Record<string,number>{
 const result=parseCommonMetadata(window);
 for(const [field,data,min] of [['first_layer_height',window.header,true],['object_height',window.footer,false]] as const){
  let value:number|undefined;height.lastIndex=0;let match:RegExpExecArray|null;
  while((match=height.exec(data))!==null){const number=finite(match[1]);value=value===undefined?number:min?Math.min(value,number):Math.max(value,number);}
  if(value!==undefined)result[field]=value;
 }
 for(const [field,pattern] of temperatures){const match=pattern.exec(window.header);if(match)result[field]=finite(match[1]);}
 return result;
}
