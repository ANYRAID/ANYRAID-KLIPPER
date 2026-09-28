import {deltaPrinterSections as delta} from './helpers/delta-printer.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {planDeltaHardware,compileDeltaHoming} from '../src/config/delta-printer.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {initialMotionSetup,initialMotionOptions} from './helpers/initial-motion.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {initializeConfiguredMotion} from '../src/runtime/initial-motion.ts';
const policy={mcus:['mcu','aux'],enableLeadTime:.001,fanMinimumScheduleTime:.001};

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

const benchRuns=process.env.DELTA_PRINT_BENCH?4:1,segments=process.env.DELTA_PRINT_BENCH?1000:20;
for(let run=0;run<benchRuns;run++)for(const filePrint of (run%2?[true,false]:[false,true]))test(`configured Delta lifetime owner executes homing, pause and shutdown (file=${filePrint}, run=${run})`,async t=>{
 const f=await initialMotionSetup(false,true,true),timers:ReturnType<typeof setTimeout>[]=[];let watch:ReturnType<typeof setInterval>|undefined,temporary:string|undefined;
 const files=await import('node:fs/promises');
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
   const home=owner.kinematics.homePosition,target=[home[0],home[1],home[2]-2,0];
   let printing:Awaited<ReturnType<typeof owner.createPrint>>|undefined,finished=0;
   const eof=Promise.withResolvers<void>();void eof.promise.catch(()=>{});
   if(filePrint){
    temporary=await files.mkdtemp('/tmp/delta-file-print-');const path=temporary+'/job.gcode';
    await files.writeFile(path,Array.from({length:segments},(_,i)=>'G1 Z'+(target[2]-(i+1)/segments)+' F30').join('\n')+'\nM400\n');
    const {GCodeFileReader}=await import('../src/gcode/file-reader.ts');
    printing=await owner.createPrint({output(){},motorCompletion:'hold',startupHoming:{mode:'home',axes:[0]},parking:{parkXY:[home[0],home[1]],retract:0,lift:0,travelSpeed:10,liftSpeed:5,retractSpeed:5},lifecycle:{prepare:async()=>{},start:async()=>{},finishOutputs:async()=>{finished++;},stopOutputs:async()=>{}},open:async()=>GCodeFileReader.adopt(await files.open(path,'r'))});
    printing.device.subscribeEOF(()=>eof.resolve());printing.device.subscribeFault(e=>eof.reject(e));
    await printing.device.prepare({version:1,requestId:'delta-job',fileId:'delta-file',nozzle:0,bed:0},f.signal);
   }else{
    const {DeltaHomingCommand}=await import('../src/homing/delta-command.ts'),{GCodeMove}=await import('../src/gcode/move.ts');
    await new DeltaHomingCommand(owner.kinematics,new GCodeMove(owner.port),owner.port,owner.homingSettings).home(f.signal);
   }
   clearInterval(watch);watch=undefined;
   assert.deepEqual([...passes.values()],[2,2,2]);assert.equal(owner.kinematics.status.homedAxes,'xyz');
   assert.throws(()=>owner.port.move([...owner.port.position().slice(0,3),1],10),/temperature/);
   owner.port.move(target,10);await owner.port.drain(f.signal);printing?.gcode.coordinates.resetPosition();
   assert.deepEqual(owner.port.position(),target);assert.equal(owner.port.status.failed,false);
   const count=(tower:string)=>{const motor=hardware.plan.steppers.find(s=>s.emitter===tower)!;return f.firmware[motor.mcu==='mcu'?0:1].motion.filter(m=>m.name==='queue_step'&&Number(m.parameters.oid)===motor.compressor.oid).reduce((n,m)=>n+Number(m.parameters.count),0);};
   const before=['a','b','c'].map(count),start=performance.now(),cpu=process.cpuUsage();
   let running:Promise<void>;
   if(printing){await printing.device.start('delta-file',f.signal);running=eof.promise;}
   else{for(let n=1;n<=segments;n++)owner.port.move([target[0],target[1],target[2]-n/segments,0],.5);running=owner.port.drain(f.signal);}
   void running.catch(()=>{});
   const deadline=performance.now()+3000;while(count('a')===before[0]){if(performance.now()>deadline)throw new Error('Delta stream did not start');await new Promise(r=>setTimeout(r,2));}
   if(printing)await printing.device.pause(f.signal);
   else{const paused=await owner.port.pauseStream(f.signal);assert(paused.position[2]<target[2]&&paused.position[2]>target[2]-1);}
   const held=['a','b','c'].map(count);await new Promise(r=>setTimeout(r,30));assert.deepEqual(['a','b','c'].map(count),held);
   if(printing)await printing.device.resume(f.signal);else await owner.port.resumeStream(f.signal);
   await running;await owner.port.drain(f.signal);
   if(printing){await printing.device.finish('delta-job',f.signal);assert.equal(finished,1);assert.equal(printing.device.status.requestId,undefined);assert.equal(hardware.heaters.getTemperature('extruder').target,0);assert.equal(hardware.heaters.getTemperature('heater_bed').target,0);assert.equal(printing.file.status.file?.closed,true);}
   assert.deepEqual(['a','b','c'].map((id,i)=>count(id)-before[i]),[80,80,80]);assert.deepEqual(owner.port.position(),[target[0],target[1],target[2]-1,0]);
   if(process.env.DELTA_PRINT_BENCH){const used=process.cpuUsage(cpu);t.diagnostic('DeltaPrintBenchmark '+JSON.stringify({run,filePrint,commands:segments,wallMs:performance.now()-start,cpuMs:(used.user+used.system)/1000}));}
   await hardware.close();assert.equal(owner.port.status.failed,true);assert.equal(owner.kinematics.status.homedAxes,'');assert.deepEqual(f.stops,[1,1]);
  }finally{await hardware.close();}
 }finally{clearInterval(watch);for(const t of timers)clearTimeout(t);await f.close();if(temporary)await files.rm(temporary,{recursive:true,force:true});}
});

for(const reverse of [false,true])test(`automatic Delta connection owns configuration through print assembly (${reverse})`,async()=>{
 const {planDeltaPrinter}=await import('../src/config/delta-printer.ts'),{connectConfiguredDeltaPrinter}=await import('../src/runtime/configured-delta-printer.ts');
 const f=await initialMotionSetup(reverse,true,true,false);
 try{
  const r=reader(delta(f.reader.source.original)),p=planDeltaPrinter(r,policy);
  const owner=await connectConfiguredDeltaPrinter(r,f.connections,'mcu',p.layout,{hardware:{...f.hardwareOptions,motion:p.motion},motion:p.initial,delta:p.delta,print:{output(){},motorCompletion:'hold',startupHoming:{mode:'home',axes:[0,1,2]},parking:{parkXY:[0,0],retract:0,lift:0,travelSpeed:10,liftSpeed:5,retractSpeed:5},lifecycle:{prepare:async()=>{},start:async()=>{},finishOutputs:async()=>{},stopOutputs:async()=>{}},open:async()=>{throw new Error('Unexpected file');}}},f.signal);
  assert.equal(owner.group.status.state,'ready');assert.equal(owner.hardware.status.state,'ready');assert.equal(owner.delta.kinematics.status.homedAxes,'');assert(f.firmware.every(f=>f.motion.length===0));
  await owner.close();assert.equal(owner.delta.port.status.failed,true);assert.equal(owner.hardware.heaters.status.closed,true);assert.deepEqual(f.stops,[1,1]);
 }finally{await f.close();}
});
test('automatic Delta rejects unsupported sections before connecting and closes both MCUs on print assembly failure',async()=>{
 const {planDeltaPrinter}=await import('../src/config/delta-printer.ts'),{connectConfiguredDeltaPrinter}=await import('../src/runtime/configured-delta-printer.ts');
 const f=await initialMotionSetup(false,true,true,false);let connections=0;
 try{
  const raw=delta(f.reader.source.original),r=reader(raw),p=planDeltaPrinter(r,policy),configured={hardware:{...f.hardwareOptions,motion:p.motion},motion:p.initial,delta:p.delta,print:{output(){},motorCompletion:'hold' as const,startupHoming:{mode:'home' as const,axes:[0,1,2] as (0|1|2)[]},parking:{parkXY:[0,0] as const,retract:0,lift:0,travelSpeed:10,liftSpeed:5,retractSpeed:5},lifecycle:{prepare:async()=>{},start:async()=>{},finishOutputs:async()=>{},stopOutputs:async()=>{}},open:async()=>{throw new Error('Unexpected file');}}};
  const links=f.connections.map(c=>({...c,connect:async(...args:Parameters<typeof c.connect>)=>{connections++;return c.connect(...args);}}));
  for(const section of ['probe','gcode_macro START','endstop_phase stepper_a']){
   const invalid=reader({...raw,[section]:{}});assert.throws(()=>planDeltaPrinter(invalid,policy),/unsupported/);
   await assert.rejects(connectConfiguredDeltaPrinter(invalid,links,'mcu',p.layout,configured,f.signal),/unsupported/);
  }
  assert.equal(connections,0);assert.deepEqual(f.stops,[0,0]);
  await assert.rejects(connectConfiguredDeltaPrinter(r,links,'mcu',p.layout,{...configured,print:{...configured.print,bedHeater:'missing'}},f.signal),/bed heater/);
  assert.equal(connections,2);assert.deepEqual(f.stops,[1,1]);
 }finally{await f.close();}
});

test('Delta native probe descent recovers off-center trigger and halt coordinates',async()=>{
 const {LinearHomingSeek}=await import('../src/homing/linear-seek.ts');
 const {serialClock}=await import('../src/protocol/serial-queue.ts');
 const f=await initialMotionSetup(false,true,true),timers:ReturnType<typeof setTimeout>[]=[];
 let recovered:Awaited<ReturnType<InstanceType<typeof LinearHomingSeek>['run']>>|undefined;
 try{
  const r=reader(delta(f.reader.source.original)),p=planDeltaHardware(r,policy),home=[25,-30,10];
  const hardware=await startConfiguredHardware(r,f.group,f.clocks,p.layout,{...f.hardwareOptions,motion:p.motion},f.signal);
  try{
   p.config.kinematics.resetPosition('xyz');
   const initial=await initializeConfiguredMotion(hardware,{...initialMotionOptions,position:[home[0],home[1],home[2],0]},f.signal),g=initial.generation;
   const groups=compileDeltaHoming(hardware.plan,g,p.homing);
   for(const [index,group] of groups.entries()){
    const member=group.members[group.primary],session=g.members[member.physicalMember].session;
    const fw=f.firmware[session===f.group.session('mcu')?0:1];
    const motor=g.motion.bindings.find(b=>b.id===p.kinematicIds[index])!,hit=motor.stepper.clockAt(g.motion.printTime+.052+index*.008);
    const halt=Number(motor.history.status.lastPlannedPosition)-50-index;
    timers.push(setTimeout(()=>{
     fw.setTriggerReason(1,member.trigger.oid);fw.setStepperPosition(motor.oid,halt);
     const command=fw.outputs.find(m=>m.name==='endstop_home'&&Number(m.parameters.oid)===group.endstop.oid&&Number(m.parameters.sample_count)>0);
     fw.setEndstopState({homing:0,pin_value:0,next_clock:Number(hit)+Number(command?.parameters.rest_ticks??1000)},group.endstop.oid);
     fw.emit('trsync_state',{oid:member.trigger.oid,can_trigger:0,trigger_reason:1,clock:Number(hit)});
    },Math.max(0,Number(hit-session.clock.sync.getClock(serialClock.now()))/1e6+.01)*1000));
   }
   recovered=await new LinearHomingSeek({mode:'probe',generation:g,kinematics:p.config.kinematics,emitters:initial.emitters,kinematicIds:p.kinematicIds,groups}).run([home[0],home[1],0,0],10,2,f.signal);
   assert.deepEqual(recovered.missingHits,[]);assert.equal(recovered.movingSteppers.length,3);
   assert.equal(new Set(recovered.stop.groups.map(g=>String(g.hitClock))).size,3);
   for(const [field,offsetField] of [['position','haltOffset'],['triggerPosition','triggerOffset']] as const){
    const actuators=p.config.kinematics.solverGeometry.map((geometry,index)=>{
     const binding=g.motion.bindings.find(b=>b.id===p.kinematicIds[index])!;
     const offset=recovered!.offsets.find(o=>o.member===index&&o.oid===binding.oid)!;
     return home[2]+Math.sqrt(geometry.armLength**2-(geometry.towerX-home[0])**2-(geometry.towerY-home[1])**2)+Number(offset[offsetField])*.0125;
    });
    const expected=p.config.kinematics.calcPosition([actuators[0],actuators[1],actuators[2]]);
    for(let i=0;i<3;i++)assert(Math.abs(recovered[field][i]-expected[i])<1e-10);
   }
   assert(recovered.triggerPosition[2]<home[2]);assert.equal(recovered.position[3],0);
   assert.equal(recovered.generation.source.status.retired,false);assert.equal(p.config.kinematics.status.homedAxes,'xyz');assert.deepEqual(f.stops,[0,0]);
  }finally{recovered?.motion.dispose();await hardware.close();}
 }finally{for(const timer of timers)clearTimeout(timer);await f.close();}
});

for(const reverse of [false,true])for(const missingHit of [false,true])test(`Delta single probe owns every tower across MCU ordering (reverse=${reverse}, missingHit=${missingHit})`,async()=>{
 const {LinearHomingSeek}=await import('../src/homing/linear-seek.ts'),{serialClock}=await import('../src/protocol/serial-queue.ts');
 const f=await initialMotionSetup(reverse,true,true);let result:Awaited<ReturnType<InstanceType<typeof LinearHomingSeek>['run']>>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const raw=delta(f.reader.source.original);raw.probe={pin:'^aux:PA13',z_offset:'0'};
  const r=reader(raw),p=planDeltaHardware(r,policy);assert.deepEqual(p.probe,[{section:'probe',emitters:['a','b','c','e']}]);assert.deepEqual(p.homing.map(g=>g.section),['stepper_a','stepper_b','stepper_c']);
  const hardware=await startConfiguredHardware(r,f.group,f.clocks,p.layout,{...f.hardwareOptions,motion:p.motion},f.signal);
  try{
   const initial=await initializeConfiguredMotion(hardware,{...initialMotionOptions,position:[25,-30,10,0]},f.signal),g=initial.generation,groups=compileDeltaHoming(hardware.plan,g,p.probe!);
   assert.equal(groups.length,1);assert.equal(groups[0].members.length,2);assert.deepEqual(groups[0].members.flatMap(m=>m.emitters).sort(),['a','b','c','e']);
   p.config.kinematics.resetPosition('xyz');const group=groups[0],primary=group.members[group.primary],session=g.members[primary.physicalMember].session,fw=f.firmware[1],binding=g.motion.bindings.find(b=>b.id==='b')!,hit=binding.stepper.clockAt(g.motion.printTime+.052);
   assert.equal(session,f.group.session('aux'));
   if(missingHit){
    for(const member of group.members)f.firmware[g.members[member.physicalMember].session===f.group.session('mcu')?0:1].setTriggerReason(3,member.trigger.oid);
    await assert.rejects(new LinearHomingSeek({mode:'probe',generation:g,kinematics:p.config.kinematics,emitters:initial.emitters,kinematicIds:p.kinematicIds,groups}).run([25,-30,9,0],10,2,f.signal),/Probe did not trigger/);assert.deepEqual(f.stops,[1,1]);return;
   }
   timer=setTimeout(()=>{
    for(const member of group.members){const device=f.firmware[g.members[member.physicalMember].session===f.group.session('mcu')?0:1];device.setTriggerReason(member===primary?1:2,member.trigger.oid);for(const id of member.emitters){const b=g.motion.bindings.find(b=>b.id===id)!;device.setStepperPosition(b.oid,Number(b.history.status.lastPlannedPosition)-(id==='e'?0:48));}}
    const command=fw.outputs.find(o=>o.name==='endstop_home'&&Number(o.parameters.sample_count)>0&&o.parameters.oid===group.endstop.oid);assert(command);
    fw.setEndstopState({homing:0,pin_value:0,next_clock:Number(hit)+Number(command.parameters.rest_ticks)},group.endstop.oid);fw.emit('trsync_state',{oid:primary.trigger.oid,can_trigger:0,trigger_reason:1,clock:Number(hit)});
   },Math.max(0,Number(hit-session.clock.sync.getClock(serialClock.now()))/1e6+.01)*1000);
   result=await new LinearHomingSeek({mode:'probe',generation:g,kinematics:p.config.kinematics,emitters:initial.emitters,kinematicIds:p.kinematicIds,groups}).run([25,-30,0,0],10,2,f.signal);
   assert.deepEqual(result.missingHits,[]);assert.equal(result.movingSteppers.length,3);assert.equal(result.stop.groups.length,1);assert.equal(result.offsets.length,4);assert.equal(result.position[3],0);assert(result.triggerPosition[2]<10);
   assert.equal(f.firmware.flatMap(fw=>fw.outputs).filter(o=>o.name==='endstop_home'&&Number(o.parameters.sample_count)>0).length,1);
   assert.deepEqual(result.generation.motion.bindings.map(b=>[b.id,b.member]).sort(),g.motion.bindings.map(b=>[b.id,b.member]).sort());assert.deepEqual(f.stops,[0,0]);
  }finally{clearTimeout(timer);result?.motion.dispose();await hardware.close();}
 }finally{await f.close();}
});

for(const missing of [false,true])test(`Delta initial owner binds mechanical probe and rejects incomplete or unhomed use (missing=${missing})`,async()=>{
 const f=await initialMotionSetup(false,true,true);
 try{
  const raw=delta(f.reader.source.original);raw.probe={pin:'^aux:PA13',z_offset:'.2'};const r=reader(raw),p=planDeltaHardware(r,policy);
  const hardware=await startConfiguredHardware(r,f.group,f.clocks,p.layout,{...f.hardwareOptions,motion:p.motion},f.signal);
  try{
   const initial=await initializeConfiguredMotion(hardware,initialMotionOptions,f.signal);
   if(missing)assert.throws(()=>initial.createDeltaPort(r,{homing:p.homing,kinematicIds:p.kinematicIds}),/configuration and stop groups differ/);
   else{const port=initial.createDeltaPort(r,p);await assert.rejects(port.port.probeConfiguredZ(0,5,f.signal),/all axes homed/);assert.equal(port.kinematics.status.homedAxes,'');}
   assert(f.firmware.every(fw=>fw.motion.length===0));assert(f.firmware.every(fw=>!fw.outputs.some(o=>o.name==='endstop_home'&&Number(o.parameters.sample_count)>0)));
  }finally{await hardware.close();}
 }finally{await f.close();}
});
