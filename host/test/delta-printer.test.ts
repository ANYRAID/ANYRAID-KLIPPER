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
   assert.equal(p.homingSettings.speed,p.config.rails[0].homing.speed);assert.deepEqual(p.homingSettings.endstops,p.homing.map(g=>g.section));
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

test('Delta native simultaneous seek recovers independently timed tower halts without homing authority',async()=>{
 const {LinearHomingSeek}=await import('../src/homing/linear-seek.ts');
 const {serialClock}=await import('../src/protocol/serial-queue.ts');
 const f=await initialMotionSetup(false,true,true),timers:ReturnType<typeof setTimeout>[]=[];
 let recovered:Awaited<ReturnType<InstanceType<typeof LinearHomingSeek>['run']>>|undefined;
 try{
  const r=reader(delta(f.reader.source.original)),p=planDeltaHardware(r,policy),home=p.config.kinematics.homePosition;
  const hardware=await startConfiguredHardware(r,f.group,f.clocks,p.layout,{...f.hardwareOptions,motion:p.motion},f.signal);
  try{
   const initial=await initializeConfiguredMotion(hardware,{...initialMotionOptions,position:[home[0],home[1],home[2]-1,0]},f.signal),g=initial.generation;
   const groups=compileDeltaHoming(hardware.plan,g,p.homing);
   for(const [index,group] of groups.entries()){
    const member=group.members[group.primary],session=g.members[member.physicalMember].session;
    const fw=f.firmware[session===f.group.session('mcu')?0:1];
    const motor=g.motion.bindings.find(b=>b.id===p.kinematicIds[index])!,hit=motor.stepper.clockAt(g.motion.printTime+.052+index*.008);
    const halt=Number(motor.history.status.lastPlannedPosition)+50+index;
    timers.push(setTimeout(()=>{
     fw.setTriggerReason(1,member.trigger.oid);fw.setStepperPosition(motor.oid,halt);
     const command=fw.outputs.find(m=>m.name==='endstop_home'&&Number(m.parameters.oid)===group.endstop.oid&&Number(m.parameters.sample_count)>0);
     fw.setEndstopState({homing:0,pin_value:0,next_clock:Number(hit)+Number(command?.parameters.rest_ticks??1000)},group.endstop.oid);
     fw.emit('trsync_state',{oid:member.trigger.oid,can_trigger:0,trigger_reason:1,clock:Number(hit)});
    },Math.max(0,Number(hit-session.clock.sync.getClock(serialClock.now()))/1e6+.01)*1000));
   }
   recovered=await new LinearHomingSeek({generation:g,kinematics:p.config.kinematics,emitters:initial.emitters,kinematicIds:p.kinematicIds,groups}).run([...home,0],10,2,f.signal);
   assert.deepEqual(recovered.missingHits,[]);assert.equal(recovered.movingSteppers.length,3);
   assert.equal(new Set(recovered.stop.groups.map(g=>String(g.hitClock))).size,3);
   assert.deepEqual(recovered.triggerPosition,[...home,0]);assert(recovered.position.every(Number.isFinite));
   assert.notDeepEqual(recovered.position.slice(0,2),home.slice(0,2));
   const actuators=p.config.kinematics.solverGeometry.map((geometry,index)=>{
    const binding=g.motion.bindings.find(b=>b.id===p.kinematicIds[index])!;
    const offset=recovered!.offsets.find(o=>o.member===index&&o.oid===binding.oid)!;
    return home[2]+Math.sqrt(geometry.armLength**2-(geometry.towerX-home[0])**2-(geometry.towerY-home[1])**2)+Number(offset.overshoot)*.0125;
   });
   const expected=p.config.kinematics.calcPosition([actuators[0],actuators[1],actuators[2]]);
   for(let i=0;i<3;i++)assert(Math.abs(recovered.position[i]-expected[i])<1e-10);
   const {HomingRetractExecution}=await import('../src/homing/retract-execution.ts');
   await new HomingRetractExecution(recovered.generation,p.config.kinematics).run([home[0],home[1],home[2]-1,0],10,2,f.signal);
   assert.deepEqual(recovered.generation.source.status.position,[home[0],home[1],home[2]-1,0]);
   assert.equal(recovered.generation.source.status.retired,false);assert.equal(p.config.kinematics.status.homedAxes,'');assert.deepEqual(f.stops,[0,0]);
  }finally{recovered?.motion.dispose();await hardware.close();}
 }finally{for(const timer of timers)clearTimeout(timer);await f.close();}
});

test('Delta mismatched tower geometry stops before arming endstops',async()=>{
 const {LinearHomingSeek}=await import('../src/homing/linear-seek.ts');
 const f=await initialMotionSetup(false,true,true);
 try{
  const r=reader(delta(f.reader.source.original)),p=planDeltaHardware(r,policy),home=p.config.kinematics.homePosition;
  const hardware=await startConfiguredHardware(r,f.group,f.clocks,p.layout,{...f.hardwareOptions,motion:p.motion},f.signal);
  try{
   const initial=await initializeConfiguredMotion(hardware,{...initialMotionOptions,position:[home[0],home[1],home[2]-1,0]},f.signal),groups=compileDeltaHoming(hardware.plan,initial.generation,p.homing);
   const emitters=initial.emitters.map(e=>e.id==='b'?{...e,mode:{...p.config.rails[1].mode,armLength:251}}:e);
   await assert.rejects(new LinearHomingSeek({generation:initial.generation,kinematics:p.config.kinematics,emitters,kinematicIds:p.kinematicIds,groups}).run([...home,0],10,2,f.signal),/solvers differ/);
   assert(f.firmware.every(f=>!f.outputs.some(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0)));assert.equal(p.config.kinematics.status.homedAxes,'');
  }finally{await hardware.close();}
 }finally{await f.close();}
});

test('configured Delta lifetime owner executes two native homing passes, ordinary motion and shutdown',async()=>{
 const f=await initialMotionSetup(false,true,true),timers:ReturnType<typeof setTimeout>[]=[];let watch:ReturnType<typeof setInterval>|undefined;
 try{
  const raw=delta(f.reader.source.original);Object.assign(raw.stepper_a,{homing_retract_dist:'.2',homing_speed:'40',second_homing_speed:'10'});
  const r=reader(raw),p=planDeltaHardware(r,policy),hardware=await startConfiguredHardware(r,f.group,f.clocks,p.layout,{...f.hardwareOptions,motion:p.motion},f.signal);
  try{
   const initial=await initializeConfiguredMotion(hardware,initialMotionOptions,f.signal);
   const foreign=structuredClone(raw);foreign.stepper_b.arm_length='251';assert.throws(()=>initial.createDeltaPort(reader(foreign),p),/geometry differs/);
   const owner=initial.createDeltaPort(r,p);
   assert.throws(()=>initial.createDeltaPort(r,p),/already owned/);assert.throws(()=>owner.port.move([0,0,1,0],10),/home/);
   const seek=owner.port.home.bind(owner.port);
   owner.port.home=async(...args)=>{const result=await seek(...args);for(const h of hardware.plan.homing)for(const t of h.triggers)f.firmware[t.mcu==='mcu'?0:1].setTriggerReason(2,t.protocol.oid);return result;};
   const cursors=[0,0],passes=new Map<string,number>();
   watch=setInterval(()=>{
    for(const [fi,fw] of f.firmware.entries())for(const output of fw.outputs.slice(cursors[fi])){
     if(output.name!=='endstop_home'||Number(output.parameters.sample_count)===0)continue;
     const h=hardware.plan.homing.find(h=>h.mcu===(fi===0?'mcu':'aux')&&h.endstop.oid===Number(output.parameters.oid));if(!h)continue;
     const tower=h.section.slice(8),number=(passes.get(tower)??0)+1;passes.set(tower,number);
     const motor=initial.generation.motion.bindings.find(b=>b.id===tower)!;
     const count=Number(initial.stopped.positions.find(v=>v.oid===motor.oid&&v.member===motor.member)!.position)+number*50;
     const hit=Number(output.parameters.clock)+(number===1?50000:15000)+['a','b','c'].indexOf(tower)*4000;
     const trigger=h.triggers.find(t=>t.mcu===h.mcu)!.protocol;
     timers.push(setTimeout(()=>{fw.setStepperPosition(motor.oid,count);fw.setTriggerReason(1,trigger.oid);fw.setEndstopState({homing:0,pin_value:0,next_clock:hit+Number(output.parameters.rest_ticks)},h.endstop.oid);fw.emit('trsync_state',{oid:trigger.oid,can_trigger:0,trigger_reason:1,clock:hit});},Math.max(0,(hit-fw.currentClock())/1000+10)));
    }
    for(let i=0;i<2;i++)cursors[i]=f.firmware[i].outputs.length;
   },2);
   await owner.homing.home(f.signal);clearInterval(watch);watch=undefined;
   assert.deepEqual([...passes.values()],[2,2,2]);assert.equal(owner.kinematics.status.homedAxes,'xyz');
   assert.throws(()=>owner.port.move([...owner.port.position().slice(0,3),1],10),/temperature/);
   const home=owner.kinematics.homePosition,target=[home[0],home[1],home[2]-2,0];owner.port.move(target,10);await owner.port.drain(f.signal);
   assert.deepEqual(owner.port.position(),target);assert.equal(owner.port.status.failed,false);
   const count=(tower:string)=>{const motor=hardware.plan.steppers.find(s=>s.emitter===tower)!;return f.firmware[motor.mcu==='mcu'?0:1].motion.filter(m=>m.name==='queue_step'&&Number(m.parameters.oid)===motor.compressor.oid).reduce((n,m)=>n+Number(m.parameters.count),0);};
   const before=['a','b','c'].map(count);
   for(let n=1;n<=20;n++)owner.port.move([target[0],target[1],target[2]-n/20,0],.5);
   const running=owner.port.drain(f.signal);void running.catch(()=>{});
   const deadline=performance.now()+3000;while(count('a')===before[0]){if(performance.now()>deadline)throw new Error('Delta stream did not start');await new Promise(r=>setTimeout(r,2));}
   const paused=await owner.port.pauseStream(f.signal);assert(paused.position[2]<target[2]&&paused.position[2]>target[2]-1);
   const held=['a','b','c'].map(count);await new Promise(r=>setTimeout(r,30));assert.deepEqual(['a','b','c'].map(count),held);
   await owner.port.resumeStream(f.signal);await running;await owner.port.drain(f.signal);
   assert.deepEqual(['a','b','c'].map((id,i)=>count(id)-before[i]),[80,80,80]);assert.deepEqual(owner.port.position(),[target[0],target[1],target[2]-1,0]);
   await hardware.close();assert.equal(owner.port.status.failed,true);assert.equal(owner.kinematics.status.homedAxes,'');assert.deepEqual(f.stops,[1,1]);
  }finally{await hardware.close();}
 }finally{clearInterval(watch);for(const t of timers)clearTimeout(t);await f.close();}
});
