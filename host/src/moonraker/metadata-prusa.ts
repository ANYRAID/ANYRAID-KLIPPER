import type {MetadataWindow} from './metadata-window.ts';
import {parseCommonMetadata} from './metadata-common.ts';
import {findFloat,findFloats,findInteger,findString,findStrings,metadataInteger,metadataRegex,metadataSum,pythonJsonStrings,roundMetadataHeight} from './metadata-values.ts';
export type PrusaFamily='PrusaSlicer'|'Slic3rPE'|'Slic3r'|'BambuStudio';
export type PrusaFields=Record<string,number|string|number[]|string[]>;
/** All non-image parse_* fields of the pinned Prusa family. Thumbnail extraction is separate. */
export function parsePrusaMetadata(window:Pick<MetadataWindow,'header'|'footer'|'size'>,family:PrusaFamily):PrusaFields{
 const result:PrusaFields=parseCommonMetadata(window),config=family==='BambuStudio'?window.header:window.footer;
 const put=(field:string,value:PrusaFields[string]|undefined)=>{if(value!==undefined)result[field]=value;};
 const layer=findFloat('; layer_height = (%F)',config);put('layer_height',layer);
 if(family!=='BambuStudio'){
 const percent=findFloat('; first_layer_height = (%F)%',config);
 put('first_layer_height',percent!==undefined?(layer===undefined?undefined:roundMetadataHeight(percent/100*layer)):findFloat('; first_layer_height = (%F)',config));
 const heights=findFloats(String.raw`;BEFORE_LAYER_CHANGE\n(?:.*\n)?;(\d+\.?\d*)`,window.footer),fallback=heights.length?heights:findFloats(String.raw`G1\sZ(%F)\sF`,window.footer);
 if(fallback.length)put('object_height',fallback.reduce((a,b)=>Math.max(a,b)));
 }
 const filament=family==='PrusaSlicer'?findString(String.raw`filament\sused\s\[mm\]\s=\s(%S)\n`,config):undefined,weights=family!=='BambuStudio'?findString(String.raw`filament\sused\s\[g\]\s=\s(%S)\n`,config):undefined;
 if(filament){const values=findFloats('(%F)',filament);if(values.length)put('filament_total',metadataSum(values));}
 if(weights){const values=findFloats('(%F)',weights);if(values.length)put('filament_weights',values);}
 if(family!=='Slic3r'&&family!=='BambuStudio')put('filament_weight_total',findFloat(String.raw`total\sfilament\sused\s\[g\]\s=\s(%F)`,config));
 for(const [field,key] of [['filament_type','filament_type'],['filament_name','filament_settings_id']]){const values=findStrings(String.raw`;\s${key}\s=\s(%S)`,config);if(values.length)put(field,values.length===1?values[0]:pythonJsonStrings(values));}
 for(const [field,key] of [['filament_colors','filament_colour'],['extruder_colors','extruder_colour']])put(field,findStrings(String.raw`;\s${key}\s=\s(%S)`,config));
 for(const [field,key] of [['filament_temps','(?:nozzle_)?temperature'],['referenced_tools','referenced_tools']]){const values=findStrings(String.raw`;\s${key}\s=\s(%S)`,config).map(metadataInteger);if(values.every(v=>v!==undefined))put(field,values as number[]);}
 for(const [field,pattern] of [['mmu_print',String.raw`;\ssingle_extruder_multi_material\s=\s(%D)`]])put(field,findInteger(pattern,config));
 if(family!=='BambuStudio')put('layer_count',findInteger('; total layers count = (%D)',config));
 put('filament_change_count',findInteger('; total toolchanges = (%D)',config)??findInteger('; total filament change = (%D)',config));
 const time=metadataRegex(String.raw`;\sestimated\sprinting\stime.*`).exec(config);
 if(time&&family!=='Slic3r'){let total=0;for(const [unit,multiplier] of [['d',86400],['h',3600],['m',60],['s',1]] as const){const match=metadataRegex(String.raw`(\d+)${unit}`).exec(time[0]);if(match)total+=metadataInteger(match[1])!*multiplier;}if(!Number.isSafeInteger(total))throw new RangeError('Unsafe metadata duration');put('estimated_time',total);}
 if(family!=='BambuStudio')for(const [field,key] of [['first_layer_extr_temp','first_layer_temperature'],['first_layer_bed_temp','first_layer_bed_temperature'],['chamber_temp','chamber_temperature']])put(field,findFloat(`; ${key} = (%F)`,config));
 put('nozzle_diameter',findFloat(String.raw`;\snozzle_diameter\s=\s(%F)`,config));
 for(const field of ['printer_vendor','printer_model','printer_variant','profile_version'])put(field,findString(`; ${field} = (%S)`,window.footer));
 if(family==='Slic3rPE'||family==='Slic3r'){
  delete result.filament_total;
  if(family==='Slic3rPE')put('filament_total',findFloat(String.raw`filament\sused\s=\s(%F)mm`,window.footer));
  else {const meters=findFloat(String.raw`;\sfilament_length_m\s=\s(%F)`,window.footer);if(meters!==undefined)put('filament_total',meters*1000);delete result.filament_weight_total;put('filament_weight_total',findFloat(String.raw`;\sfilament\smass_g\s=\s(%F)`,window.footer));delete result.estimated_time;}
 }
 if(family==='BambuStudio'){
  delete result.filament_weights;
  for(const [field,pattern] of [['first_layer_height','; initial_layer_print_height = (%F)'],['object_height','; max_z_height: (%F)'],['filament_total',String.raw`; total filament length \[mm\] : (%F)`],['filament_weight_total',String.raw`; total filament weight \[g\] : (%F)`],['first_layer_extr_temp','; nozzle_temperature_initial_layer = (%F)'],['first_layer_bed_temp','; hot_plate_temp_initial_layer = (%F)'],['chamber_temp','; chamber_temperatures = (%F)']]){delete result[field];put(field,findFloat(pattern,config));}
  delete result.layer_count;put('layer_count',findInteger('; total layer number: (%D)',config));
 }
 for(const value of Object.values(result))if(typeof value==='number'&&!Number.isFinite(value))throw new RangeError('Nonfinite metadata field');
 return result;
}
