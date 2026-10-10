import {serialClock} from '../src/protocol/serial-queue.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {productMachineFixture} from './helpers/product-machine.ts';
import {loadProductMachineProfile} from '../src/runtime/product-machine-profile.ts';
import {startConfiguredProductService} from '../src/runtime/product-service.ts';
import {BedMeshProfiles} from '../src/motion/bed-mesh-profiles.ts';
import {inspect} from 'node:util';
for(const circular of [false,true])test(`HTTP grid calibration measures, activates, saves and reloads; circular=${circular}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'config-product-')),f=await productMachineFixture(dir),signal=new AbortController().signal;
 let timer:ReturnType<typeof setInterval>|undefined;let profile:Awaited<ReturnType<typeof loadProductMachineProfile>>|undefined,service:Awaited<ReturnType<typeof startConfiguredProductService>>|undefined;
 try{
  const geometry=circular?'mesh_radius: 1\nmesh_origin: 50,2\nround_probe_count: 3':'mesh_min: 50,0\nmesh_max: 50.02,0.02\nprobe_count: 3';
  await writeFile(f.config.printerConfig,(await readFile(f.config.printerConfig,'utf8'))+'\n[probe]\npin: ^PA13\nz_offset: 0\n[bed_mesh]\n'+geometry+'\nmesh_pps: 0\nhorizontal_move_z: 1\nzero_reference_position: 50.03,0.01\n');
  profile=await loadProductMachineProfile(f.path,async()=>f.bindings,signal);service=await startConfiguredProductService(profile.reader,profile.policies,profile.product,profile.options,signal);
  const port=service.printer.linear.port;
  await service.printer.print.gcode.dispatch.runExclusive(async owned=>{service!.printer.linear.kinematics.markHomed([0,1,2]);await port.forcePosition([50,0,1,0],owned);},signal);
  const fw=f.transport.firmware[0],binding=service.printer.hardware.plan.homing.find(h=>h.section==='probe')!,z=service.printer.hardware.plan.steppers.find(m=>m.section==='stepper_z')!,handled=new Set<unknown>();let hits=0;
  timer=setInterval(()=>{if(service!.printer.group.status.state!=='ready')return;for(const heater of service!.printer.hardware.plan.heaters){const session=service!.printer.group.session(heater.sensor.mcu),raw=Math.round(heater.configuration.converter.adc(25)*heater.sensor.adc.maximumSum),next=session.clock.sync.getClock(serialClock.now())+292000n;f.transport.firmware[1].emit('analog_in_state',{oid:heater.sensor.adc.oid,next_clock:Number(BigInt.asUintN(32,next)),values:Buffer.from([raw&255,raw>>8])});}const arm=fw.outputs.find(m=>m.name==='endstop_home'&&m.parameters.oid===binding.endstop.oid&&Number(m.parameters.sample_count)>0&&!handled.has(m));if(!arm)return;const hit=Number(arm.parameters.clock)+50000;if(BigInt(fw.currentClock())<BigInt(hit+1000))return;handled.add(arm);hits++;fw.setTriggerReason(1,binding.triggers[0].protocol.oid);fw.setStepperPosition(z.compressor.oid,-15*hits);fw.setEndstopState({homing:0,pin_value:0,next_clock:hit+Number(arm.parameters.rest_ticks)},binding.endstop.oid);fw.emit('trsync_state',{oid:binding.triggers[0].protocol.oid,can_trigger:0,trigger_reason:1,clock:hit});},10);
  const base=`http://127.0.0.1:${service.address.port}`,headers={'Content-Type':'application/json'};let request!:{version:number;state_token:string},measured!:Response;
  // Retain dispatch through the single positive HTTP admission and receipt;
  // opportunistic clock maintenance must not overtake the idle precondition.
  await service.printer.print.gcode.dispatch.runExclusive(async owned=>{
   owned.throwIfAborted();assert.equal(port.status.busy,false);assert.equal(await service!.printer.print.gcode.dispatch.runWhenIdle(async()=>assert.fail('Clock maintenance entered held grid calibration'),owned),false);
   const calibration=await (await fetch(base+'/printer/calibration/bed_mesh')).json() as any;assert.equal(calibration.result.available,true);request={version:1,state_token:calibration.result.state_token};
   measured=await fetch(base+'/printer/calibration/bed_mesh',{method:'POST',headers,body:JSON.stringify(request)});
  },signal);
  if(measured.status!==200)console.error(port.status.fault);assert.equal(measured.status,200,await measured.clone().text());assert.equal(hits,circular?6:10);assert.equal(port.bedMeshStatus.profile_name,'measured');
  const repeated=await fetch(base+'/printer/calibration/bed_mesh',{method:'POST',headers,body:JSON.stringify(request)});assert.equal(repeated.status,200);assert.equal(hits,circular?6:10);
  const mesh=port.currentBedMesh()!;let status:any,saved!:Response;
  await service.printer.print.gcode.dispatch.runExclusive(async owned=>{
   owned.throwIfAborted();assert.equal(port.status.busy,false);status=await (await fetch(base+'/printer/configuration')).json() as any;assert.equal(status.result.available,true);
   saved=await fetch(base+'/printer/configuration/bed_mesh',{method:'POST',headers,body:JSON.stringify({version:1,state_token:status.result.state_token,profile:'retained'})});
  },signal);
  assert.equal(saved.status,200,await saved.clone().text()+(saved.status===200?'':'\n'+inspect({configuration:status.result,controller:{state:service.printer.controller.state,pendingDeviceActions:service.printer.controller.pendingDeviceActions,safeStopPending:service.printer.controller.safeStopPending,failure:service.printer.controller.failure},port:port.status,group:service.printer.group.status,hardware:service.printer.hardware.status,maintenance:profile.product.maintenanceGate.status,physicalStops:f.transport.stops},{depth:5})));assert.equal((await saved.json() as any).result.state,'saved');assert(profile.product.maintenanceGate.status.closed);
  assert.equal(service.printer.linear.port.bedMeshStatus.profile_name,'measured');assert.equal(mesh.probedValues().length,9);
  clearInterval(timer);timer=undefined;await service.close();service=undefined;await profile.release();profile=undefined;
  profile=await loadProductMachineProfile(f.path,async()=>f.bindings,signal);assert.deepEqual(new BedMeshProfiles(profile.reader).load('retained').probedValues(),mesh.probedValues());assert(!profile.product.maintenanceGate.status.closed);const restored=new BedMeshProfiles(profile.reader).load('retained');assert.deepEqual(restored.params,mesh.params);for(const [x,y] of [[49,1],[50,2],[51,3],[50.01,.01]])assert.equal(restored.calcZ(x,y),mesh.calcZ(x,y));
 }finally{clearInterval(timer);await service?.close();await profile?.release();await f.close();await rm(dir,{recursive:true,force:true});}
});
