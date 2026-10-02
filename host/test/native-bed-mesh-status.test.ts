import test from 'node:test';
import assert from 'node:assert/strict';
import {BedMesh} from '../src/motion/bed-mesh.ts';
import {nativeBedMeshStatus} from '../src/runtime/native-bed-mesh-status.ts';
import {NativeObjects} from '../src/moonraker/native-objects.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
const mesh=()=>new BedMesh({min_x:0,max_x:100,min_y:0,max_y:100,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct',tension:.2},[[.1,.2],[.3,.4]]);
test('bed mesh status projects fields lazily, retains exact numbers and detaches public queries',()=>{
 const source=mesh();let calls=0;const original=source.meshValues.bind(source);source.meshValues=()=>{calls++;return original();};let status=nativeBedMeshStatus(source,'saved');const objects=new NativeObjects(new Map([['bed_mesh',()=>status]]),()=>1);
 for(let i=0;i<100;i++)assert.deepEqual(objects.query({bed_mesh:['profile_name']}).status,{bed_mesh:{profile_name:'saved'}});assert.equal(calls,0);
 const first=objects.query({bed_mesh:null});assert.equal(calls,1);assert.deepEqual(first.status.bed_mesh.mesh_matrix,[[.1,.2],[.3,.4]]);(first.status.bed_mesh.mesh_matrix as number[][])[0][0]=999;
 assert.deepEqual(objects.query({bed_mesh:['mesh_matrix']}).status.bed_mesh.mesh_matrix,[[.1,.2],[.3,.4]]);assert.equal(calls,1);
 status=nativeBedMeshStatus(null,'old');assert.deepEqual(objects.query({bed_mesh:null}).status.bed_mesh,{profile_name:'',mesh_min:[0,0],mesh_max:[0,0],probed_matrix:[[]],mesh_matrix:[[]]});
});
test('large mesh remains queryable by name and rejects full matrix before copying or truncation',()=>{
 const source=new BedMesh({min_x:0,max_x:100,min_y:0,max_y:100,x_count:6,y_count:6,mesh_x_pps:64,mesh_y_pps:64,algo:'bicubic',tension:.2},Array.from({length:6},()=>Array(6).fill(.1)));let copied=false;source.meshValues=()=>{copied=true;throw Error('must not copy');};const status=nativeBedMeshStatus(source,'large'),objects=new NativeObjects(new Map([['bed_mesh',()=>status]]),()=>1);
 assert.equal(objects.query({bed_mesh:['profile_name']}).status.bed_mesh.profile_name,'large');assert.throws(()=>objects.query({bed_mesh:['mesh_matrix']}),e=>e instanceof ApiError&&e.status===413);assert.equal(copied,false);assert.deepEqual(objects.query({bed_mesh:['probed_matrix']}).status.bed_mesh.probed_matrix,Array.from({length:6},()=>Array(6).fill(.1)));
 const combined=new NativeObjects(new Map([['large',()=>({a:Array(60000).fill(0),b:Array(60000).fill(0)})]]),()=>1);assert.throws(()=>combined.query({large:null}),e=>e instanceof ApiError&&e.status===413);
});
