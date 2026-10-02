import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GCodeMove} from '../src/gcode/move.ts';
import {applyZEndstopOffset} from '../src/homing/z-endstop.ts';
import {registerNativeZOffset} from '../src/moonraker/native-z-offset.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
const path='/printer/configuration/z_offset',context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
test('offset revision detects restore and changes away and back without changing rejected moves',()=>{
 const g=new GCodeMove({position:()=>[0,0,0,0],move(){throw Error('rejected');}});assert.deepEqual(g.zOffset,{value:0,revision:'0'});g.execute('SAVE_GCODE_STATE');g.execute('SET_GCODE_OFFSET',{Z:-.1});g.execute('SET_GCODE_OFFSET',{Z:0});assert.equal(g.zOffset.revision,'2');g.execute('SET_GCODE_OFFSET',{Z:.1});g.execute('RESTORE_GCODE_STATE');assert.equal(g.zOffset.revision,'4');assert.throws(()=>g.execute('SET_GCODE_OFFSET',{Z:.2,MOVE:1}),/rejected/);assert.deepEqual(g.zOffset,{value:0,revision:'4'});g.execute('SET_GCODE_OFFSET',{X:2});assert.equal(g.zOffset.revision,'4');
});
test('negative offsets need not lie in the physical travel interval',()=>{
 assert.equal(applyZEndstopOffset(0,-.125,0,10),.125);assert.throws(()=>applyZEndstopOffset(0,.125,0,10));assert.throws(()=>applyZEndstopOffset(0,NaN,0,10));
});
for(const conflict of [false,true,'close'] as const)test(`offset persistence fences live revisions and does not apply twice (conflict=${conflict})`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'offset-save-')),file=join(dir,'printer.cfg'),original='[stepper_z]\nposition_endstop: 0\n';await writeFile(file,original);const {session}=await KlipperSaveSession.load(file),gate=new MaintenanceGate(),registry=new EndpointRegistry(new JsonRpcDispatcher()),g=new GCodeMove({position:()=>[0,0,0,0],move(){assert.fail('save must not move');}});
 const close=registerNativeZOffset(registry,gate,{offset:()=>g.zOffset,idle:()=>true},0,0,10,session),get=()=>registry.invoke(path,'GET',{},context) as Promise<any>,post=(body:any)=>registry.invoke(path,'POST',body,context) as Promise<any>;
 try{
  assert.equal((await get()).available,false);await assert.rejects(post({version:1,state_token:(await get()).state_token}),/nonzero/);g.execute('SET_GCODE_OFFSET',{Z:-.1234567890123456});const stale={version:1,state_token:(await get()).state_token};g.execute('SET_GCODE_OFFSET',{Z:0});g.execute('SET_GCODE_OFFSET',{Z:-.1234567890123456});await assert.rejects(post(stale),/Stale/);
  const request={version:1,state_token:(await get()).state_token};await assert.rejects(post({...request,z_offset:2}),/Expected/);await assert.rejects(registry.invoke(path,'POST',request,{...context,authorize(){throw Error('denied');}}),/denied/);const release=gate.activity();await assert.rejects(post(request),/idle/);release();
  if(conflict==='close'){session.save=async signal=>new Promise((_,reject)=>{signal!.throwIfAborted();signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});});const saving=post(request),failed=assert.rejects(saving,/failed/);await new Promise(resolve=>setImmediate(resolve));await close();await failed;assert.equal(await readFile(file,'utf8'),original);}
  else if(conflict){await writeFile(file,original+'# external\n');await assert.rejects(post(request),/failed/);assert.equal(await readFile(file,'utf8'),original+'# external\n');}
  else{const result=await post(request);assert.equal(result.position_endstop,.1234567890123456);assert.equal(result.persisted,true);assert.deepEqual(await post(request),result);const after=await KlipperSaveSession.load(file);assert.equal(Number(after.source.original.stepper_z.position_endstop),.1234567890123456);assert.equal(g.zOffset.value,-.1234567890123456);assert(session.status.sealedForRestart);}
  assert(gate.status.closed);assert(!gate.status.maintenance);
 }finally{await close();await rm(dir,{recursive:true,force:true});}
});
