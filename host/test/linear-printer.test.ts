import test from 'node:test';
import assert from 'node:assert/strict';
import {planLinearPrinter} from '../src/config/linear-printer.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {configuredPrinterFixture} from './helpers/configured-printer.ts';
import {startClockedPrinter} from '../src/runtime/configured-printer.ts';
const policy={mcus:['mcu','aux'],enableLeadTime:.001,fanMinimumScheduleTime:.001};
for(const kind of ['cartesian','corexy','corexz','hybrid_corexy','hybrid_corexz'])test(`automatic linear plan starts native ${kind} hardware with no homing grant`,async()=>{
 const f=await configuredPrinterFixture();try{
  const original=f.reader.source.original,r=new ConfigurationReader(new ConfigurationSource('/linear.cfg',{...original,printer:{...original.printer,kinematics:kind}},[]),null),plan=planLinearPrinter(r,policy);
  const owner=await startClockedPrinter(r,f.group,'mcu',plan.layout,{...f.options,hardware:{...f.options.hardware,motion:plan.motion},motion:plan.initial,linear:plan.linear},f.signal);
  assert.equal(owner.hardware.status.state,'ready');assert.equal(owner.linear.kinematics.status.homedAxes,'');assert.equal(f.firmware[0].motion.length,0);assert.deepEqual(owner.initial.emitters.map(e=>e.mode),kind==='cartesian'?['x','y','z','extruder']:kind==='corexy'?['corexy+','corexy-','z','extruder']:kind==='corexz'?['corexz+','y','corexz-','extruder']:kind==='hybrid_corexy'?['corexy-','y','z','extruder']:['corexz-','y','z','extruder']);await owner.close();
 }finally{await f.close();}
});
test('extra Z motor with independent endstop gets complete disjoint stop ownership',async()=>{
 const f=await configuredPrinterFixture();try{
  const r=new ConfigurationReader(new ConfigurationSource('/extra.cfg',{...f.reader.source.original,stepper_z1:{step_pin:'aux:PA6',dir_pin:'aux:PA7',endstop_pin:'aux:PA8',enable_pin:'!aux:PA9',rotation_distance:'40',microsteps:'16'}},[]),null),plan=planLinearPrinter(r,policy);
  assert.deepEqual(plan.linear.homing[2],[{section:'stepper_z',emitters:['x','y','z','e']},{section:'stepper_z1',emitters:['z1']}]);
  const owner=await startClockedPrinter(r,f.group,'mcu',plan.layout,{...f.options,hardware:{...f.options.hardware,motion:plan.motion},motion:plan.initial,linear:plan.linear},f.signal);
  assert.equal(owner.initial.emitters.length,5);assert.equal(owner.linear.kinematics.status.homedAxes,'');assert.equal(f.firmware[1].motion.length,0);await owner.close();assert.deepEqual(f.stops,[1,1]);
 }finally{await f.close();}
});
test('unsupported motor topology and GPIO-only homing ownership fail before configuration',async()=>{
 const f=await configuredPrinterFixture();try{
  for(const name of ['stepper_a','extruder1']){const r=new ConfigurationReader(new ConfigurationSource('/bad.cfg',{...f.reader.source.original,[name]:{}},[]),null);assert.throws(()=>planLinearPrinter(r,policy),/topology/);}
  const original=f.reader.source.original,r=new ConfigurationReader(new ConfigurationSource('/gpio.cfg',{...original,stepper_x:{...original.stepper_x,endstop_pin:'aux:PA8'}},[]),null);assert.throws(()=>planLinearPrinter(r,policy),/kinematic motor/);assert.equal(f.group.session('mcu').status.configured,false);assert.deepEqual(f.stops,[0,0]);
 }finally{await f.close();}
});
test('extra motors sharing an endstop remain owned in every homing axis',async()=>{
 const f=await configuredPrinterFixture();try{
  const r=new ConfigurationReader(new ConfigurationSource('/shared.cfg',{...f.reader.source.original,stepper_z2:{step_pin:'aux:PA6',dir_pin:'aux:PA7',rotation_distance:'40',microsteps:'16'}},[]),null),plan=planLinearPrinter(r,policy);
  assert.deepEqual(plan.motion.map(m=>m.emitter),['x','y','z','z2','e']);for(const groups of plan.linear.homing){assert.equal(groups.length,1);assert.deepEqual(groups[0].emitters,['x','y','z','z2','e']);}
  assert(plan.layout.homing.every(h=>h.mcus.includes('mcu')&&h.mcus.includes('aux')));
 }finally{await f.close();}
});
test('probe pin is independently allocated and wired into the native owner',async()=>{
 const f=await configuredPrinterFixture();try{
  const r=new ConfigurationReader(new ConfigurationSource('/probe.cfg',{...f.reader.source.original,probe:{pin:'^!PA13',z_offset:'1.2'}},[]),null),plan=planLinearPrinter(r,policy);
  assert.deepEqual(plan.linear.probe,[{section:'probe',emitters:['x','y','z','e']}]);
  const owner=await startClockedPrinter(r,f.group,'mcu',plan.layout,{...f.options,hardware:{...f.options.hardware,motion:plan.motion},motion:plan.initial,linear:plan.linear},f.signal);
  try{
   const probe=owner.hardware.plan.homing.find(h=>h.section==='probe')!;assert(probe);assert.equal(probe.pin.invert,1);assert.equal(probe.pin.pullup,1);
   assert(!owner.hardware.plan.homing.filter(h=>h.section!=='probe').some(h=>h.endstop.oid===probe.endstop.oid));
   owner.linear.kinematics.markHomed([0,1,2]);await owner.linear.port.forcePosition([50,0,1,0],f.signal);
   // Inverted input at raw zero is triggered. Verify the configured path queries
   // this new OID and rejects before it can arm a downward seek.
   const before=f.firmware[0].outputs.length;
   await assert.rejects(owner.linear.port.probeConfiguredZ(0,5,f.signal),/already triggered/);
   const output=f.firmware[0].outputs.slice(before);assert(output.some(m=>m.name==='endstop_query_state'&&m.parameters.oid===probe.endstop.oid));assert(!output.some(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0));
  }finally{await owner.close();}
 }finally{await f.close();}
});
test('automatic layout includes thermal fans without assigning them to M106',async()=>{
 const f=await configuredPrinterFixture();try{
  const r=new ConfigurationReader(new ConfigurationSource('/thermal.cfg',{...f.reader.source.original,'heater_fan hotend':{pin:'aux:PA13'},'temperature_fan chamber':{pin:'PA14',sensor_type:'temperature_host',min_temp:'0',max_temp:'100',control:'watermark'}},[]),null),plan=planLinearPrinter(r,policy);
  assert(plan.layout.fans.some(f=>f.section==='heater_fan hotend'));assert.equal(plan.initial.fanSection,'fan');
  assert(plan.layout.fans.some(f=>f.section==='temperature_fan chamber'));assert(plan.layout.sensors!.some(s=>s.section==='temperature_fan chamber'));
 }finally{await f.close();}
});

test('probe virtual Z reuses the probe GPIO and trigger owners without duplicate allocation',async()=>{
 const f=await configuredPrinterFixture();try{
  const raw=structuredClone(f.reader.source.original);delete raw.stepper_z.position_endstop;raw.stepper_z.endstop_pin='probe:z_virtual_endstop';raw.probe={pin:'^PA13',z_offset:'1.2'};
  const cfg=()=>new ConfigurationReader(new ConfigurationSource('/probe-home.cfg',structuredClone(raw),[]),null),plan=planLinearPrinter(cfg(),policy);
  assert.equal(plan.layout.homing.filter(h=>h.section==='probe').length,1);assert.equal(plan.layout.homing.some(h=>h.section==='stepper_z'),false);assert.deepEqual(plan.linear.homing[2],plan.linear.probe);
  const owner=await startClockedPrinter(cfg(),f.group,'mcu',plan.layout,{...f.options,hardware:{...f.options.hardware,motion:plan.motion},motion:plan.initial,linear:plan.linear},f.signal);
  assert.equal(owner.linear.rails[2].endstop,1.2);assert.equal(owner.linear.kinematics.status.homedAxes,'');await owner.close();
  raw.stepper_z.position_endstop='0';assert.throws(()=>planLinearPrinter(cfg(),policy),/position_endstop/);delete raw.stepper_z.position_endstop;
  raw.stepper_z.homing_positive_dir='true';assert.throws(()=>planLinearPrinter(cfg(),policy),/descend/);raw.stepper_z.homing_positive_dir='false';
  raw.safe_z_home={home_xy_position:'-1,50'};assert.throws(()=>planLinearPrinter(cfg(),policy),/safe Z/);delete raw.safe_z_home;
  raw.stepper_z1={step_pin:'aux:PA6',dir_pin:'aux:PA7',endstop_pin:'aux:PA8',rotation_distance:'40',microsteps:'16'};assert.throws(()=>planLinearPrinter(cfg(),policy),/mix/);
 }finally{await f.close();}
});
test('hybrid planners reject incomplete dual carriage and coupled-Z independent leveling',async()=>{
 const f=await configuredPrinterFixture();try{
  for(const kind of ['hybrid_corexy','hybrid_corexz']){const original=f.reader.source.original,sections:Record<string,Record<string,string>>={...original,printer:{...original.printer,kinematics:kind},dual_carriage:{axis:'x'}};assert.throws(()=>planLinearPrinter(new ConfigurationReader(new ConfigurationSource('/dual.cfg',sections,[]),null),policy),/position_max|parse/i);}
  for(const section of ['z_tilt','quad_gantry_level']){const original=f.reader.source.original,sections:Record<string,Record<string,string>>={...original,printer:{...original.printer,kinematics:'hybrid_corexz'},probe:{pin:'PA13',z_offset:'0'},[section]:{}};assert.throws(()=>planLinearPrinter(new ConfigurationReader(new ConfigurationSource('/coupled-z.cfg',sections,[]),null),policy),/independent Z/);}
  assert.equal(f.group.session('mcu').status.configured,false);assert.equal(f.group.session('aux').status.configured,false);
 }finally{await f.close();}
});
