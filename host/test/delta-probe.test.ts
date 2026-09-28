import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {startConfiguredDeltaProductService} from '../src/runtime/product-service.ts';
import {productTransports} from './helpers/product-transports.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {FrameDecoder} from '../src/protocol/codec.ts';
import {initialMotionSetup,initialMotionOptions} from './helpers/initial-motion.ts';
import {deltaPrinterSections} from './helpers/delta-printer.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {planDeltaHardware} from '../src/config/delta-printer.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {initializeConfiguredMotion} from '../src/runtime/initial-motion.ts';
const benchmark=!!process.env.DELTA_PROBE_BENCH;
for(let run=0;run<(benchmark?4:1);run++)test(`Delta mechanical probe completes two off-center samples with a vertical retract (run=${run})`,async t=>{
 const f=await initialMotionSetup(false,true,true),timers=new Set<ReturnType<typeof setTimeout>>(),detach:(()=>void)[]=[];let hits=0;
 try{
  const raw=deltaPrinterSections(f.reader.source.original);raw.probe={pin:'^aux:PA13',z_offset:'.123456789',x_offset:'-2',y_offset:'3',samples:'2',sample_retract_dist:'.2',samples_tolerance:'10'};
  const reader=new ConfigurationReader(new ConfigurationSource('/delta.cfg',raw,[]),null),plan=planDeltaHardware(reader,{mcus:['mcu','aux'],enableLeadTime:.001,fanMinimumScheduleTime:.001});
  const hw=await startConfiguredHardware(reader,f.group,f.clocks,plan.layout,{...f.hardwareOptions,motion:plan.motion},f.signal);
  try{
   const initial=await initializeConfiguredMotion(hw,{...initialMotionOptions,position:[25,-30,10,0]},f.signal),owner=initial.createDeltaPort(reader,plan),probe=hw.plan.homing.find(h=>h.section==='probe')!;
   const counts=new Map<string,number>();
   for(const [index,fw] of f.firmware.entries()){
    const decoder=new FrameDecoder(),directions=new Map<number,number>();let sequence=1;
    const data=(chunk:Buffer|string)=>{for(const frame of decoder.push(typeof chunk==='string'?Buffer.from(chunk):chunk)){
     if((frame[1]&15)!==sequence)continue;sequence=(sequence+1)&15;
     for(const command of fw.dictionary.parseFrame(frame)){
      const p=command.parameters,oid=Number(p.oid),key=index+':'+oid;
      if(command.name==='set_next_step_dir')directions.set(oid,Number(p.dir)?1:-1);
      if(command.name==='queue_step'){const count=(counts.get(key)??0)+(directions.get(oid)??1)*Number(p.count);counts.set(key,count);fw.setStepperPosition(oid,count);}
      if(command.name==='trsync_start'&&p.report_ticks===0)fw.setTriggerReason(2,oid);
      if(command.name==='endstop_home'&&Number(p.sample_count)>0&&index===1&&oid===probe.endstop.oid){
       const hit=Number(p.clock)+50000,timer=setTimeout(()=>{timers.delete(timer);hits++;
        for(const binding of initial.generation.motion.bindings){if(binding.id==='e')continue;const i=f.group.session('mcu')===initial.generation.members[binding.member].session?0:1,count=-20*hits+16*(hits-1);counts.set(i+':'+binding.oid,count);f.firmware[i].setStepperPosition(binding.oid,count);}
        fw.setTriggerReason(1,Number(p.trsync_oid));fw.setEndstopState({homing:0,pin_value:0,next_clock:hit+Number(p.rest_ticks)},oid);fw.emit('trsync_state',{oid:Number(p.trsync_oid),can_trigger:0,trigger_reason:1,clock:hit});
       },Math.max(0,(hit-fw.currentClock())/1000+10));timers.add(timer);
      }
     }
    }};fw.peer.on('data',data);detach.push(()=>{if('off' in fw.peer&&typeof fw.peer.off==='function')fw.peer.off('data',data);});
   }
   owner.kinematics.resetPosition('xyz');const started=performance.now();const pending=owner.port.measureProbe(0,f.signal);assert.throws(()=>owner.port.move([25,-30,11,0],5),/busy/);
   const result=await pending;t.diagnostic('DeltaProbeBenchmark '+JSON.stringify({run,api:false,wallMs:performance.now()-started}));assert.equal(hits,2);assert.equal(result.attempts,2);assert.equal(result.samples.length,2);assert.equal(result.retries,0);assert.equal(owner.port.status.failed,false);assert.equal(owner.kinematics.status.homedAxes,'xyz');
   assert.deepEqual(result.bedPosition,[result.position[0]-2,result.position[1]+3,result.position[2]-.123456789]);assert.equal(result.position[3],0);assert(Math.abs(owner.port.homingPosition()[0]-25)<1e-10);assert(Math.abs(owner.port.homingPosition()[1]+30)<1e-10);assert.deepEqual(f.stops,[0,0]);
  }finally{for(const timer of timers)clearTimeout(timer);for(const off of detach)off();await hw.close();}
 }finally{await f.close();}
});

for(let run=0;run<(benchmark?4:1);run++)test(`Delta automatic product service exposes tokenized two-sample probing (run=${run})`,async t=>{
 const f=await initialMotionSetup(false,true,true,false),timers=new Set<ReturnType<typeof setTimeout>>(),detach:(()=>void)[]=[];let hits=0;
 try{
  const raw=deltaPrinterSections(f.reader.source.original);raw.probe={pin:'^aux:PA13',z_offset:'.123456789',x_offset:'-2',y_offset:'3',samples:'2',sample_retract_dist:'.2',samples_tolerance:'10'};
  const reader=new ConfigurationReader(new ConfigurationSource('/delta.cfg',raw,[]),null),plan=planDeltaHardware(reader,{mcus:['mcu','aux'],enableLeadTime:.001,fanMinimumScheduleTime:.001});
  const transport=await productTransports(reader),dir=await mkdtemp('/tmp/delta-probe-api-'),journal=await PrintJournal.open({path:dir+'/jobs.db',deviceId:'probe'});await writeFile(dir+'/moonraker.conf','[server]\nhost=127.0.0.1\nport=0');
  const service=await startConfiguredDeltaProductService(transport.reader,transport.policies,{journal,maintenanceGate:new MaintenanceGate(),limits:{maxNozzle:300,maxBed:130}},{configPath:dir+'/moonraker.conf',machine:{enableLeadTime:.001,fanMinimumScheduleTime:.001},print:{output(){},motorCompletion:'hold',startupHoming:{mode:'home',axes:[0,1,2]},parking:{parkXY:[0,0],retract:0,lift:0,travelSpeed:10,liftSpeed:5,retractSpeed:5},lifecycle:{async prepare(){},async start(){},async finishOutputs(){},async stopOutputs(){}},async open(){throw Error('Unexpected print');}},server:{information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize:()=>{}}},f.signal);
  const hw=service.printer.hardware,live={firmware:transport.firmware,group:service.printer.group,stops:transport.stops};
  try{
   const initial=service.printer.initial,owner=service.printer.delta,probe=hw.plan.homing.find(h=>h.section==='probe')!;
   const counts=new Map<string,number>();
   for(const [index,fw] of live.firmware.entries()){
    const decoder=new FrameDecoder(),directions=new Map<number,number>();let sequence=1;
    const data=(chunk:Buffer|string)=>{for(const frame of decoder.push(typeof chunk==='string'?Buffer.from(chunk):chunk)){
     if((frame[1]&15)!==sequence)continue;sequence=(sequence+1)&15;
     for(const command of fw.dictionary.parseFrame(frame)){
      const p=command.parameters,oid=Number(p.oid),key=index+':'+oid;
      if(command.name==='set_next_step_dir')directions.set(oid,Number(p.dir)?1:-1);
      if(command.name==='queue_step'){const count=(counts.get(key)??0)+(directions.get(oid)??1)*Number(p.count);counts.set(key,count);fw.setStepperPosition(oid,count);}
      if(command.name==='trsync_start'&&p.report_ticks===0)fw.setTriggerReason(2,oid);
      if(command.name==='endstop_home'&&Number(p.sample_count)>0&&index===1&&oid===probe.endstop.oid){
       const hit=Number(p.clock)+50000,timer=setTimeout(()=>{timers.delete(timer);hits++;
        for(const binding of initial.generation.motion.bindings){if(binding.id==='e')continue;const i=live.group.session('mcu')===initial.generation.members[binding.member].session?0:1,count=-20*hits+16*(hits-1);counts.set(i+':'+binding.oid,count);live.firmware[i].setStepperPosition(binding.oid,count);}
        fw.setTriggerReason(1,Number(p.trsync_oid));fw.setEndstopState({homing:0,pin_value:0,next_clock:hit+Number(p.rest_ticks)},oid);fw.emit('trsync_state',{oid:Number(p.trsync_oid),can_trigger:0,trigger_reason:1,clock:hit});
       },Math.max(0,(hit-fw.currentClock())/1000+10));timers.add(timer);
      }
     }
    }};fw.peer.on('data',data);detach.push(()=>{if('off' in fw.peer&&typeof fw.peer.off==='function')fw.peer.off('data',data);});
   }
   const url='http://127.0.0.1:'+service.address.port+'/printer/calibration/probe';
   const before=await (await fetch(url)).json() as any;assert.equal(before.result.available,false);
   await owner.port.forcePosition([25,-30,10,0],f.signal);owner.kinematics.resetPosition('xyz');
   const state=await (await fetch(url)).json() as any;assert.equal(state.result.available,true);
   const started=performance.now();const body=JSON.stringify({version:1,state_token:state.result.state_token}),reply=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body});assert.equal(reply.status,200,await reply.clone().text());
   t.diagnostic('DeltaProbeBenchmark '+JSON.stringify({run,api:true,wallMs:performance.now()-started}));
   const receipt=(await reply.json() as any).result,result={...receipt.result,bedPosition:receipt.result.bed_position};
   const replay=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body});assert.equal(replay.status,200);assert.deepEqual((await replay.json() as any).result,receipt);assert.equal(hits,2);assert.equal(result.attempts,2);assert.equal(result.samples.length,2);assert.equal(result.retries,0);assert.equal(owner.port.status.failed,false);assert.equal(owner.kinematics.status.homedAxes,'xyz');
   assert.deepEqual(result.bedPosition,[result.position[0]-2,result.position[1]+3,result.position[2]-.123456789]);assert.equal(result.position[3],0);assert(Math.abs(owner.port.homingPosition()[0]-25)<1e-10);assert(Math.abs(owner.port.homingPosition()[1]+30)<1e-10);assert.deepEqual(live.stops,[0,0]);
  }finally{for(const timer of timers)clearTimeout(timer);for(const off of detach)off();await service.close();await journal.close();await transport.close();await rm(dir,{recursive:true,force:true});}
 }finally{await f.close();}
});
