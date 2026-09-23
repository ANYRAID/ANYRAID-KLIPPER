import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {hardwareStartupFixture} from './helpers/hardware-startup.ts';
import {hardwareReader,hardwareLayout} from './helpers/configured-hardware.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
const until=async(check:()=>boolean)=>{const end=performance.now()+2000;while(!check()){assert(performance.now()<end,'startup observation timeout');await delay(2);}};
test('hardware owner configures all MCUs before outputs and publishes started heater/fan/motor owners',async()=>{
 const f=await hardwareStartupFixture(),controller=new AbortController();
 try{
  const aux=f.group.session('aux'),configure=aux.configure.bind(aux);aux.configure=async(...args)=>{assert.equal(f.group.session('mcu').status.configured,true);assert(!f.firmware.flatMap(fw=>fw.outputs).some(o=>o.name.startsWith('reset_')));return configure(...args);};
  const owner=await startConfiguredHardware(hardwareReader(),f.group,f.clocks,hardwareLayout,{beforeTarget(){},heaterGcodeIds:{extruder:'T'},motion:[{emitter:'x',queueId:'xyz',mode:'x'}]},controller.signal);
  assert.equal(owner.emitters![0].settings.oid,owner.plan.steppers[0].compressor.oid);assert.equal(owner.emitters![0].member,0);assert.equal(owner.status.state,'ready');assert.equal(owner.heaters.status.started,true);assert.equal(owner.analog[0].sensor.status.active,true);assert.equal(owner.analog[0].outputStatus?.defaultConfirmed,true);assert.equal(owner.fans[0].runtime.status.phase,'ready');assert.equal(owner.motorEnable?.status.lines[0].enabled,false);
  assert.equal(owner.heaters.report(),'T:0.0 /0.0');controller.abort();assert.equal(owner.status.state,'ready');
  const closing=owner.close();assert.equal(owner.close(),closing);await closing;assert.equal(owner.status.state,'stopped');assert.deepEqual(f.stops,[1,1]);assert.equal(owner.analog[0].sensor.status.closed,true);assert.equal(owner.heaters.status.stopConfirmed,true);assert.equal(owner.fans[0].runtime.status.phase,'stopped');assert.equal(owner.motorEnable?.status.stopped,true);
 }finally{await f.close();}
});
test('invalid planning has no device side effects and corrected startup can proceed',async()=>{
 const f=await hardwareStartupFixture();try{
  await assert.rejects(startConfiguredHardware(hardwareReader('STEP'),f.group,f.clocks,hardwareLayout,{beforeTarget(){}},f.signal),/exclusively|used multiple times/);assert.deepEqual(f.stops,[0,0]);assert.equal(f.group.session('mcu').status.configured,false);
  const owner=await startConfiguredHardware(hardwareReader(),f.group,f.clocks,hardwareLayout,{beforeTarget(){}},f.signal);await assert.rejects(startConfiguredHardware(hardwareReader(),f.group,f.clocks,hardwareLayout,{beforeTarget(){}},f.signal),/ownership/);assert.equal(owner.status.state,'ready');await owner.close();
 }finally{await f.close();}
});
for(const mode of ['cancel','timeout'] as const)test(`second MCU configuration ${mode} stops peers before any output reset`,async()=>{
 const f=await hardwareStartupFixture(),controller=new AbortController();try{
  f.firmware[1].ignore('get_config');
  const pending=startConfiguredHardware(hardwareReader(),f.group,f.clocks,hardwareLayout,{beforeTarget(){},timeoutMs:mode==='timeout'?100:5000},controller.signal),rejected=assert.rejects(pending,mode==='timeout'?/timed out/:/cancel startup/);
  await until(()=>f.group.session('mcu').status.configured);if(mode==='cancel')controller.abort(new Error('cancel startup'));await rejected;
  assert.deepEqual(f.stops,[1,1]);assert.equal(f.group.status.state,'stopped');assert(!f.firmware.flatMap(fw=>fw.outputs).some(o=>o.name.startsWith('reset_')));
 }finally{await f.close();}
});
test('live MCU fault closes every published hardware owner',async()=>{
 const f=await hardwareStartupFixture();try{
  const owner=await startConfiguredHardware(hardwareReader(),f.group,f.clocks,hardwareLayout,{beforeTarget(){}},f.signal);
  await f.group.stop(new Error('lost MCU'));await owner.close();assert.equal(owner.status.state,'stopped');assert.match(String(owner.status.fault),/lost MCU/);assert.equal(owner.heaters.status.closed,true);assert.equal(owner.analog[0].sensor.status.closed,true);assert.equal(owner.fans[0].runtime.status.phase,'stopped');
 }finally{await f.close();}
});
test('independent safety failure stays observable and idempotent on owner close',async()=>{
 const f=await hardwareStartupFixture(true);try{
  const owner=await startConfiguredHardware(hardwareReader(),f.group,f.clocks,hardwareLayout,{beforeTarget(){}},f.signal),closing=owner.close();assert.equal(owner.close(),closing);await assert.rejects(closing,/hardware stop failed/);assert.equal(owner.status.state,'failed');assert(owner.status.stopError);assert.deepEqual(f.stops,[1,1]);
 }finally{await assert.rejects(f.close());}
});
test('ADC report arriving during configuration is buffered and enables fresh temperature admission',async()=>{
 const f=await hardwareStartupFixture();try{
  const aux=f.group.session('aux'),configure=aux.configure.bind(aux),emit=()=>{const next=aux.clock.sync.getClock(serialClock.now())+292000n;f.firmware[1].emit('analog_in_state',{oid:4,next_clock:Number(BigInt.asUintN(32,next)),values:Buffer.from([0x80,0x70])});};
  aux.configure=async(...args)=>{const result=await configure(...args);emit();await delay(5);return result;};
  let barriers=0;const owner=await startConfiguredHardware(hardwareReader(),f.group,f.clocks,hardwareLayout,{beforeTarget(){barriers++;}},f.signal);
  assert(owner.analog[0].sensor.status.lastSample);assert.equal(owner.analog[0].runtime.status.received,true);
  await owner.heaters.setTarget('extruder',200,f.signal);assert.equal(barriers,1);emit();await until(()=>f.firmware[1].outputs.some(o=>o.name==='queue_digital_out_generation'&&Number(o.parameters.on_ticks)>0));
  await owner.heaters.turnOffAll();assert.equal(owner.analog[0].runtime.status.target,0);assert.equal(owner.analog[0].outputStatus?.defaultConfirmed,true);await owner.close();
 }finally{await f.close();}
});
test('subscription registration failure after ownership transfer closes both MCUs without configuration',async()=>{
 const f=await hardwareStartupFixture();try{
  await assert.rejects(startConfiguredHardware(hardwareReader(),f.group,f.clocks,hardwareLayout,{beforeTarget(){},heaterGcodeIds:{extruder:'invalid id'}},f.signal),/G-code id/);
  assert.deepEqual(f.stops,[1,1]);assert.equal(f.firmware[0].stepperConfigs.length,0);assert.equal(f.firmware[1].outputs.length,0);
 }finally{await f.close();}
});
