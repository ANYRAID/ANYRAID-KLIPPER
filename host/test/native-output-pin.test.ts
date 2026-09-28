import test from 'node:test';
import assert from 'node:assert/strict';
import {configuredPrinterFixture} from './helpers/configured-printer.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {planLinearPrinter} from '../src/config/linear-printer.ts';
import {startConfiguredPrinter} from '../src/runtime/configured-printer.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {serialClock} from '../src/protocol/serial-queue.ts';
async function fixture(){
 const f=await configuredPrinterFixture();
 try{
  const reader=new ConfigurationReader(new ConfigurationSource('/pins.cfg',{...f.reader.source.original,
   'output_pin light':{pin:'!PA13'},
   'output_pin duty':{pin:'aux:PA13',pwm:'true',hardware_pwm:'true',scale:'100'},
  },[]),null);
  const plan=planLinearPrinter(reader,{mcus:['mcu','aux'],enableLeadTime:.001,fanMinimumScheduleTime:.001});
  const printer=await startConfiguredPrinter(reader,f.group,f.clocks,plan.layout,{...f.options,motion:plan.initial},f.signal);
  printer.print.gcode.enable();
  const writes=(name:string)=>{const p=printer.hardware.plan.outputPins.find(p=>p.settings.name===name)!;return f.firmware[p.mcu==='mcu'?0:1].outputs.filter(e=>e.parameters.oid===p.output.config.oid&&e.name.startsWith('queue_')&&e.name.endsWith('_generation'));};
  return {f,printer,writes,async close(){await printer.close();await f.close();}};
 }catch(error){await f.close();throw error;}
}
test('SET_PIN and fan commands share motion markers across two MCUs without stopping junctions',async()=>{
 const t=await fixture();try{
  const {printer:p}=t;p.linear.kinematics.markHomed([0]);
  const source=p.initial.generation.source,append=source.append.bind(source);let junction=0;
  source.append=moves=>{junction=Math.max(junction,moves[0]?.profile?.endV??0);append(moves);};
  await p.print.gcode.dispatch.execute('G1 X1 F600\nSET_PIN PIN=light VALUE=1\nM106 S128\nSET_PIN PIN=duty VALUE=75\nG1 X2 F600\nSET_PIN PIN=light VALUE=0');
  assert.ok(junction>0);assert.deepEqual(t.writes('light').map(e=>e.parameters.on_ticks),[0,1]);
  assert.deepEqual(t.writes('duty').map(e=>e.parameters.value),[191]);
  assert.equal(p.hardware.outputPins[1].runtime.status.value,.75);assert.deepEqual(t.f.stops,[0,0]);
  const count=t.writes('light').length;await p.print.gcode.dispatch.execute('M400\nM400');assert.equal(t.writes('light').length,count);
 }finally{await t.close();}
});
test('idle SET_PIN needs no homing and unknown or template commands cannot run the suffix',async()=>{
 const t=await fixture();try{
  await t.printer.print.gcode.dispatch.execute('SET_PIN PIN=light VALUE=1\nSET_PIN PIN=duty VALUE=25');
  assert.ok(t.f.firmware.every(f=>f.motion.length===0));assert.deepEqual(t.writes('duty').map(e=>e.parameters.value),[64]);
  await assert.rejects(t.printer.print.gcode.dispatch.execute('SET_PIN PIN=light TEMPLATE=arbitrary\nSET_PIN PIN=duty VALUE=90'),/fixed VALUE/);
  assert.deepEqual(t.writes('duty').map(e=>e.parameters.value),[64]);
 }finally{await t.close();}
});

test('a stale auxiliary MCU clock prevents completion even after both output writes are ACKed',async()=>{
 const t=await fixture(),controller=new AbortController();
 try{
  t.f.firmware[1].ignore('get_clock');
  await t.printer.linear.port.queueOutputPin('light',1,t.f.signal);
  await t.printer.linear.port.queueOutputPin('duty',50,t.f.signal);
  let finished=false;const pending=t.printer.linear.port.flush(controller.signal);
  const result=pending.then(()=>{finished=true;return null;},error=>error);
  const deadline=performance.now()+3000;
  while(!t.writes('light').length||!t.writes('duty').length){assert.ok(performance.now()<deadline);await delay(2);}
  await delay(350);assert.equal(finished,false);
  controller.abort(new Error('cancel clocks'));assert.ok(await result instanceof Error);assert.deepEqual(t.f.stops,[1,1]);
 }finally{controller.abort();await t.close();}
});

test('homing transfers multi-MCU output ownership without replaying values or losing routes',async()=>{
 const t=await fixture();let timer:ReturnType<typeof setInterval>|undefined;
 try{
  const p=t.printer,h=p.hardware.plan.homing.find(h=>h.section==='stepper_x')!,trigger=h.triggers[0].protocol.oid;
  await p.print.gcode.dispatch.execute('SET_PIN PIN=light VALUE=1\nSET_PIN PIN=duty VALUE=50');
  const resets=t.f.firmware.flatMap(f=>f.outputs).filter(e=>e.name.startsWith('reset_')&&e.name.endsWith('_generation')).length;
  let sent=false;timer=setInterval(()=>{
   const fw=t.f.firmware[0],arm=fw.outputs.find(e=>e.name==='endstop_home'&&e.parameters.oid===h.endstop.oid&&Number(e.parameters.sample_count)>0);
   if(!arm||sent)return;const clock=Number(arm.parameters.clock);
   if(t.f.group.session('mcu').clock.sync.getClock(serialClock.now())<BigInt(clock))return;sent=true;
   fw.setTriggerReason(1,trigger);fw.setEndstopState({homing:0,pin_value:0,next_clock:clock+Number(arm.parameters.rest_ticks)},h.endstop.oid);
   fw.emit('trsync_state',{oid:trigger,can_trigger:0,trigger_reason:1,clock});
  },1);
  await p.print.gcode.dispatch.execute('G28 X');clearInterval(timer);timer=undefined;assert.ok(sent);
  assert.throws(()=>p.initial.generation.boundaryOutput!.register(1,'output_pin light'),/ownership transferred/);
  assert.equal(t.f.firmware.flatMap(f=>f.outputs).filter(e=>e.name.startsWith('reset_')&&e.name.endsWith('_generation')).length,resets);
  await p.print.gcode.dispatch.execute('SET_PIN PIN=light VALUE=0\nSET_PIN PIN=duty VALUE=25');
  assert.deepEqual(t.writes('light').map(e=>e.parameters.on_ticks),[0,1]);assert.deepEqual(t.writes('duty').map(e=>e.parameters.value),[128,64]);
 }finally{if(timer)clearInterval(timer);await t.close();}
});
