import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
import {Thermistor} from '../src/thermal/thermistor.ts';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startConfiguredDeltaProductService} from '../src/runtime/product-service.ts';
import {productTransports} from './helpers/product-transports.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {inspect} from 'node:util';
import {initialMotionSetup,initialMotionOptions} from './helpers/initial-motion.ts';
import {deltaPrinterSections} from './helpers/delta-printer.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {planDeltaHardware} from '../src/config/delta-printer.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {initializeConfiguredMotion} from '../src/runtime/initial-motion.ts';
const benchmark=!!process.env.DELTA_PROBE_BENCH;
for(const calibration of (benchmark?[false]:[false,true]))for(let run=0;run<(benchmark?4:1);run++)test(`Delta mechanical probe completes two off-center samples with a vertical retract (run=${run}, calibration=${calibration})`,async t=>{
 const f=await initialMotionSetup(false,true,true),timers=new Set<ReturnType<typeof setTimeout>>(),detach:(()=>void)[]=[];let hits=0;
 try{
  const raw=deltaPrinterSections(f.reader.source.original);raw.probe={pin:'^aux:PA13',z_offset:'.123456789',x_offset:'-2',y_offset:'3',samples:'2',sample_retract_dist:'.2',samples_tolerance:'10'};
  const reader=new ConfigurationReader(new ConfigurationSource('/delta.cfg',raw,[]),null),plan=planDeltaHardware(reader,{mcus:['mcu','aux'],enableLeadTime:.001,fanMinimumScheduleTime:.001});
  const hw=await startConfiguredHardware(reader,f.group,f.clocks,plan.layout,{...f.hardwareOptions,motion:plan.motion},f.signal);
  const converter=new Thermistor(4700,0,{points:[[25,100000],[150,1770],[250,230]]});
  const thermal=setInterval(()=>{if(!calibration)return;for(const fw of f.firmware)for(const entry of fw.outputs.filter(o=>o.name==='query_analog_in'&&Number(o.parameters.rest_ticks)>0)){
   const p=entry.parameters,raw=Math.round(converter.adc(25)*4095*Number(p.sample_count)),next=fw.currentClock()+Number(p.rest_ticks)-Number(p.sample_ticks)*Number(p.sample_count);
   fw.emit('analog_in_state',{oid:Number(p.oid),next_clock:next>>>0,values:Buffer.from([raw&255,raw>>8])});
  }},100);
  try{
   const initial=await initializeConfiguredMotion(hw,{...initialMotionOptions,position:[25,-30,10,0]},f.signal),owner=initial.createDeltaPort(reader,plan),probe=hw.plan.homing.find(h=>h.section==='probe')!;
   const counts=new Map<string,number>();
   for(const [index,fw] of f.firmware.entries()){
    const directions=new Map<number,number>();
    detach.push(fw.observeCommands(command=>{
      const p=command.parameters,oid=Number(p.oid),key=index+':'+oid;
      if(command.name==='set_next_step_dir')directions.set(oid,Number(p.dir)?1:-1);
      if(command.name==='queue_step'){const count=(counts.get(key)??0)+(directions.get(oid)??1)*Number(p.count);counts.set(key,count);fw.setStepperPosition(oid,count);}
      if(command.name==='trsync_start'&&p.report_ticks===0)fw.setTriggerReason(2,oid);
      if(command.name==='endstop_home'&&Number(p.sample_count)>0&&index===1&&oid===probe.endstop.oid){
       const atArm=new Map(counts),hit=Number(p.clock)+50000,timer=setTimeout(()=>{timers.delete(timer);hits++;
        for(const binding of initial.generation.motion.bindings){if(binding.id==='e')continue;const i=f.group.session('mcu')===initial.generation.members[binding.member].session?0:1,count=calibration?(atArm.get(i+':'+binding.oid)??0)-20:-20*hits+16*(hits-1);counts.set(i+':'+binding.oid,count);f.firmware[i].setStepperPosition(binding.oid,count);}
        fw.setTriggerReason(1,Number(p.trsync_oid));fw.setEndstopState({homing:0,pin_value:0,next_clock:hit+Number(p.rest_ticks)},oid);fw.emit('trsync_state',{oid:Number(p.trsync_oid),can_trigger:0,trigger_reason:1,clock:hit});
       },Math.max(0,(hit-fw.currentClock())/1000+10));timers.add(timer);
      }
    }));
   }
   if(calibration){
    owner.kinematics.resetPosition('xyz');const started=performance.now();
    const positions:[[number,number],[number,number],[number,number],[number,number],[number,number],[number,number]]=[[0,0],[2,0],[1,2],[-2,0],[-1,-2],[0,2]];
    const result=await owner.port.measureDeltaCalibration({points:positions,horizontalHeight:10,travelSpeed:50},0,f.signal);
    result.forEach((p,i)=>{const xyz=owner.kinematics.positionFromStable(p.stable);assert(Math.abs(xyz[0]-positions[i][0])<.05);assert(Math.abs(xyz[1]-positions[i][1])<.05);});
    assert.equal(result.length,6);assert.equal(hits,12);assert(result.every(p=>p.height===.123456789&&p.stable.every(Number.isFinite)));
    assert.equal(owner.port.status.failed,false);assert.equal(owner.port.homingPosition()[3],0);assert.equal(owner.kinematics.status.homedAxes,'xyz');assert.deepEqual(f.stops,[0,0]);
    t.diagnostic('DeltaCalibrationProbe '+JSON.stringify({wallMs:performance.now()-started,points:result.length,hits}));
   }else{
   owner.kinematics.resetPosition('xyz');const started=performance.now();const pending=owner.port.measureProbe(0,f.signal);assert.throws(()=>owner.port.move([25,-30,11,0],5),/busy/);
   const result=await pending;t.diagnostic('DeltaProbeBenchmark '+JSON.stringify({run,api:false,wallMs:performance.now()-started}));assert.equal(hits,2);assert.equal(result.attempts,2);assert.equal(result.samples.length,2);assert.equal(result.retries,0);assert.equal(owner.port.status.failed,false);assert.equal(owner.kinematics.status.homedAxes,'xyz');
   assert.deepEqual(result.bedPosition,[result.position[0]-2,result.position[1]+3,result.position[2]-.123456789]);assert.equal(result.position[3],0);assert(Math.abs(owner.port.homingPosition()[0]-25)<1e-10);assert(Math.abs(owner.port.homingPosition()[1]+30)<1e-10);assert.deepEqual(f.stops,[0,0]);
   }
  }finally{clearInterval(thermal);for(const timer of timers)clearTimeout(timer);for(const off of detach)off();await hw.close();}
 }finally{await f.close();}
});

for(let run=0;run<(benchmark?4:1);run++)test(`Delta automatic product service exposes tokenized two-sample probing (run=${run})`,async t=>{
 const f=await initialMotionSetup(false,true,true,false),timers=new Set<ReturnType<typeof setTimeout>>(),detach:(()=>void)[]=[];let hits=0,calibrating=false;
 const wireTrace:{sample:number;armClock:number;actualArmClocks:number[];counts:[string,number][];triggerClock?:number;actualTriggerClocks?:number[];positions:{member:number;oid:number;position:number;clock:number}[]}[]=[];
 try{
  const raw=deltaPrinterSections(f.reader.source.original);raw.probe={pin:'^aux:PA13',z_offset:'.123456789',x_offset:'-2',y_offset:'3',samples:'2',sample_retract_dist:'.2',samples_tolerance:'10'};
  raw.delta_calibrate={radius:'2',horizontal_move_z:'10'};
  const reader=new ConfigurationReader(new ConfigurationSource('/delta.cfg',raw,[]),null),plan=planDeltaHardware(reader,{mcus:['mcu','aux'],enableLeadTime:.001,fanMinimumScheduleTime:.001});
  const transport=await productTransports(reader),dir=await mkdtemp(join(tmpdir(),'delta-probe-api-')),journal=await PrintJournal.open({path:dir+'/jobs.db',deviceId:'probe'});await writeFile(dir+'/moonraker.conf','[server]\nhost=127.0.0.1\nport=0');
  const configurationPath=dir+'/printer.cfg';await writeFile(configurationPath,Object.entries(transport.reader.source.original).map(([section,options])=>'['+section+']\n'+Object.entries(options).map(([key,value])=>key+': '+value.replaceAll('\n','\n  ')).join('\n')).join('\n')+'\n');
  const {session:configurationSession}=await KlipperSaveSession.load(configurationPath);
  const service=await startConfiguredDeltaProductService(transport.reader,transport.policies,{journal,configurationSession,maintenanceGate:new MaintenanceGate(),limits:{maxNozzle:300,maxBed:130}},{configPath:dir+'/moonraker.conf',machine:{enableLeadTime:.001,fanMinimumScheduleTime:.001},print:{output(){},motorCompletion:'hold',startupHoming:{mode:'home',axes:[0,1,2]},parking:{parkXY:[0,0],retract:0,lift:0,travelSpeed:10,liftSpeed:5,retractSpeed:5},lifecycle:{async prepare(){},async start(){},async finishOutputs(){},async stopOutputs(){}},async open(){throw Error('Unexpected print');}},server:{information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize:()=>{}}},f.signal);
  const hw=service.printer.hardware,live={firmware:transport.firmware,group:service.printer.group,stops:transport.stops};
  const converter=new Thermistor(4700,0,{points:[[25,100000],[150,1770],[250,230]]});
  const thermal=setInterval(()=>{for(const fw of live.firmware)for(const entry of fw.outputs.filter(o=>o.name==='query_analog_in'&&Number(o.parameters.rest_ticks)>0)){
   const p=entry.parameters,raw=Math.round(converter.adc(25)*4095*Number(p.sample_count)),next=fw.currentClock()+Number(p.rest_ticks)-Number(p.sample_ticks)*Number(p.sample_count);
   fw.emit('analog_in_state',{oid:Number(p.oid),next_clock:next>>>0,values:Buffer.from([raw&255,raw>>8])});
  }},100);
  try{
   const initial=service.printer.initial,owner=service.printer.delta,probe=hw.plan.homing.find(h=>h.section==='probe')!;
   const counts=new Map<string,number>();
   for(const [index,fw] of live.firmware.entries()){
    const directions=new Map<number,number>();
    detach.push(fw.observeCommands(command=>{
      const p=command.parameters,oid=Number(p.oid),key=index+':'+oid;
      const latest=wireTrace.at(-1);
      if(command.name==='stepper_get_position'&&latest?.actualTriggerClocks&&latest.positions.length<16)latest.positions.push({member:index,oid,position:counts.get(key)??0,clock:fw.currentClock()});
      if(command.name==='set_next_step_dir')directions.set(oid,Number(p.dir)?1:-1);
      if(command.name==='queue_step'){const count=(counts.get(key)??0)+(directions.get(oid)??1)*Number(p.count);counts.set(key,count);fw.setStepperPosition(oid,count);}
      if(command.name==='trsync_start'&&p.report_ticks===0)fw.setTriggerReason(2,oid);
      if(command.name==='endstop_home'&&Number(p.sample_count)>0&&index===1&&oid===probe.endstop.oid){
       const trace={sample:hits,armClock:Number(p.clock),actualArmClocks:live.firmware.map(f=>f.currentClock()),counts:[...counts.entries()],positions:[]} as typeof wireTrace[number];
       // Bound diagnostic retention; no history replay or remote diagnostic API.
       if(wireTrace.length===32)wireTrace.shift();wireTrace.push(trace);
       const atArm=new Map(counts),hit=Number(p.clock)+50000,timer=setTimeout(()=>{timers.delete(timer);hits++;trace.triggerClock=hit;trace.actualTriggerClocks=live.firmware.map(f=>f.currentClock());
        for(const binding of initial.generation.motion.bindings){if(binding.id==='e')continue;const i=live.group.session('mcu')===initial.generation.members[binding.member].session?0:1,count=calibrating?(atArm.get(i+':'+binding.oid)??0)-20:-20*hits+16*(hits-1);counts.set(i+':'+binding.oid,count);live.firmware[i].setStepperPosition(binding.oid,count);}
        fw.setTriggerReason(1,Number(p.trsync_oid));fw.setEndstopState({homing:0,pin_value:0,next_clock:hit+Number(p.rest_ticks)},oid);fw.emit('trsync_state',{oid:Number(p.trsync_oid),can_trigger:0,trigger_reason:1,clock:hit});
       },Math.max(0,(hit-fw.currentClock())/1000+10));timers.add(timer);
      }
    }));
   }
   const url='http://127.0.0.1:'+service.address.port+'/printer/calibration/probe';
   const calibrationBefore=await (await fetch('http://127.0.0.1:'+service.address.port+'/printer/calibration/delta')).json() as any;assert.equal(calibrationBefore.result.available,false);
   const before=await (await fetch(url)).json() as any;assert.equal(before.result.available,false);
   await owner.port.forcePosition([25,-30,10,0],f.signal);owner.kinematics.resetPosition('xyz');
   const calibrationReady=await (await fetch('http://127.0.0.1:'+service.address.port+'/printer/calibration/delta')).json() as any;assert.equal(calibrationReady.result.available,true);
   const state=await (await fetch(url)).json() as any;assert.equal(state.result.available,true);
   const started=performance.now();const body=JSON.stringify({version:1,state_token:state.result.state_token}),reply=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body});
   if(reply.status!==200)t.diagnostic(inspect({motionFault:owner.port.status.fault,hardwareFault:hw.status.fault,hits},{depth:5}));
   assert.equal(reply.status,200,await reply.clone().text());
   t.diagnostic('DeltaProbeBenchmark '+JSON.stringify({run,api:true,wallMs:performance.now()-started}));
   const receipt=(await reply.json() as any).result,result={...receipt.result,bedPosition:receipt.result.bed_position};
   const replay=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body});assert.equal(replay.status,200);assert.deepEqual((await replay.json() as any).result,receipt);assert.equal(hits,2);assert.equal(result.attempts,2);assert.equal(result.samples.length,2);assert.equal(result.retries,0);assert.equal(owner.port.status.failed,false);assert.equal(owner.kinematics.status.homedAxes,'xyz');
   assert.deepEqual(result.bedPosition,[result.position[0]-2,result.position[1]+3,result.position[2]-.123456789]);assert.equal(result.position[3],0);assert(Math.abs(owner.port.homingPosition()[0]-25)<1e-10);assert(Math.abs(owner.port.homingPosition()[1]+30)<1e-10);assert.deepEqual(live.stops,[0,0]);
   if(!benchmark){
    calibrating=true;const calibrationUrl='http://127.0.0.1:'+service.address.port+'/printer/calibration/delta',state=await (await fetch(calibrationUrl)).json() as any;
    const body=JSON.stringify({version:1,state_token:state.result.state_token,action:'calibrate'}),started=performance.now();
    const response=await fetch(calibrationUrl,{method:'POST',headers:{'content-type':'application/json'},body});
    if(response.status!==200)t.diagnostic(inspect({motionFault:owner.port.status.fault,hardwareFault:hw.status.fault,hits,calibration:service.calibrationDiagnostic(),acceptedWireTrace:wireTrace},{depth:8,maxArrayLength:1000}));
    assert.equal(response.status,200,await response.clone().text());
    const result=(await response.json() as any).result;assert.equal(result.state,'candidate');assert.equal(hits,16);assert(Number.isFinite(result.candidate.final_error));assert(result.candidate.final_error<result.candidate.initial_error);
    assert.equal(wireTrace.length,16);assert(wireTrace.every((sample,i)=>sample.sample===i&&sample.actualTriggerClocks?.length===2&&sample.positions.length>=3&&sample.positions.length<=16));
    t.diagnostic('DeltaCalibrationInput '+JSON.stringify(service.calibrationDiagnostic()?.input));
    const replay=await fetch(calibrationUrl,{method:'POST',headers:{'content-type':'application/json'},body});assert.deepEqual((await replay.json() as any).result,result);assert.equal(hits,16);
    const activeGeometry=owner.kinematics.calibrationGeometry,saveBody=JSON.stringify({version:1,state_token:result.state_token,action:'save'});
    const saveObservation=()=>({motion:owner.port.status,homed:owner.kinematics.status.homedAxes,state:service.printer.controller.state,pending:service.printer.controller.pendingDeviceActions,stopping:service.printer.controller.safeStopPending});
    // Clock maintenance shares dispatch ownership. Join it and retain that
    // owner across admission and HTTP completion; never retry a rejected save.
    await service.printer.print.gcode.dispatch.runExclusive(async signal=>{
     signal.throwIfAborted();const available=(await (await fetch(calibrationUrl)).json() as any).result;
     assert.equal(available.available,true);assert.equal(available.state_token,result.state_token);
     const beforeSave=saveObservation();assert.equal(beforeSave.motion.busy,false);
     const saved=await fetch(calibrationUrl,{method:'POST',headers:{'content-type':'application/json'},body:saveBody});
     if(saved.status!==200)t.diagnostic(inspect({beforeSave,afterSave:saveObservation(),calibration:service.calibrationDiagnostic()},{depth:5,maxArrayLength:32}));
     assert.equal(saved.status,200,await saved.clone().text());
    },f.signal);
    assert(configurationSession.status.sealedForRestart);assert(service.printer.maintenanceGate.status.closed);assert.deepEqual(owner.kinematics.calibrationGeometry,activeGeometry);
    const restored=await KlipperSaveSession.load(configurationPath);assert.equal(Number(restored.source.original.printer.delta_radius),result.candidate.geometry.radius);
    assert.equal(Object.keys(restored.source.original.delta_calibrate).filter(k=>/^height[0-9]+$/.test(k)).length,7);
    t.diagnostic('DeltaCalibrationApi '+JSON.stringify({wallMs:performance.now()-started,finalError:result.candidate.final_error,hits}));
   }
  }finally{clearInterval(thermal);for(const timer of timers)clearTimeout(timer);for(const off of detach)off();await service.close();await journal.close();await transport.close();await rm(dir,{recursive:true,force:true});}
 }finally{await f.close();}
});
