import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {nativeLinearFixture} from '../test/helpers/native-linear-port.ts';
import {NativeLinearGCode} from '../src/runtime/native-linear-gcode.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
const rails=[51,0,0].map(endstop=>({endstop,positiveDirection:false,speed:10,retractDistance:0,retractSpeed:10,secondSpeed:5,endstops:['test']}));
const script=Array.from({length:1000},(_,i)=>`G1 X${50+(i+1)/1000} F600`).join('\n');
const samples={manual:{wall:[] as number[],cpu:[] as number[]},assembled:{wall:[] as number[],cpu:[] as number[]}};
for(let i=0;i<14;i++)for(const mode of (i%2?['assembled','manual']:['manual','assembled']) as ('manual'|'assembled')[]){
 const t=await nativeLinearFixture();let owner:NativeLinearGCode|undefined;
 try{
  t.kinematics.markHomed([0]);let dispatch:GCodeDispatch;
  if(mode==='assembled'){owner=new NativeLinearGCode(t.port,t.kinematics,rails,()=>{});owner.enable();dispatch=owner.dispatch;}
  else{dispatch=new GCodeDispatch({output(){},shutdown:r=>{void t.port.motorOff(new Error(r)).catch(()=>{});},checkpoint:s=>t.port.flush(s),drain:s=>t.port.drain(s)});dispatch.register('G1',c=>t.coordinates.execute('G1',c.params));dispatch.setReady(true);}
  const used=process.cpuUsage(),start=performance.now();await dispatch.execute(script);const wall=performance.now()-start,cpu=process.cpuUsage(used);
  assert.equal(t.f.stops,0);assert.deepEqual(t.port.position(),[51,0,0,2]);assert.equal(t.generation.motion.bindings.find(b=>b.id==='x')!.history.status.lastPlannedPosition,200n);
  assert.equal(t.f.fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===3).reduce((sum,m)=>sum+Number(m.parameters.count),0),100);
  if(i>=3){samples[mode].wall.push(wall);samples[mode].cpu.push((cpu.user+cpu.system)/1000);}
 }finally{await owner?.close();await t.close();}
}
const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[5],p95Ms:v[10]};};
const manual={wall:stats(samples.manual.wall),cpu:stats(samples.manual.cpu)},assembled={wall:stats(samples.assembled.wall),cpu:stats(samples.assembled.cpu)};
console.log(JSON.stringify({node:process.version,commands:1000,samples:11,manual,assembled,exactPulses:100,scope:'Serial firmware emulator, real native queue/step generation and MCU clock drain; excludes physical printer throughput.'}));
assert(assembled.wall.medianMs<=manual.wall.medianMs*1.3+10,'Assembled motion wall time regression');
assert(assembled.cpu.medianMs<=manual.cpu.medianMs*1.3+2,'Assembled motion CPU regression');
