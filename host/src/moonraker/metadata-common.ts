import {metadataPattern} from './slicer-identification.ts';
import type {MetadataWindow} from './metadata-window.ts';
const startPattern=metadataPattern(String.raw`\n[MG]\d+\s.*\n`),endPattern=metadataPattern(String.raw`\n[MG]\d+\s.*\n`,'g');
export function parseCommonMetadata(window:Pick<MetadataWindow,'header'|'footer'|'size'>):Record<string,number>{
 const result:Record<string,number>={},start=startPattern.exec(window.header);
 if(start)result.gcode_start_byte=Buffer.byteLength(window.header.slice(0,start.index));
 // Search overlapping forward matches to find the rightmost terminating LF.
 // Equivalent to Python's reversed search, without allocating reversed codepoints.
 endPattern.lastIndex=0;let end:RegExpExecArray|null,last=-1;
 while((end=endPattern.exec(window.footer))!==null){last=Math.max(last,end.index+end[0].length);endPattern.lastIndex=end.index+1;}
 if(last>=0)result.gcode_end_byte=window.size-Buffer.byteLength(window.footer.slice(last));
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
