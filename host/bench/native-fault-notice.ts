import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {nativeLinearFixture} from '../test/helpers/native-linear-port.ts';
import {bindNativeFileMotion} from '../src/operations/native-file-motion.ts';
import {FilePrintDevice} from '../src/operations/file-print-device.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
const elapsed:number[]=[],cpu:number[]=[];
for(let i=0;i<14;i++){
 const t=await nativeLinearFixture();let notice=NaN,outputs=NaN,outputStops=0;
 const motion=bindNativeFileMotion(t.port,{parkXY:[50,0],retract:0,lift:0,travelSpeed:10,liftSpeed:5,retractSpeed:5},{prepare:async()=>{},start:async()=>{},finishOutputs:async()=>{},stopOutputs:async()=>{outputStops++;outputs=performance.now();}});
 const device=new FilePrintDevice(motion,new GCodeDispatch({output(){},shutdown:reason=>{void t.port.motorOff(new Error(reason));}}),async()=>{throw new Error('benchmark must not open files');});device.subscribeFault(()=>{notice=performance.now();});
 try{
  t.kinematics.markHomed([0,1,2]);const cause=new Error('injected idle MCU fault'),used=process.cpuUsage(),start=performance.now(),stopping=t.generation.group.stop(cause),usage=process.cpuUsage(used);
  assert(Number.isFinite(notice)&&outputs>=start&&outputs<=notice);assert.equal(device.status.fault,cause);assert.equal(t.port.status.failed,true);assert.equal(t.kinematics.status.homedAxes,'');
  await stopping;await device.stop();assert.equal(outputStops,1);assert.equal(t.f.stops,1);
  if(i>=3){elapsed.push(notice-start);cpu.push((usage.user+usage.system)/1000);}
 }finally{await device.stop();await t.close();}
}
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[5],p95Ms:values[10]};};
console.log(JSON.stringify({node:process.version,samples:11,notification:stats(elapsed),cpu:stats(cpu),scope:'One connected MCU protocol emulator; group stop request through native port invalidation, output-stop initiation and file fault observer. Excludes physical output ACK, network fault detection and real hardware.'}));
assert(elapsed[5]<10&&cpu[5]<10,'Idle fault notification exceeds 10ms desktop median wall/CPU budget');
