import test from 'node:test';
import assert from 'node:assert/strict';
import {planDeltaHardware,compileDeltaHoming} from '../src/config/delta-printer.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {initialMotionSetup,initialMotionOptions} from './helpers/initial-motion.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {initializeConfiguredMotion} from '../src/runtime/initial-motion.ts';
const policy={mcus:['mcu','aux'],enableLeadTime:.001,fanMinimumScheduleTime:.001};
function delta(original:Record<string,Record<string,string>>){
 const raw=structuredClone(original);
 for(const [axis,tower] of [['x','a'],['y','b'],['z','c']]){raw[`stepper_${tower}`]={...raw[`stepper_${axis}`],position_endstop:'300'};delete raw[`stepper_${axis}`];}
 Object.assign(raw.printer,{kinematics:'delta',delta_radius:'100'});raw.stepper_a.arm_length='250';
 Object.assign(raw.stepper_b,{step_pin:'aux:PA6',dir_pin:'aux:PA7',endstop_pin:'aux:PA8',enable_pin:'!aux:PA9'});
 return raw;
}
const reader=(raw:Record<string,Record<string,string>>)=>new ConfigurationReader(new ConfigurationSource('/delta-hardware.cfg',structuredClone(raw),[]),null);
test('Delta configured hardware resolves independent tower stops across MCU orderings',async()=>{
 for(const reverse of [false,true]){
  const f=await initialMotionSetup(reverse,true,true);try{
   const r=reader(delta(f.reader.source.original)),p=planDeltaHardware(r,policy);
   assert.deepEqual(p.homing.map(h=>h.emitters),[['a','e'],['b'],['c']]);
   const hardware=await startConfiguredHardware(r,f.group,f.clocks,p.layout,{...f.hardwareOptions,motion:p.motion},f.signal);
   try{
    const initial=await initializeConfiguredMotion(hardware,initialMotionOptions,f.signal),groups=compileDeltaHoming(hardware.plan,initial.generation,p.homing);
    assert.deepEqual(groups.map(g=>g.members.flatMap(m=>m.emitters)),[['a','e'],['b'],['c']]);
    for(const g of groups)for(const m of g.members)for(const id of m.emitters)assert.equal(initial.generation.motion.bindings.find(b=>b.id===id)!.member,m.physicalMember);
    assert.equal(p.config.kinematics.status.homedAxes,'');assert(f.firmware.every(f=>f.motion.length===0));
    assert.throws(()=>compileDeltaHoming(hardware.plan,initial.generation,p.homing.slice(1)),/omits motors/);
   }finally{await hardware.close();}
  }finally{await f.close();}
 }
});
test('Delta extra motors inherit tower stops or own independent endstops; foreign GPIO fails before IO',async()=>{
 const f=await initialMotionSetup(false,true,true);try{
  const raw=delta(f.reader.source.original);raw.stepper_c1={step_pin:'PA13',dir_pin:'PA14',rotation_distance:'40',microsteps:'16',enable_pin:'!PA2'};
  assert.deepEqual(planDeltaHardware(reader(raw),policy).homing[2].emitters,['c','c1']);
  raw.stepper_c1.endstop_pin='PA15';assert.deepEqual(planDeltaHardware(reader(raw),policy).homing.slice(2),[{section:'stepper_c',emitters:['c']},{section:'stepper_c1',emitters:['c1']}]);
  raw.stepper_b.endstop_pin='PA16';assert.throws(()=>planDeltaHardware(reader(raw),policy),/own tower/);
  assert.equal(f.group.session('mcu').status.configured,false);assert.deepEqual(f.stops,[0,0]);
 }finally{await f.close();}
});
