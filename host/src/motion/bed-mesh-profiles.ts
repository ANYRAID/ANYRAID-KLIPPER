// GPL-3.0-or-later. Saved mesh loading from extras/bed_mesh.py ProfileManager.
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {BedMesh,type BedMeshParameters} from './bed-mesh.ts';
/** Validated session snapshot. Does not alter config files or select an active mesh. */
export class BedMeshProfiles {
 #meshes=new Map<string,BedMesh>();#incompatible:{name:string;version:number}[]=[];
 constructor(reader:ConfigurationReader){
  const sections=reader.prefixSections('bed_mesh ');if(sections.length>128)throw new RangeError('Bed mesh profile count exceeds limit');
  let cells=0;
  for(const name of sections){const profile=name.slice(9);if(!profile.trim()||profile.length>128||/[\x00-\x1f\x7f]/.test(profile))throw new RangeError('Invalid bed mesh profile name');
   const section=reader.section(name),version=section.getInt('version',{defaultValue:0});
   if(version!==1){this.#incompatible.push({name:profile,version});continue;}
   const p:BedMeshParameters={min_x:section.getFloat('min_x'),max_x:section.getFloat('max_x'),min_y:section.getFloat('min_y'),max_y:section.getFloat('max_y'),x_count:section.getInt('x_count',{minval:2,maxval:128}),y_count:section.getInt('y_count',{minval:2,maxval:128}),mesh_x_pps:section.getInt('mesh_x_pps',{minval:0,maxval:64}),mesh_y_pps:section.getInt('mesh_y_pps',{minval:0,maxval:64}),algo:section.get('algo') as BedMeshParameters['algo'],tension:section.getFloat('tension',{minval:0,maxval:2})};
   cells+=((p.x_count-1)*(p.mesh_x_pps+1)+1)*((p.y_count-1)*(p.mesh_y_pps+1)+1);if(cells>2000000)throw new RangeError('Stored bed mesh grid budget exceeded');
   const points=section.getLists('points',{type:'float',separators:['\n',','],count:[p.y_count,p.x_count]}) as number[][];
   this.#meshes.set(profile,new BedMesh(p,points));
  }
 }
 get names():readonly string[]{return [...this.#meshes.keys()];}
 get incompatible():readonly Readonly<{name:string;version:number}>[]{return this.#incompatible.map(p=>({...p}));}
 load(name:string):BedMesh{const mesh=this.#meshes.get(name);if(!mesh)throw new Error(`Unknown bed mesh profile: ${name}`);return mesh.copy();}
}
