import {BedMesh} from './bed-mesh.ts';
import {fixed6} from '../math/python-decimal.ts';
import type {SaveChange} from '../config/klipper-save-changes.ts';
/** ProfileManager.save_profile persistence values. Probe heights intentionally
 * round to six decimals as upstream; interpolation parameters retain binary64.
 * Does not switch the active mesh, write files or request a restart. */
export function bedMeshProfileChanges(name:string,mesh:BedMesh):readonly SaveChange[]{
 if(typeof name!=='string'||!name.trim()||name.length>128||/[\x00-\x1f\x7f]/.test(name))throw new RangeError('Invalid bed mesh profile name');
 const section='bed_mesh '+name,p=mesh.params,probed=mesh.probedValues(),rows:string[]=[];
 for(let y=0;y<p.y_count;y++)rows.push('  '+Array.from(probed.subarray(y*p.x_count,(y+1)*p.x_count),fixed6).join(', '));
 const values:Record<string,string>={version:'1',points:'\n'+rows.join('\n')};
 for(const [key,value] of Object.entries(p))values[key]=typeof value==='number'&&Object.is(value,-0)?'-0':String(value);
 return Object.freeze(Object.entries(values).map(([option,value])=>Object.freeze({kind:'set' as const,section,option,value})));
}
