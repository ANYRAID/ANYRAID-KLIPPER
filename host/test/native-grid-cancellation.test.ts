import {BedMesh} from '../src/motion/bed-mesh.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {serialClock} from '../src/protocol/serial-queue.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {productMachineFixture} from './helpers/product-machine.ts';
import {loadProductMachineProfile} from '../src/runtime/product-machine-profile.ts';
import {startConfiguredProductService} from '../src/runtime/product-service.ts';
test('HTTP disconnect during grid seek stops native motion and retains prior mesh',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'config-product-')),f=await productMachineFixture(dir),signal=new AbortController().signal;
 let timer:ReturnType<typeof setInterval>|undefined;let profile:Awaited<ReturnType<typeof loadProductMachineProfile>>|undefined,service:Awaited<ReturnType<typeof startConfiguredProductService>>|undefined;
 try{
  await writeFile(f.config.printerConfig,(await readFile(f.config.printerConfig,'utf8'))+'\n[probe]\npin: ^PA13\nz_offset: 0\n[bed_mesh]\nmesh_min: 50,0\nmesh_max: 50.02,0.02\nprobe_count: 3\nmesh_pps: 0\nhorizontal_move_z: 1\nzero_reference_position: 50.03,0.01\n');
  profile=await loadProductMachineProfile(f.path,async()=>f.bindings,signal);service=await startConfiguredProductService(profile.reader,profile.policies,profile.product,profile.options,signal);
  const port=service.printer.linear.port;service.printer.linear.kinematics.markHomed([0,1,2]);await port.forcePosition([50,0,1,0],signal);
  const old=new BedMesh({min_x:0,max_x:100,min_y:0,max_y:100,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct',tension:.2},[[.1,.2],[.3,.4]]);await port.replaceBedMesh(old,{},signal,'prior');const abort=new AbortController(),original=await readFile(f.config.printerConfig,'utf8');
  const fw=f.transport.firmware[0],binding=service.printer.hardware.plan.homing.find(h=>h.section==='probe')!,z=service.printer.hardware.plan.steppers.find(m=>m.section==='stepper_z')!,handled=new Set<unknown>();let hits=0;
  timer=setInterval(()=>{if(service!.printer.group.status.state!=='ready')return;for(const heater of service!.printer.hardware.plan.heaters){const session=service!.printer.group.session(heater.sensor.mcu),raw=Math.round(heater.configuration.converter.adc(25)*heater.sensor.adc.maximumSum),next=session.clock.sync.getClock(serialClock.now())+292000n;f.transport.firmware[1].emit('analog_in_state',{oid:heater.sensor.adc.oid,next_clock:Number(BigInt.asUintN(32,next)),values:Buffer.from([raw&255,raw>>8])});}const arm=fw.outputs.find(m=>m.name==='endstop_home'&&m.parameters.oid===binding.endstop.oid&&Number(m.parameters.sample_count)>0&&!handled.has(m));if(!arm)return;const hit=Number(arm.parameters.clock)+50000;if(service!.printer.group.session('mcu').clock.sync.getClock(serialClock.now())<BigInt(hit+1000))return;handled.add(arm);hits++;if(hits===2){abort.abort(new Error('disconnect grid client'));return;}fw.setTriggerReason(1,binding.triggers[0].protocol.oid);fw.setStepperPosition(z.compressor.oid,-15*hits);fw.setEndstopState({homing:0,pin_value:0,next_clock:hit+Number(arm.parameters.rest_ticks)},binding.endstop.oid);fw.emit('trsync_state',{oid:binding.triggers[0].protocol.oid,can_trigger:0,trigger_reason:1,clock:hit});},10);
  const base=`http://127.0.0.1:${service.address.port}`,headers={'Content-Type':'application/json'},calibration=await (await fetch(base+'/printer/calibration/bed_mesh')).json() as any;
  const request={version:1,state_token:calibration.result.state_token};
  await assert.rejects(fetch(base+'/printer/calibration/bed_mesh',{method:'POST',headers,body:JSON.stringify(request),signal:abort.signal}),/disconnect grid client/);
  const deadline=performance.now()+5000;while(!port.status.failed||profile.product.maintenanceGate.status.maintenance){assert(performance.now()<deadline,'native cancellation did not settle');await delay(5);}
  assert(f.transport.stops.every(count=>count>0),'all configured physical stop adapters must run');assert.equal(hits,2);assert.equal(service.printer.linear.kinematics.status.homedAxes,'');assert(profile.product.maintenanceGate.status.closed);assert.equal(port.bedMeshStatus.profile_name,'prior');assert.deepEqual(port.currentBedMesh()!.probedValues(),old.probedValues());assert.equal(await readFile(f.config.printerConfig,'utf8'),original);
  const status=await (await fetch(base+'/printer/calibration/bed_mesh')).json() as any;assert.equal(status.result.state,'failed');assert.equal(status.result.available,false);
  const home=await (await fetch(base+'/printer/calibration/home')).json() as any;const refused=await fetch(base+'/printer/calibration/home',{method:'POST',headers,body:JSON.stringify({version:1,state_token:home.result.state_token})});assert.equal(refused.status,409);
  assert.throws(()=>profile!.product.maintenanceGate.activity());
 }finally{clearInterval(timer);await service?.close();await profile?.release();await f.close();await rm(dir,{recursive:true,force:true});}
});
