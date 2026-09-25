import assert from 'node:assert/strict';
import {nativeLinearFixture} from '../test/helpers/native-linear-port.ts';
import {NativeLinearGCode} from '../src/runtime/native-linear-gcode.ts';
const t=await nativeLinearFixture(0,()=>true,true),times:number[]=[],count=1000;
const rails=[51,0,0].map(endstop=>({endstop,positiveDirection:false,speed:10,retractDistance:0,retractSpeed:10,secondSpeed:5,endstops:['test']}));
let reports=0;const g=new NativeLinearGCode(t.port,t.kinematics,rails,()=>{reports++;},5000,1,undefined,{stepper:'e',name:'extruder'});
try{
 g.enable();
 // Disabled pressure retains requested smoothing without generating an idle
 // native horizon. This isolates real parser/dispatch/owner/status/report cost.
 await g.dispatch.execute('SET_PRESSURE_ADVANCE ADVANCE=0',{boundary:'checkpoint'});
 const packets=t.f.fw.motion.length,before=t.generation.source.status.sourceTime;
 for(let sample=0;sample<14;sample++){
  const start=performance.now();
  for(let i=0;i<count;i++)await g.dispatch.execute(`SET_PRESSURE_ADVANCE EXTRUDER=extruder SMOOTH_TIME=${i%2?.04:.12}`,{boundary:'checkpoint'});
  if(sample>=3)times.push((performance.now()-start)*1000/count);
  assert.deepEqual(g.pressureAdvance!.pressureAdvance,{advance:0,smoothTime:.04});
  assert.equal(t.f.fw.motion.length,packets);assert.equal(t.generation.source.status.sourceTime,before);
 }
 times.sort((a,b)=>a-b);assert.equal(reports,14001);assert.equal(t.f.stops,0);assert(times[5]!<150);assert(times[10]!<300);
 console.log(JSON.stringify({node:process.version,iterationsPerSample:count,samples:11,medianUs:times[5],p95Us:times[10],maximumMedianUs:150,maximumP95Us:300,scope:'real G-code parser, serialized native owner, checkpoint and reports; disabled pressure, simulated MCU; continuous extrusion measured separately'},null,2));
}finally{await g.close();await t.close();}
