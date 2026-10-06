import test from 'node:test';
import assert from 'node:assert/strict';
import {inspect} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {productMachineFixture} from './helpers/product-machine.ts';
import {simulateDeltaWire} from './helpers/delta-wire-simulation.ts';
import {deltaClockDiagnostic} from './helpers/delta-clock-diagnostic.ts';
import {captureStepClockDiagnostics} from './helpers/step-clock-diagnostic.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {readDeltaMotionConfiguration} from '../src/config/delta-motion.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {startConfiguredDeltaProductService} from '../src/runtime/product-service.ts';
for(const reachable of [false,true])test('manual Delta mesh from homed apex preflights all points; reachable='+reachable,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'manual-delta-preflight-')),f=await productMachineFixture(dir,true),simulation=simulateDeltaWire(f.transport,{clockDiagnostic:true}),signal=new AbortController().signal;
 const journal=await PrintJournal.open({path:f.config.journalPath,deviceId:'printer'}),gate=new MaintenanceGate();let service:Awaited<ReturnType<typeof startConfiguredDeltaProductService>>|undefined;
 const releaseDiagnostic=captureStepClockDiagnostics(value=>t.diagnostic(JSON.stringify(value)));let phase='startup';
 try{
  const raw=structuredClone(f.transport.reader.source.original),radius=readDeltaMotionConfiguration(f.transport.reader).kinematics.status.axisMaximum[0];
  raw.bed_mesh={mesh_min:'0,0',mesh_max:reachable?'1,1':`${radius*.9},${radius*.9}`,probe_count:'3',mesh_pps:'0',horizontal_move_z:'10'};
  for(const axis of ['a','b','c'])Object.assign(raw['stepper_'+axis],{homing_retract_dist:'.2',homing_speed:'40',second_homing_speed:'10'});
  const reader=new ConfigurationReader(new ConfigurationSource('/manual-grid.cfg',raw,[]),null);
  service=await startConfiguredDeltaProductService(reader,f.transport.policies,{journal,maintenanceGate:gate,limits:f.config.limits},{configPath:f.config.moonrakerConfig,machine:f.config.machine,hardware:f.config.hardware,print:{...f.config.print,...f.bindings.print},server:f.bindings.server},signal);
  simulation.captureClocks((member,trigger)=>deltaClockDiagnostic(service!.printer,member,trigger));
  phase='homing';await service.printer.print.gcode.homing.home([0,1,2],signal);const port=service.printer.delta.port;assert(port.homingPosition()[2]>10);phase='preflight';
  const before=f.transport.firmware.map(fw=>fw.motion.length),position=port.homingPosition(),base='http://127.0.0.1:'+service.address.port+'/printer/calibration/bed_mesh/manual';
  const state=(await (await fetch(base)).json() as any).result;assert(state.available);
  if(reachable){
   let token=state.state_token;
   const action=async(action:string,delta?:number)=>{const response=await fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:1,state_token:token,action,...delta===undefined?{}:{delta}})});if(response.status!==200)t.diagnostic(inspect({action,delta,motionFault:port.status.fault,hardwareFault:service!.printer.hardware.status.fault,wire:simulation.clockDiagnostic(),clocks:deltaClockDiagnostic(service!.printer,0)},{depth:12,maxArrayLength:32}));assert.equal(response.status,200,await response.clone().text());const result=(await response.json() as any).result;token=result.state_token;return result;};
   const start=performance.now();let result=await action('start');assert.equal(result.state,'awaiting');assert.equal(port.homingPosition()[2],10);
   for(let i=0;i<9;i++){await action('adjust',-.2);result=await action('accept');}
   assert.equal(result.state,'completed');assert.equal(gate.status.maintenance,false);assert.equal(port.status.failed,false);assert.equal(simulation.probeHits,0);
   t.diagnostic(JSON.stringify({manualMeshFromHomeMs:performance.now()-start,contacts:9,scope:'Simulated MCU execution from homed apex; no physical precision claim'}));return;
  }
  const response=await fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:1,state_token:state.state_token,action:'start'})});assert.equal(response.status,400,await response.clone().text());
  assert.deepEqual(f.transport.firmware.map(fw=>fw.motion.length),before);assert.deepEqual(port.homingPosition(),position);assert.equal(port.status.failed,false);assert.equal(gate.status.closed,false);assert.equal(gate.status.maintenance,false);assert.equal((await (await fetch(base)).json() as any).result.state_token,state.state_token);
  const samples:number[]=[];for(let run=0;run<6;run++){const start=performance.now();for(let i=0;i<1000;i++)port.preflightManualCalibration([[0,0],[1,1],[-1,-1]],10,50);if(run)samples.push(performance.now()-start);}
  assert.deepEqual(f.transport.firmware.map(fw=>fw.motion.length),before);const median=[...samples].sort((a,b)=>a-b)[2];assert(median<1000);t.diagnostic(JSON.stringify({preflight1000Ms:samples,medianMs:median,scope:'Idle physical path admission; no MCU motion or physical accuracy claim'}));
  phase='travel-after-rejected-preflight';await port.homingTravel([1,0,10,0],50,signal);assert.equal(port.homingPosition()[0],1);
 }catch(error){t.diagnostic(inspect({manualDeltaFailure:{phase,reachable,error:String(error),wire:simulation.clockDiagnostic(),clocks:service?deltaClockDiagnostic(service.printer,0):undefined}},{depth:12,maxArrayLength:32}));throw error;
 }finally{releaseDiagnostic();await service?.close();simulation.close();await journal.close();await f.close();await rm(dir,{recursive:true,force:true});}
});
