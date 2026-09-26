import assert from 'node:assert/strict';
import {nativeLinearFixture} from '../test/helpers/native-linear-port.ts';
import {NativeLinearGCode} from '../src/runtime/native-linear-gcode.ts';
import {BedMesh} from '../src/motion/bed-mesh.ts';
const rails=[51,0,0].map(endstop=>({endstop,positiveDirection:false,speed:10,retractDistance:0,retractSpeed:10,secondSpeed:5,endstops:['test']})),s=new AbortController().signal;
const mesh=new BedMesh({min_x:0,max_x:100,min_y:0,max_y:100,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct',tension:.2},[[.2,.2],[.2,.2]]);
const offsetSwitchMs:number[]=[];
const samples={plain:{wall:[] as number[],cpu:[] as number[]},mesh:{wall:[] as number[],cpu:[] as number[]}},script=Array.from({length:1000},(_,i)=>`G1 X${50+(i+1)/1000} F600`).join('\n');
for(let run=0;run<14;run++)for(const mode of (run%2?['plain','mesh']:['mesh','plain']) as ('plain'|'mesh')[]){
 const t=await nativeLinearFixture();let g:NativeLinearGCode|undefined;
 try{
  t.kinematics.markHomed([0,1,2]);await t.port.forcePosition([50,0,1,2],s);if(mode==='mesh'){await t.port.replaceBedMesh(mesh,{},s);const start=performance.now();assert.equal(await t.port.offsetBedMesh(10,-10,.25,s),true);if(run>=3)offsetSwitchMs.push(performance.now()-start);}
  g=new NativeLinearGCode(t.port,t.kinematics,rails,()=>{});g.enable();const before=t.f.fw.motion.length,used=process.cpuUsage(),start=performance.now();await g.dispatch.execute(script);const wall=performance.now()-start,cpu=process.cpuUsage(used);
  assert.deepEqual(t.port.homingPosition(),[51,0,1,2]);const moves=t.f.fw.motion.slice(before).filter(m=>m.name==='queue_step');assert.equal(moves.filter(m=>m.parameters.oid===3).reduce((n,m)=>n+Number(m.parameters.count),0),100);assert.equal(moves.filter(m=>m.parameters.oid===2).length,0);assert.equal(t.f.stops,0);
  if(run>=3){samples[mode].wall.push(wall);samples[mode].cpu.push((cpu.user+cpu.system)/1000);}
 }finally{await g?.close();await t.close();}
}
const stats=(a:number[])=>{a.sort((x,y)=>x-y);return {medianMs:a[5],p95Ms:a[10]};},plain={wall:stats(samples.plain.wall),cpu:stats(samples.plain.cpu)},compensated={wall:stats(samples.mesh.wall),cpu:stats(samples.mesh.cpu)};
console.log(JSON.stringify({node:process.version,commands:1000,warmups:3,runs:11,plain,compensated,offsetSwitch:stats(offsetSwitchMs),exactXPulses:100,exactZPulses:0,scope:'Paired constant saved mesh versus no mesh for the same physical path through actual native steps and simulated MCU drain; variable mesh splitting and physical target acceptance remain separate.'}));assert(compensated.wall.medianMs<=plain.wall.medianMs*1.3+10);assert(compensated.cpu.medianMs<=plain.cpu.medianMs*1.3+2);

assert(stats(offsetSwitchMs).p95Ms<20,'Idle mesh offset switch exceeds 20 ms local budget');
