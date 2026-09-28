import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
import {registerNativeAdaptiveMesh} from '../src/moonraker/native-adaptive-mesh.ts';
import {planProbeGrid,buildProbeGridMesh,type ProbeGrid} from '../src/homing/probe-grid.ts';
const context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
const grid:ProbeGrid={mesh:{min_x:0,max_x:100,min_y:0,max_y:100,x_count:9,y_count:9,mesh_x_pps:2,mesh_y_pps:2,algo:'bicubic',tension:.2},horizontalHeight:5,travelSpeed:50};
async function fixture(mutate=false){
 const dir=await mkdtemp('/tmp/adaptive-owner-'),path=dir+'/file.gcode';await writeFile(path,'EXCLUDE_OBJECT_DEFINE NAME=part POLYGON=[[20,20],[30,20],[30,30],[20,30]]\n');
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),gate=new MaintenanceGate();let closed=0,measures=0,activated=false,bound=false,stops=0;
 const close=registerNativeAdaptiveMesh(registry,gate,grid,{idle:()=>true,async open(id){assert.equal(id,'authorized');return GCodeFileReader.adopt(await open(path,'r'),{onClosed:()=>{closed++;}});},async measure(g){assert(gate.status.maintenance);assert.equal(closed,0);measures++;if(mutate)await writeFile(path,'G1 X999\n');const plan=planProbeGrid(g,[0,0,0]);assert.equal(plan.points.length,9);return buildProbeGridMesh(plan,plan.points.map(p=>p.nozzleX*.001));},async activate(_mesh,identity){assert.equal(closed,0);activated=true;bound=identity!==undefined;},async fail(){stops++;}});
 const invoke=(verb:string,params:any={})=>registry.invoke('/printer/calibration/bed_mesh/adaptive',verb,params,context) as Promise<any>;
 return {invoke,gate,get closed(){return closed;},get measures(){return measures;},get activated(){return activated;},get bound(){return bound;},get stops(){return stops;},async close(){await close();await rm(dir,{recursive:true,force:true});}};
}
test('adaptive calibration holds selected file lease through activation and deduplicates',async()=>{const f=await fixture();try{const state=await f.invoke('GET'),request={version:1,state_token:state.state_token,file_id:'authorized'},receipt=await f.invoke('POST',request);assert.equal(receipt.adapted,true);assert.equal(receipt.contact_count,9);assert(f.bound&&f.activated);assert.equal(f.closed,1);assert.deepEqual(await f.invoke('POST',request),receipt);assert.equal(f.measures,1);assert.equal(f.gate.status.maintenance,false);await assert.rejects(f.invoke('POST',{...request,margin:2}),/conflicts/);}finally{await f.close();}});
test('file mutation during probing prevents activation and invalidates generation',async()=>{const f=await fixture(true);try{const state=await f.invoke('GET');await assert.rejects(f.invoke('POST',{version:1,state_token:state.state_token,file_id:'authorized'}),/reinitialize/);assert.equal(f.activated,false);assert.equal(f.closed,1);assert.equal(f.stops,1);assert(f.gate.status.closed);}finally{await f.close();}});
