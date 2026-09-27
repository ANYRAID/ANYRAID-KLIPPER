import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {planProbeGrid,type ProbeGrid} from '../homing/probe-grid.ts';
export function readProbeGrid(reader:ConfigurationReader):ProbeGrid|undefined{
 if(!reader.hasSection('bed_mesh'))return undefined;const s=reader.section('bed_mesh');
 if(Object.keys(s.options()).some(k=>k==='mesh_radius'||k==='zero_reference_position'||k==='relative_reference_index'||k.startsWith('faulty_region_')))throw new Error('Native grid calibration does not yet support this geometry or reference policy');
 if(!s.hasOption('mesh_min')&&!s.hasOption('mesh_max'))return undefined;
 const low=s.getFloatList('mesh_min',{separator:',',count:2}),high=s.getFloatList('mesh_max',{separator:',',count:2});
 const pair=(key:string,fallback:number,min:number,max:number)=>{const v=s.getIntList(key,{separator:',',defaultValue:[fallback,fallback]});if(v.length<1||v.length>2||v.some(n=>n<min||n>max))throw new Error('Invalid grid '+key);return [v[0],v[1]??v[0]];};
 const count=pair('probe_count',3,3,128),pps=pair('mesh_pps',2,0,64),algo=s.get('algorithm',{defaultValue:'lagrange'}).trim().toLowerCase();if(algo!=='lagrange'&&algo!=='bicubic')throw new Error('Invalid grid algorithm');
 const grid:ProbeGrid={mesh:{min_x:low[0],max_x:high[0],min_y:low[1],max_y:high[1],x_count:count[0],y_count:count[1],mesh_x_pps:pps[0],mesh_y_pps:pps[1],algo,tension:s.getFloat('bicubic_tension',{defaultValue:.2,minval:0,maxval:2})},horizontalHeight:s.getFloat('horizontal_move_z',{defaultValue:5}),travelSpeed:s.getFloat('speed',{defaultValue:50,above:0})};
 planProbeGrid(grid,[0,0,0]);return grid;
}
