import test from 'node:test';
import assert from 'node:assert/strict';
import {registerNativeProbe} from '../src/moonraker/native-probe.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
const context:RpcContext={transport:'http',signal:new AbortController().signal,authorize:()=>{}};
test('clock ownership rejects before admission; held dispatch admits one explicit calibration',async()=>{
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),gate=new MaintenanceGate();let clockBusy=false,calls=0,resets=0;
 const dispatch=new GCodeDispatch({output(){},shutdown(){assert.fail('Unexpected dispatch shutdown');}}),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const close=registerNativeProbe(registry,gate,{idle:()=>!clockBusy,measure:async()=>{calls++;return {passes:1};},synchronize:()=>{resets++;}},'quad_gantry_level');
 const invoke=(verb:string,params:any={})=>registry.invoke('/printer/calibration/quad_gantry_level',verb,params,context) as Promise<any>;
 const before=await invoke('GET'),request={version:1,state_token:before.state_token};
 const maintenance=dispatch.runWhenIdle(async()=>{clockBusy=true;entered.resolve();try{await release.promise;}finally{clockBusy=false;}},context.signal);
 try{
  await entered.promise;
  await assert.rejects(invoke('POST',request),error=>error instanceof Error&&'status' in error&&error.status===409&&error.message==='Probe requires an idle homed printer');
  assert.deepEqual(await invoke('GET'),{...before,available:false});assert.equal(calls,0);assert.equal(resets,0);assert.equal(gate.status.maintenance,false);
  const calibration=dispatch.runExclusive(async signal=>{
   assert.equal(clockBusy,false);assert.equal(await dispatch.runWhenIdle(async()=>assert.fail('Maintenance overtook calibration'),signal),false);
   const result=await invoke('POST',request);assert.equal(result.result.passes,1);assert.notEqual(result.state_token,before.state_token);
  },context.signal);
  assert.equal(calls,0);release.resolve();assert.equal(await maintenance,true);await calibration;
  assert.equal(calls,1);assert.equal(resets,1);
 }finally{release.resolve();await maintenance;await close();}
});
test('typed probe is authorized, exclusive, cache-safe and retry-idempotent',async()=>{
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),gate=new MaintenanceGate();let idle=false,calls=0,resets=0;const pending=Promise.withResolvers<any>();
 const close=registerNativeProbe(registry,gate,{idle:()=>idle,measure:async()=>{calls++;return pending.promise;},synchronize:()=>{resets++;}});
 const invoke=(verb:string,params:any={})=>registry.invoke('/printer/calibration/probe',verb,params,context) as Promise<any>;
 try{
  const status=await invoke('GET'),request={version:1,state_token:status.state_token};
  await assert.rejects(invoke('POST',request),/idle/);idle=true;
  await assert.rejects(registry.invoke('/printer/calibration/probe','POST',request,{...context,authorize:()=>{throw Error('denied');}}),/denied/);assert.equal(calls,0);
  await assert.rejects(invoke('POST',{...request,script:'G1 Z-10'}),/Expected/);
  const release=gate.activity();await assert.rejects(invoke('POST',request),/activity/);release();
  const running=invoke('POST',request);await Promise.resolve();assert.equal(calls,1);assert.throws(()=>gate.activity());await assert.rejects(invoke('POST',request),/idle/);
  pending.resolve({bed_position:[10,20,.123456789]});const result=await running;assert.equal(resets,1);assert.equal(result.available,true);assert.notEqual(result.state_token,status.state_token);assert.equal(gate.status.maintenance,false);
  const repeated=await invoke('POST',request);assert.deepEqual(repeated,result);repeated.result.bed_position[2]=123;assert.notDeepEqual(await invoke('POST',request),repeated);assert.equal(calls,1);
 }finally{await close();}
});
test('close cancels measurement and fences future printer activities',async()=>{
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),gate=new MaintenanceGate();let started=false;
 const close=registerNativeProbe(registry,gate,{idle:()=>true,measure:s=>new Promise((_,reject)=>{started=true;s.addEventListener('abort',()=>reject(s.reason),{once:true});}),synchronize:()=>assert.fail('cancelled measurement must not publish')});
 const status=await registry.invoke('/printer/calibration/probe','GET',{},context) as any;
 const pending=registry.invoke('/printer/calibration/probe','POST',{version:1,state_token:status.state_token},context);const rejected=assert.rejects(pending,/Probe failed/);await Promise.resolve();assert(started);await close();await rejected;assert(gate.status.closed);assert.equal(gate.status.maintenance,false);
});
test('endpoint failure from a real native probe fences both owners',async()=>{
 const {nativeLinearFixture}=await import('./helpers/native-linear-port.ts');
 const t=await nativeLinearFixture(0,()=>false,false,undefined,false,false,false,{z_offset:'0'}),s=new AbortController().signal;
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),gate=new MaintenanceGate();
 const close=registerNativeProbe(registry,gate,{idle:()=>true,measure:async signal=>{const r=await t.port.measureProbe(0,signal);return {bed_position:[...r.bedPosition]};},synchronize:()=>t.coordinates.resetPosition()});
 try{
  t.kinematics.markHomed([0,1,2]);await t.port.forcePosition([50,0,1,0],s);t.f.fw.setEndstopState({homing:0,pin_value:1,next_clock:0},7);
  const status=await registry.invoke('/printer/calibration/probe','GET',{},context) as any;
  await assert.rejects(registry.invoke('/printer/calibration/probe','POST',{version:1,state_token:status.state_token},context),/Probe failed/);
  assert(t.port.status.failed);assert(gate.status.closed);assert.equal(t.kinematics.status.homedAxes,'');
 }finally{await close();await t.close();}
});
test('homing and probe share the same maintenance lock and reject client axes',async()=>{
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),gate=new MaintenanceGate(),pending=Promise.withResolvers<any>();let homed=false;
 const closeHome=registerNativeProbe(registry,gate,{idle:()=>true,measure:async()=>{await pending.promise;homed=true;return {homed_axes:'xyz'};},synchronize:()=>{}},'home');
 const closeProbe=registerNativeProbe(registry,gate,{idle:()=>true,measure:async()=>({}),synchronize:()=>{}});
 try{
  const hs=await registry.invoke('/printer/calibration/home','GET',{},context) as any,ps=await registry.invoke('/printer/calibration/probe','GET',{},context) as any;
  await assert.rejects(registry.invoke('/printer/calibration/home','POST',{version:1,state_token:hs.state_token,axes:'x'},context),/Expected/);
  const running=registry.invoke('/printer/calibration/home','POST',{version:1,state_token:hs.state_token},context);await Promise.resolve();
  assert.equal((await registry.invoke('/printer/calibration/probe','GET',{},context) as any).available,false);
  await assert.rejects(registry.invoke('/printer/calibration/probe','POST',{version:1,state_token:ps.state_token},context),/activity/);assert.throws(()=>gate.activity());
  pending.resolve({});await running;assert(homed);assert(!gate.status.maintenance);
 }finally{pending.resolve({});await closeHome();await closeProbe();}
});
