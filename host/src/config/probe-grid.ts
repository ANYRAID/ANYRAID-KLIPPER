import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {planProbeGrid,type ProbeGrid} from '../homing/probe-grid.ts';
export function readProbeGrid(reader:ConfigurationReader):ProbeGrid|undefined{
 if(!reader.hasSection('bed_mesh'))return undefined;const s=reader.section('bed_mesh');
 if(Object.keys(s.options()).some(k=>k==='relative_reference_index'))throw new Error('Native grid calibration does not yet support this geometry or reference policy');
 const faultyRegions:NonNullable<ProbeGrid['faultyRegions']>[number][]=[];
 const keys=Object.keys(s.options()).filter(k=>k.startsWith('faulty_region_'));
 if(keys.some(k=>!/^faulty_region_([1-9][0-9]?)_(min|max)$/.test(k)))throw new Error('Invalid faulty region option');
 for(let i=1;i<=99;i++){
  const min='faulty_region_'+i+'_min',max='faulty_region_'+i+'_max';if(!s.hasOption(min)&&!s.hasOption(max))continue;
  if(i!==faultyRegions.length+1)throw new Error('Faulty region indices must be contiguous');
  faultyRegions.push({min:s.getFloatList(min,{separator:',',count:2}) as [number,number],max:s.getFloatList(max,{separator:',',count:2}) as [number,number]});
 }
 const radius=s.hasOption('mesh_radius')?Math.floor(s.getFloat('mesh_radius',{above:0})*10)/10:undefined;
 if(radius===undefined&&!s.hasOption('mesh_min')&&!s.hasOption('mesh_max')){if(faultyRegions.length)throw new Error('Faulty regions require probe grid geometry');return undefined;}
 const origin=radius===undefined?undefined:s.getFloatList('mesh_origin',{separator:',',count:2,defaultValue:[0,0]}) as [number,number];
 const low=radius===undefined?s.getFloatList('mesh_min',{separator:',',count:2}):[origin![0]-radius,origin![1]-radius],high=radius===undefined?s.getFloatList('mesh_max',{separator:',',count:2}):[origin![0]+radius,origin![1]+radius];
 const pair=(key:string,fallback:number,min:number,max:number)=>{const v=s.getIntList(key,{separator:',',defaultValue:[fallback,fallback]});if(v.length<1||v.length>2||v.some(n=>n<min||n>max))throw new Error('Invalid grid '+key);return [v[0],v[1]??v[0]];};
 const round=radius===undefined?undefined:s.getInt('round_probe_count',{defaultValue:5,minval:3,maxval:127}),count=round===undefined?pair('probe_count',3,3,128):[round,round],pps=pair('mesh_pps',2,0,64),algo=s.get('algorithm',{defaultValue:'lagrange'}).trim().toLowerCase();if(algo!=='lagrange'&&algo!=='bicubic')throw new Error('Invalid grid algorithm');
 const reference=s.getFloatList('zero_reference_position',{separator:',',count:2,defaultValue:null});
 const grid:ProbeGrid={faultyRegions,...(radius===undefined?{}:{circle:{radius,origin:origin!}}),...(reference?{zeroReference:reference as [number,number]}:{}),mesh:{min_x:low[0],max_x:high[0],min_y:low[1],max_y:high[1],x_count:count[0],y_count:count[1],mesh_x_pps:pps[0],mesh_y_pps:pps[1],algo,tension:s.getFloat('bicubic_tension',{defaultValue:.2,minval:0,maxval:2})},horizontalHeight:s.getFloat('horizontal_move_z',{defaultValue:5}),travelSpeed:s.getFloat('speed',{defaultValue:50,above:0})};
 const plan=planProbeGrid(grid,[0,0,0]);return {...grid,mesh:plan.mesh};
}
