import assert from 'node:assert/strict';
import {nativeLinearFixture} from '../test/helpers/native-linear-port.ts';
import {PrintController} from '../src/operations/print.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
const t=await nativeLinearFixture(0,()=>true,true),times:number[]=[],count=1000,gate=new MaintenanceGate();
const controller=new PrintController({async prepare(){},async start(){},pause:s=>t.port.pause(s).then(()=>{}),async resume(){throw new Error('Unexpected resume');},async finish(){},stop:()=>t.port.motorOff(new Error('Benchmark cleanup'))},{maxNozzle:300,maxBed:120},{},{maintenanceGate:gate});
try{
 await controller.start({version:1,requestId:'benchmark',fileId:'file',nozzle:0,bed:0});await controller.pause();
 await controller.adjustPaused(s=>t.port.setPressureAdvance('e',{advance:.1,smoothTime:.2},s));
 const time=t.generation.source.status.sourceTime,generated=t.generation.coordinator.status.generatedTime,packets=t.f.fw.motion.length;
 for(let sample=0;sample<14;sample++){
  const start=performance.now();for(let i=0;i<count;i++)await controller.adjustPaused(s=>t.port.setPressureAdvance('e',{advance:i%3?.2:0,smoothTime:i%2?.02:.2},s));
  if(sample>=3)times.push((performance.now()-start)*1000/count);
  assert.equal(controller.state,'paused');assert.equal(controller.pendingDeviceActions,0);assert.equal(gate.status.activities,0);
  assert.equal(t.generation.source.status.sourceTime,time);assert.equal(t.generation.coordinator.status.generatedTime,generated);assert.equal(t.f.fw.motion.length,packets);
 }
 times.sort((a,b)=>a-b);assert(times[5]!<150);assert(times[10]!<300);assert.equal(t.f.stops,0);
 console.log(JSON.stringify({node:process.version,samples:11,iterationsPerSample:count,medianUs:times[5],p95Us:times[10],maximumMedianUs:150,maximumP95Us:300,noNativePackets:true,scope:'controller token transitions, maintenance ownership, deadline and native paused pressure transaction; simulated MCU; network and initial reservation excluded'},null,2));
}finally{await controller.retire();await t.close();}
