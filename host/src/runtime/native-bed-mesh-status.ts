import type {BedMesh} from '../motion/bed-mesh.ts';
import {ApiError,type Json} from '../moonraker/rpc.ts';
/** Cache only requested matrices. Field projection must not materialize a large
 * mesh when clients merely poll profile_name. No rounding or decimation. */
export function nativeBedMeshStatus(mesh:BedMesh|null,name:string):Readonly<Record<string,Json>>{
 const p=mesh?.params;let probed:Json|undefined,matrix:Json|undefined;
 const rows=(width:number,height:number,values:()=>Float64Array):Json=>{
  if(width*height+height>90000)throw new ApiError(413,'Bed mesh matrix exceeds object response capacity');
  const data=values();return Object.freeze(Array.from({length:height},(_,y)=>Object.freeze(Array.from(data.subarray(y*width,(y+1)*width))))) as unknown as Json;
 };
 return Object.freeze({profile_name:mesh?name:'',mesh_min:Object.freeze(p?[p.min_x,p.min_y]:[0,0]) as unknown as Json,mesh_max:Object.freeze(p?[p.max_x,p.max_y]:[0,0]) as unknown as Json,
  get probed_matrix():Json{return probed??=mesh?rows(p!.x_count,p!.y_count,()=>mesh.probedValues()):Object.freeze([Object.freeze([])]) as unknown as Json;},
  get mesh_matrix():Json{return matrix??=mesh?rows(mesh.width,mesh.height,()=>mesh.meshValues()):Object.freeze([Object.freeze([])]) as unknown as Json;},
 });
}
