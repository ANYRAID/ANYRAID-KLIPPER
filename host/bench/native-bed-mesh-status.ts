import assert from 'node:assert/strict';
import {BedMesh} from '../src/motion/bed-mesh.ts';
import {nativeBedMeshStatus} from '../src/runtime/native-bed-mesh-status.ts';
import {NativeObjects} from '../src/moonraker/native-objects.ts';
const create=(pps:number)=>new BedMesh({min_x:0,max_x:100,min_y:0,max_y:100,x_count:6,y_count:6,mesh_x_pps:pps,mesh_y_pps:pps,algo:'bicubic',tension:.2},Array.from({length:6},(_,y)=>Array.from({length:6},(_,x)=>(x+y)/10)));
const small=create(0),large=create(64),full=create(12),samples:{name:string;cells:number;medianMs:number;p95Ms:number}[]=[];
for(const [name,mesh,fields] of [['smallName',small,['profile_name']],['largeName',large,['profile_name']],['fullMatrix',full,null]] as const){
 const objects=new NativeObjects(new Map([['bed_mesh',()=>status]]),()=>1),status=nativeBedMeshStatus(mesh,'saved'),times:number[]=[];
 for(let round=0;round<120;round++){const start=performance.now();const count=fields?100:1;for(let i=0;i<count;i++){const result=objects.query({bed_mesh:fields});assert.equal(result.status.bed_mesh.profile_name,'saved');if(!fields)assert.equal((result.status.bed_mesh.mesh_matrix as number[][]).length,mesh.height);}if(round>=20)times.push((performance.now()-start)/count);}
 times.sort((a,b)=>a-b);samples.push({name,cells:mesh.width*mesh.height,medianMs:times[50],p95Ms:times[95]});
}
assert(samples[1].p95Ms<.1);assert(samples[2].p95Ms<20);console.log(JSON.stringify({node:process.version,samples,maximumNameP95Ms:.1,maximumFullP95Ms:20,scope:'Local synchronous NativeObjects projection, validation and detached response copies. Mesh construction excluded. Full query includes 4356 interpolated cells; no network or target-board guarantee.'}));
