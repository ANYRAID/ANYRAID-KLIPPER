import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {extrusionSections,readExtrusionConfiguration} from './extrusion.ts';
export interface FilamentRecipe {
 version:1;deviceId:string;extruder:'extruder';entrySensor:string;toolheadSensor:string;unloadMode:'reverse_only';
 chunkLength:number;timeoutMs:number;load:{temperature:number;seekDistance:number;purgeDistance:number;speed:number};unload:{temperature:number;seekDistance:number;retractDistance:number;speed:number};
}
export function validateFilamentRecipeBinding(reader:ConfigurationReader,value:FilamentRecipe,deviceId:string,maxNozzle:number){const recipe=parseFilamentRecipe(value);if(recipe.deviceId!==deviceId||extrusionSections(reader).length!==1||![recipe.entrySensor,recipe.toolheadSensor].every(name=>reader.hasSection(name)))throw Error('Filament recipe does not match actual device or switch topology');const extruder=reader.section('extruder'),motion=reader.section('printer'),limits=readExtrusionConfiguration(reader,motion.getFloat('max_velocity'),motion.getFloat('max_accel')).limits,min=extruder.getFloat('min_extrude_temp',{defaultValue:170,minval:0}),max=Math.min(maxNozzle,extruder.getFloat('max_temp'));if(recipe.chunkLength>limits.maxDistance||[recipe.load,recipe.unload].some(step=>step.temperature<min||step.temperature>max||step.speed>limits.maxVelocity))throw Error('Filament recipe exceeds configured extrusion or heater limits');return recipe;}
/** Trusted profile data, never RPC overrides. XY, cutter and wiping are absent. */
export function parseFilamentRecipe(value:unknown):FilamentRecipe {
 const fail=():never=>{throw new TypeError('Invalid trusted filament recipe');},object=(v:unknown,keys:readonly string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))fail();return v as Record<string,unknown>;};
 const row=object(value,['version','deviceId','extruder','entrySensor','toolheadSensor','unloadMode','chunkLength','timeoutMs','load','unload']);
 if(row.version!==1||row.extruder!=='extruder'||row.unloadMode!=='reverse_only'||typeof row.deviceId!=='string'||!/^[-A-Za-z0-9_]{1,128}$/u.test(row.deviceId)||!Number.isSafeInteger(row.timeoutMs)||Number(row.timeoutMs)<1||Number(row.timeoutMs)>3600000)fail();
 if(![row.entrySensor,row.toolheadSensor].every(v=>typeof v==='string'&&/^filament_switch_sensor [A-Za-z0-9_-]{1,64}$/u.test(v))||row.entrySensor===row.toolheadSensor)fail();
 const positive=(v:unknown,max:number)=>typeof v==='number'&&Number.isFinite(v)&&v>0&&v<=max;
 if(!positive(row.chunkLength,50))fail();for(const action of ['load','unload'] as const){const finish=action==='load'?'purgeDistance':'retractDistance',step=object(row[action],['temperature','seekDistance',finish,'speed']),seek=step.seekDistance,end=step[finish];if(!positive(step.temperature,500)||!positive(step.speed,100)||typeof seek!=='number'||!Number.isFinite(seek)||!positive(Math.abs(seek),2000)||(action==='load'?seek<=0:seek>=0)||typeof end!=='number'||!Number.isFinite(end)||Math.abs(end)>2000||(action==='load'?end<0:end>0)||Math.ceil(Math.abs(seek)/Number(row.chunkLength))+Math.ceil(Math.abs(end)/Number(row.chunkLength))>256)fail();}
 return structuredClone(row) as unknown as FilamentRecipe;
}
