import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import type {CombinationMethod} from '../thermal/combined-temperature.ts';
export function planCombinedTemperatures(reader:ConfigurationReader,sections:readonly string[],available:readonly string[]){
 if(new Set(sections.map(s=>s.trim().split(/\s+/).at(-1))).size!==sections.length)throw new Error('Duplicate combined temperature object name');
 const known=new Set(available),plans=sections.map(section=>{
  const c=reader.section(section),sources=c.getList('sensor_list',{separator:','}),method=c.getChoice('combination_method',['min','max','mean']) as CombinationMethod;
  if(!(/^(?:temperature_sensor|temperature_fan|heater_generic) /.test(section)||/^(?:extruder(?:[1-9][0-9]*)?|heater_bed)$/.test(section))||!sources.length||sources.length>128||sources.some(s=>!known.has(s)))throw new Error('Combined temperature source is unknown or unsupported');
  const minimum=c.getFloat('min_temp',{defaultValue:-273.15,minval:-273.15}),maximum=c.getFloat('max_temp',{defaultValue:99999999.9,above:minimum}),maximumDeviation=c.getFloat('maximum_deviation',{above:0}),gcodeId=c.get('gcode_id',{defaultValue:null});
  if(gcodeId!==null&&!/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(gcodeId))throw new Error('Invalid combined temperature G-code id');
  return Object.freeze({section,sources:Object.freeze(sources),method,minimum,maximum,maximumDeviation,gcodeId:gcodeId??undefined});
 });
 const sorted:typeof plans=[],visiting=new Set<string>(),done=new Set<string>(),byName=new Map(plans.map(p=>[p.section,p]));
 const visit=(p:typeof plans[number])=>{if(done.has(p.section))return;if(visiting.has(p.section))throw new Error('Combined temperature dependency cycle');visiting.add(p.section);for(const source of p.sources){const parent=byName.get(source);if(parent)visit(parent);}visiting.delete(p.section);done.add(p.section);sorted.push(p);};
 for(const p of plans)visit(p);return Object.freeze(sorted);
}
