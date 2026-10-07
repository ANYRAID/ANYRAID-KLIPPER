import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {PrintLayerInfo} from '../src/gcode/print-layer-info.ts';
import {FilePrintDevice} from '../src/operations/file-print-device.ts';
import {PrintController} from '../src/operations/print.ts';
import {PrintLayerPause} from '../src/operations/print-layer-pause.ts';
import {registerNativeLayerPause} from '../src/moonraker/native-layer-pause.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {ApiError,JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(predicate:()=>boolean){const deadline=Date.now()+2000;while(!predicate()){assert(Date.now()<deadline,'owned transition exceeded bounded test deadline');await flush();}}
async function fixture(script='SET_PRINT_STATS_INFO TOTAL_LAYER=4 CURRENT_LAYER=0\nG1 X0\nSET_PRINT_STATS_INFO CURRENT_LAYER=1\nG1 X1\nSET_PRINT_STATS_INFO CURRENT_LAYER=2\nG1 X2\nSET_PRINT_STATS_INFO CURRENT_LAYER=3\nG1 X3\n',failPause=false,batchLines=128,pauseHold?:Promise<void>){
 const directory=await mkdtemp(join(tmpdir(),'layer-pause-')),path=join(directory,'file.gcode');await writeFile(path,script);
 const first=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),paused=Promise.withResolvers<void>(),moves:number[]=[];let pauses=0,stops=0,finishes=0;
 const layers=new PrintLayerInfo(),dispatch=new GCodeDispatch({output(){},shutdown(){}});layers.register(dispatch);
 dispatch.register('G1',async command=>{const x=Number(command.params.X);moves.push(x);if(x===0){first.resolve();await release.promise;}});
 const file=new FilePrintDevice({async prepare(request){layers.reset(request.requestId);dispatch.setReady(true);},async start(){},async pause(){pauses++;paused.resolve();await pauseHold;if(failPause)throw new Error('owned pause failure');},async resume(){},async finish(){finishes++;},async stop(){stops++;}},dispatch,async()=>GCodeFileReader.adopt(await open(path,'r'),{batchLines}));
 const controller=new PrintController(file,{maxNozzle:300,maxBed:120}),owner=new PrintLayerPause(controller,file,layers);
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
 const closeApi=registerNativeLayerPause(registry,owner),invoke=(verb:string,params:any={},ctx=context)=>registry.invoke('/printer/print/layer_pause',verb,params,ctx) as Promise<any>;
 const request=()=>({version:1,request_id:'job',print_state_token:controller.stateToken,state_token:owner.status.state_token});
 return {controller,owner,file,layers,dispatch,first,release,paused,moves,invoke,context,request,closeApi,get pauses(){return pauses;},get stops(){return stops;},get finishes(){return finishes;},async start(){await controller.start({version:1,requestId:'job',fileId:'file',nozzle:0,bed:0});await first.promise;},async close(){release.resolve();closeApi();try{await controller.retire();}finally{await rm(directory,{recursive:true,force:true});}}};
}
test('next layer holds the same batch before its first move and explicit resume executes every suffix once',{timeout:5000},async()=>{
 const f=await fixture();try{
  await f.start();const receipt=await f.invoke('POST',{...f.request(),layer:'next',expires_at:Date.now()+60000});assert.equal(receipt.target_layer,1);assert.equal(receipt.persisted,false);
  f.release.resolve();await f.paused.promise;await until(()=>f.controller.state==='paused');assert.deepEqual(f.moves,[0]);assert.equal(f.pauses,1);assert.equal(f.file.status.file?.position,0);assert.equal(f.owner.status.outcome,'paused');assert.equal(f.finishes,0);
  await f.controller.resume();await until(()=>f.controller.state==='completed');assert.deepEqual(f.moves,[0,1,2,3]);assert.equal(f.pauses,1);assert.equal(f.finishes,1);assert.equal(f.owner.status.armed,false);
 }finally{await f.close();}
});
test('specified target ignores other commands and only file metadata may fire it',{timeout:5000},async()=>{
 const f=await fixture('SET_PRINT_STATS_INFO TOTAL_LAYER=4 CURRENT_LAYER=0\nG1 X0\nSET_PRINT_STATS_INFO TOTAL_LAYER=4\nSET_PRINT_STATS_INFO CURRENT_LAYER=1\nG1 X1\nSET_PRINT_STATS_INFO CURRENT_LAYER=2\nG1 X2\nSET_PRINT_STATS_INFO CURRENT_LAYER=3\nG1 X3\n',false,1);try{
  await f.start();await f.invoke('POST',{...f.request(),layer:2,expires_at:Date.now()+60000});
  // A real console command queues behind the held file prefix. Its current
  // layer must not fire the intention, including at the next total-only file
  // metadata line. Only file-reported CURRENT_LAYER may trigger the pause.
  const console=f.dispatch.execute('SET_PRINT_STATS_INFO CURRENT_LAYER=2');
  f.release.resolve();await console;await until(()=>f.controller.state==='paused');assert.deepEqual(f.moves,[0,1]);assert.equal(f.pauses,1);
  await f.controller.resume();await until(()=>f.controller.state==='completed');assert.deepEqual(f.moves,[0,1,2,3]);assert.equal(f.pauses,1);
 }finally{await f.close();}
});
test('a target at the file tail pauses before EOF completion and remains explicit',{timeout:5000},async()=>{
 const f=await fixture('SET_PRINT_STATS_INFO TOTAL_LAYER=1 CURRENT_LAYER=0\nG1 X0\nSET_PRINT_STATS_INFO CURRENT_LAYER=1\n',false,1);try{
  await f.start();await f.invoke('POST',{...f.request(),layer:1,expires_at:Date.now()+60000});f.release.resolve();await until(()=>f.controller.state==='paused');assert.equal(f.finishes,0);assert.equal(f.file.status.file?.phase,'paused');await f.controller.resume();await until(()=>f.controller.state==='completed');assert.equal(f.finishes,1);
 }finally{await f.close();}
});
test('pause failure safely joins the file pump without a controller/file self-wait',{timeout:5000},async()=>{
 const f=await fixture(undefined,true);try{
  await f.start();await f.invoke('POST',{...f.request(),layer:'next',expires_at:Date.now()+60000});f.release.resolve();await until(()=>f.controller.state==='failed'&&!f.controller.safeStopPending&&!f.controller.pendingDeviceActions);assert.deepEqual(f.moves,[0]);assert(f.stops>0);assert.equal(f.finishes,0);assert.equal(f.file.status.file?.closed,true);await until(()=>f.owner.status.outcome==='failed');
 }finally{await f.close();}
});
test('cancel fences an armed intention and cleanup admits no future layer move',{timeout:5000},async()=>{
 const f=await fixture();try{
  await f.start();await f.invoke('POST',{...f.request(),layer:'next',expires_at:Date.now()+60000});const cancelled=f.controller.cancel();f.release.resolve();await cancelled;assert.equal(f.controller.state,'cancelled');assert.deepEqual(f.moves,[0]);assert.equal(f.pauses,0);assert.equal(f.owner.status.armed,false);assert.equal(f.owner.status.outcome,'invalidated');
 }finally{await f.close();}
});
test('registry authorizes before mutation; compare-and-set rejects stale, malformed and retired requests',{timeout:5000},async()=>{
 const f=await fixture();try{
  await f.start();const request={...f.request(),layer:'next',expires_at:Date.now()+60000};
  await assert.rejects(f.invoke('POST',request,{...f.context,authorize(){throw new Error('denied');}}),/denied/);assert.equal(f.owner.status.armed,false);
  for(const layer of [0,5,1.1,'2',null])await assert.rejects(f.invoke('POST',{...request,layer}),e=>e instanceof ApiError&&e.status===400);
  await assert.rejects(f.invoke('POST',{...request,expires_at:Date.now()-1}),e=>e instanceof ApiError&&e.status===400);
  await assert.rejects(f.invoke('POST',{...request,print_state_token:'stale'}),e=>e instanceof ApiError&&e.status===409);
  const receipt=await f.invoke('POST',request);await assert.rejects(f.invoke('POST',request),e=>e instanceof ApiError&&e.status===409);assert.equal(f.owner.status.target_layer,1);
  await f.invoke('DELETE',{...f.request(),state_token:receipt.state_token});assert.equal(f.owner.status.armed,false);f.release.resolve();await until(()=>f.controller.state==='completed');assert.equal(f.pauses,0);
  let authorize!:()=>void;const authorization=new Promise<void>(resolve=>{authorize=resolve;});const pending=f.invoke('POST',request,{...f.context,authorize:()=>authorization});f.owner.close();authorize();await assert.rejects(pending,e=>e instanceof ApiError&&e.status===409);
 }finally{await f.close();}
});
test('expiring an intention never stops, resumes or recreates the print',{timeout:5000},async()=>{
 const f=await fixture();try{
  await f.start();await f.invoke('POST',{...f.request(),layer:'next',expires_at:Date.now()+1000});await until(()=>f.owner.status.outcome==='expired');assert.equal(f.controller.state,'printing');assert.equal(f.pauses,0);f.release.resolve();await until(()=>f.controller.state==='completed');assert.deepEqual(f.moves,[0,1,2,3]);assert.equal(f.pauses,0);
 }finally{await f.close();}
});
test('jumped file metadata pauses at the first reported layer beyond the target',{timeout:5000},async()=>{
 const f=await fixture('SET_PRINT_STATS_INFO TOTAL_LAYER=4 CURRENT_LAYER=0\nG1 X0\nSET_PRINT_STATS_INFO CURRENT_LAYER=3\nG1 X3\n');try{
  await f.start();await f.invoke('POST',{...f.request(),layer:2,expires_at:Date.now()+60000});f.release.resolve();await until(()=>f.controller.state==='paused');assert.deepEqual(f.moves,[0]);await f.controller.resume();await until(()=>f.controller.state==='completed');assert.deepEqual(f.moves,[0,3]);assert.equal(f.pauses,1);
 }finally{await f.close();}
});
test('manual pause and resume invalidate the waiting intention even for the same request',{timeout:5000},async()=>{
 const f=await fixture();try{
  await f.start();await f.invoke('POST',{...f.request(),layer:2,expires_at:Date.now()+60000});const pausing=f.controller.pause();f.release.resolve();await pausing;assert.deepEqual(f.moves,[0]);assert.equal(f.owner.status.outcome,'invalidated');await f.controller.resume();await until(()=>f.controller.state==='completed');assert.equal(f.pauses,1);assert.deepEqual(f.moves,[0,1,2,3]);
 }finally{await f.close();}
});
test('cancel waits a late pause acknowledgement and never publishes a resumable job',{timeout:5000},async()=>{
 const hold=Promise.withResolvers<void>(),f=await fixture(undefined,false,128,hold.promise);try{
  await f.start();await f.invoke('POST',{...f.request(),layer:'next',expires_at:Date.now()+60000});f.release.resolve();await f.paused.promise;let settled=false;const cancelled=f.controller.cancel().then(()=>{settled=true;});await flush();assert.equal(settled,false);assert.deepEqual(f.moves,[0]);hold.resolve();await cancelled;await until(()=>!f.owner.status.pause_pending);assert.equal(f.controller.state,'cancelled');assert.equal(f.owner.status.outcome,'invalidated');assert(f.stops>=2);assert.equal(f.finishes,0);await assert.rejects(f.controller.resume());assert.deepEqual(f.moves,[0]);
 }finally{hold.resolve();await f.close();}
});
test('missing slicer metadata is unavailable and generation retirement rejects authorization arriving late',{timeout:5000},async()=>{
 const f=await fixture('G1 X0\nG1 X1\n');try{
  await f.start();assert.equal(f.owner.status.available,false);await assert.rejects(f.invoke('POST',{...f.request(),layer:'next',expires_at:Date.now()+60000}),e=>e instanceof ApiError&&e.status===409);
  let authorize!:()=>void;const authorization=new Promise<void>(resolve=>{authorize=resolve;});const pending=f.invoke('POST',{...f.request(),layer:1,expires_at:Date.now()+60000},{...f.context,authorize:()=>authorization});f.closeApi();authorize();await assert.rejects(pending,e=>e instanceof ApiError&&e.status===503);f.release.resolve();await until(()=>f.controller.state==='completed');assert.equal(f.pauses,0);
 }finally{await f.close();}
});
