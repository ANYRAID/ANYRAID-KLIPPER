import type {MetadataWindow} from './metadata-window.ts';
import {parseCommonMetadata} from './metadata-common.ts';
import {metadataPattern} from './slicer-identification.ts';
import {findFloat,findFloats,findInteger,findString,metadataInteger,metadataNumber,metadataRegex,metadataSum,pythonStrip,roundMetadataDecimal} from './metadata-values.ts';
export type OtherFamily='Cura'|'Simplify3D'|'KISSlicer'|'IdeaMaker'|'IceSL'|'KiriMoto';
export type OtherFields=Record<string,number|string|number[]>;
const v5Temperature=(kind:string)=>metadataPattern(String.raw`;\s+temperatureController,.+?;\s+temperatureType,${kind}.+?;\s+temperatureSetpoints,\d+\|(\d+)`,'s');
const v5Extruder=v5Temperature('extruder'),v5Bed=v5Temperature('platform');
const floatSyntax=metadataPattern(String.raw`^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$`);
function legacyTemperature(header:string,name:string):number|undefined{
 const heaters=metadataRegex('temperatureName.*').exec(header)?.[0].split(',').slice(1)??[],temps=metadataRegex('temperatureSetpointTemperatures.*').exec(header)?.[0].split(',').slice(1)??[];
 for(let i=0;i<Math.min(heaters.length,temps.length);i++)if(heaters[i]===name){const text=pythonStrip(temps[i]);if(/[\x1c-\x1f]/.test(temps[i]))return undefined;if(/^[+-]?(inf(?:inity)?|nan)$/i.test(text))throw new RangeError('Nonfinite metadata temperature');return floatSyntax.test(text)?metadataNumber(text.replaceAll('_','')):undefined;}return undefined;
}
/** Remaining fixed upstream families, excluding images and object rewriting. */
export function parseOtherMetadata(window:Pick<MetadataWindow,'header'|'footer'|'size'>,family:OtherFamily,version='?'):OtherFields{
 const result:OtherFields=parseCommonMetadata(window),h=window.header,f=window.footer;
 const put=(key:string,value:OtherFields[string]|undefined)=>{if(value!==undefined)result[key]=value;};
 const floats=(items:[string,string][],data:string)=>{for(const [key,pattern] of items)put(key,findFloat(pattern,data));};
 const maximum=(key:string,pattern:string,data:string,min=false)=>{const values=findFloats(pattern,data);if(values.length)put(key,values.reduce((a,b)=>min?Math.min(a,b):Math.max(a,b)));};
 if(family==='Cura'){
  floats([['first_layer_height',';MINZ:(%F)'],['layer_height',String.raw`;Layer\sheight:\s(%F)`],['object_height',';MAXZ:(%F)'],['first_layer_extr_temp','M109 S(%F)'],['first_layer_bed_temp','M190 S(%F)'],['chamber_temp','M191 S(%F)'],['nozzle_diameter',String.raw`;Nozzle\sdiameter\s=\s(%F)`]],h);
  maximum('estimated_time',';TIME:(%F)',h);put('layer_count',findInteger(';LAYER_COUNT:(%D)',h));
  const line=findString(String.raw`;Filament\sused:\s(%S)\n`,h);if(line){const values=findFloats('(%F)',line);if(values.length)put('filament_total',metadataSum(values.map(v=>v*1000)));}
  const weightLine=findString(String.raw`;Filament\sweight\s=\s\[(%S)\]`,h);if(weightLine){const values=findFloats('(%F)',weightLine);if(values.length){put('filament_weights',values);put('filament_weight_total',metadataSum(values));}}
  for(const field of ['name','type'])put('filament_'+field,findString(String.raw`;Filament\s${field}\s=\s(%S)`,h));
 }else if(family==='Simplify3D'){
  maximum('first_layer_height',String.raw`G1\sZ(%F)\s`,h,true);maximum('object_height',String.raw`G1\sZ(%F)\s`,f);
  floats([['layer_height',String.raw`;\s+layerHeight,(%F)`],['nozzle_diameter',String.raw`;\s+(?:extruderDiameter|nozzleDiameter),(%F)`]],h);
  floats([['filament_total',String.raw`;\s+(?:Filament\slength|Material\sLength):\s(%F)\smm`],['filament_weight_total',String.raw`;\s+(?:Plastic\sweight|Material\sWeight):\s(%F)\sg`]],f);
  put('filament_name',findString(String.raw`;\s+printMaterial,(%S)`,h));put('filament_type',findString(String.raw`;\s+makerBotModelMaterial,(%S)`,f));
  const time=metadataRegex(String.raw`;\s+Build (t|T)ime:.*`).exec(f);if(time){let total=0;for(const [pattern,multiplier] of [[String.raw`(\d+)\shours?`,3600],[String.raw`(\d+)\smin`,60],[String.raw`(\d+)\ssec`,1]] as const){const match=metadataRegex(pattern).exec(time[0]);if(match)total+=metadataInteger(match[1])!*multiplier;}if(!Number.isSafeInteger(total))throw new RangeError('Unsafe metadata duration');put('estimated_time',total);}
  for(const [field,name,pattern] of [['first_layer_extr_temp','Extruder 1',v5Extruder],['first_layer_bed_temp','Heated Bed',v5Bed]] as const){const match=version.startsWith('5')?pattern.exec(h):null;put(field,version.startsWith('5')?(match?metadataNumber(match[1]):undefined):legacyTemperature(h,name));}
 }else if(family==='KISSlicer'){
  floats([['first_layer_height',String.raw`;\s+first_layer_thickness_mm\s=\s(%F)`],['layer_height',String.raw`;\s+max_layer_thickness_mm\s=\s(%F)`],['first_layer_extr_temp','; first_layer_C = (%F)'],['first_layer_bed_temp','; bed_C = (%F)'],['chamber_temp','; chamber_C = (%F)']],h);
  maximum('object_height',String.raw`;\sEND_LAYER_OBJECT\sz=(%F)`,f);
  const lengths=findFloats(String.raw`;\s+Ext #\d+\s+=\s+(%F)\s*mm`,f);if(lengths.length)put('filament_total',metadataSum(lengths));
  const minutes=findFloat(String.raw`;\sCalculated.*Build\sTime:\s(%F)\sminutes`,f);if(minutes!==undefined)put('estimated_time',roundMetadataDecimal(minutes*60,2));
 }else if(family==='IdeaMaker'){
  floats([['first_layer_height',String.raw`;LAYER:0\s*.*\s*;HEIGHT:(%F)`],['layer_height',String.raw`;LAYER:1\s*.*\s*;HEIGHT:(%F)`],['object_height',String.raw`;Bounding Box:(?:\s+(%F))+`],['first_layer_extr_temp','M109 T0 S(%F)'],['first_layer_bed_temp','M190 S(%F)'],['chamber_temp','M191 S(%F)'],['nozzle_diameter',String.raw`;Dimension:(?:\s\d+\.\d+){3}\s(%F)`]],h);
  floats([['estimated_time',String.raw`;Print\sTime:\s(%F)`]],f);
  for(const field of ['name','type'])put('filament_'+field,findString(String.raw`;Filament\s${field[0].toUpperCase()+field.slice(1)}\s.\d:\s(%S)`,h)||findString(String.raw`;Filament\s${field}\s=\s(%S)`,h));
  const lengths=findFloats(String.raw`;Material.\d\sUsed:\s+(%F)`,f),diameters=findFloats(String.raw`;Filament\sDiameter\s.\d:\s+(%F)`,h),densities=findFloats(String.raw`;Filament\sDensity\s.\d:\s+(%F)`,h);
  if(lengths.length)put('filament_total',metadataSum(lengths));if(lengths.length===diameters.length&&lengths.length===densities.length)put('filament_weight_total',metadataSum(lengths.map((length,i)=>Math.PI/4*diameters[i]**2*length*densities[i]/1000000)));
 }else if(family==='IceSL'){
  for(const [key,source] of [['first_layer_height','z_layer_height_first_layer_mm'],['layer_height','z_layer_height_mm'],['object_height','print_height_mm'],['first_layer_extr_temp','extruder_temp_degree_c_0'],['first_layer_bed_temp','bed_temp_degree_c'],['chamber_temp','chamber_temp_degree_c'],['filament_total','filament_used_mm'],['filament_weight_total','filament_used_g'],['estimated_time','estimated_print_time_s'],['nozzle_diameter','nozzle_diameter_mm_0']])put(key,findFloat(String.raw`;\s${source}\s:\s+(%F)`,h));
  put('layer_count',findInteger(String.raw`;\slayer_count\s:\s+(%D)`,h));for(const field of ['name','type'])put('filament_'+field,findString(String.raw`;\sfilament_${field}\s:\s+(%S)`,h));
 }else if(family==='KiriMoto'){
  floats([['first_layer_height','; firstSliceHeight = (%F)'],['layer_height','; sliceHeight = (%F)'],['first_layer_extr_temp','; firstLayerNozzleTemp = (%F)'],['first_layer_bed_temp','; firstLayerBedTemp = (%F)']],h);
  floats([['filament_total','; --- filament used: (%F) mm']],f);put('estimated_time',findInteger('; --- print time: (%D)s',f));
  maximum('object_height',String.raw`G1 Z(%F) (?:; z-hop end|F\d+\n)`,f);
  const matches=Array.from(f.matchAll(metadataRegex(String.raw`;; --- layer (\d+) \(.+`,true)));if(matches.length){const count=metadataInteger(matches.at(-1)![1])!+1;if(!Number.isSafeInteger(count))throw new RangeError('Unsafe metadata layer count');put('layer_count',count);}
 }
 for(const value of Object.values(result))if(typeof value==='number'&&!Number.isFinite(value))throw new RangeError('Nonfinite metadata field');return result;
}
