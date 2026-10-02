import test from 'node:test';
import assert from 'node:assert/strict';
import {inspect} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {productMachineFixture} from './helpers/product-machine.ts';
import {simulateDeltaWire} from './helpers/delta-wire-simulation.ts';
import {deltaClockDiagnostic} from './helpers/delta-clock-diagnostic.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {startConfiguredDeltaProductService} from '../src/runtime/product-service.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
for(const {stow,stuck} of [{stow:true,stuck:false},{stow:false,stuck:false},{stow:true,stuck:true}])test('Delta BLTouch owns deployment, multi-MCU sampling and stow; each='+stow+', stuck='+stuck,async t=>{
 const dir=await mkdtemp('/tmp/delta-bltouch-'),f=await productMachineFixture(dir,true),simulation=simulateDeltaWire(f.transport,{bltouch:true,stuckProbe:stuck,clockDiagnostic:true}),signal=new AbortController().signal;
 const journal=await PrintJournal.open({path:f.config.journalPath,deviceId:'printer'});let service:Awaited<ReturnType<typeof startConfiguredDeltaProductService>>|undefined;
 try{
  const raw=structuredClone(f.transport.reader.source.original);raw.bltouch={sensor_pin:'^aux:PA13',control_pin:'PA14',z_offset:'.123456789',samples:'2',sample_retract_dist:'.2',samples_tolerance:'10',pin_move_time:'.3',stow_on_each_sample:String(stow)};
  for(const axis of ['a','b','c'])Object.assign(raw['stepper_'+axis],{homing_retract_dist:'.2',homing_speed:'40',second_homing_speed:'10'});
  const reader=new ConfigurationReader(new ConfigurationSource('/delta-bltouch.cfg',raw,[]),null);
  service=await startConfiguredDeltaProductService(reader,f.transport.policies,{journal,maintenanceGate:new MaintenanceGate(),limits:f.config.limits},{configPath:f.config.moonrakerConfig,machine:f.config.machine,hardware:f.config.hardware,print:{...f.config.print,...f.bindings.print},server:f.bindings.server},signal);
  simulation.captureClocks((member,trigger)=>deltaClockDiagnostic(service!.printer,member,trigger));
  const owner=service.printer.delta;const device=service.printer.hardware.bltouch!.device;assert.equal(device.status.phase,'idle');assert.equal(device.status.deployed,false);
  const clocks=['mcu','aux'].map(id=>({id,sync:service!.printer.group.session(id).clock.sync}));
  const clockDiagnostic=()=>{const now=serialClock.now();return {wire:simulation.clockDiagnostic(),estimates:clocks.map(({id,sync},i)=>({id,actual:f.transport.firmware[i].currentClock(),predicted:String(sync.getClock(now)),revision:sync.revision,estimate:sync.estimate}))};};
  await service.printer.print.gcode.homing.home([0,1,2],signal);assert.equal(owner.kinematics.status.homedAxes,'xyz');
  await owner.port.homingTravel([10,0,10,0],100,signal);
  const base='http://127.0.0.1:'+service.address.port+'/printer/calibration/probe',state=(await (await fetch(base)).json() as any).result;assert(state.available);
  const start=performance.now(),body=JSON.stringify({version:1,state_token:state.state_token}),response=await fetch(base,{method:'POST',headers:{'content-type':'application/json'},body});if(stuck){assert.equal(response.status,503);assert.equal(owner.kinematics.status.homedAxes,'');assert.equal(device.status.phase,'failed');assert.equal(simulation.probeHits,1);assert.match(String(service.printer.hardware.status.fault),/without motor movement/);return;}
  if(response.status!==200)t.diagnostic(inspect({motionFault:owner.port.status.fault,hardwareFault:service.printer.hardware.status.fault,probeHits:simulation.probeHits,device:device.status,clocks:clockDiagnostic()},{depth:8,maxArrayLength:100}));
  assert.equal(response.status,200,await response.clone().text());const receipt=(await response.json() as any).result;
  assert.equal(receipt.result.attempts,2);assert.equal(simulation.probeHits,2);assert.equal(device.status.phase,'idle');assert.equal(device.status.deployed,false);assert.equal(owner.kinematics.status.homedAxes,'xyz');assert.equal(owner.port.homingPosition()[3],0);
  const replay=await fetch(base,{method:'POST',headers:{'content-type':'application/json'},body});assert.deepEqual((await replay.json() as any).result,receipt);assert.equal(simulation.probeHits,2);
  const target=[...owner.port.homingPosition()];target[2]+=.1;await owner.port.homingTravel(target,5,signal);assert.deepEqual(f.transport.stops,[0,0]);
  t.diagnostic(JSON.stringify({stowOnEachSample:stow,wallMs:performance.now()-start,hits:simulation.probeHits,stowed:!device.status.deployed}));
  if(process.env.BLTOUCH_CLOCK_DIAGNOSTIC==='1')t.diagnostic(inspect(clockDiagnostic(),{depth:8,maxArrayLength:100}));
 }finally{await service?.close();simulation.close();await journal.close();await f.close();await rm(dir,{recursive:true,force:true});}
});
