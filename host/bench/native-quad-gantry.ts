import assert from 'node:assert/strict';
import {nativeLinearFixture} from '../test/helpers/native-linear-port.ts';
const times:number[]=[];
for(let i=0;i<7;i++){
 const t=await nativeLinearFixture(0,()=>false,false,undefined,true,false,false,undefined,undefined,undefined,false,undefined,undefined,3),signal=new AbortController().signal;
 try{
  t.kinematics.markHomed([0,1,2]);await t.port.forcePosition([50,0,1,2],signal);
  const start=performance.now();await t.port.adjustQuadGantry([[0,0,0],[0,100,.1],[100,100,.4],[100,0,.2]],[[0,0],[100,100]],['z','z1','z2','z3'],1,2,signal);const elapsed=performance.now()-start;
  const counts=[2,10,11,12].map(oid=>t.f.fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===oid).reduce((n,m)=>n+Number(m.parameters.count),0));assert.deepEqual(counts,[0,10,40,20]);
  if(i>=2)times.push(elapsed);
 }finally{await t.close();}
}
times.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,iterations:7,warmup:2,medianMs:times[2],maxMs:times.at(-1),times,scope:'Four Z motors, three physical segments and final coordinate rebase. Includes simulated MCU clock waits, stop confirmations and native step generation; excludes probing and setup. Not physical hardware or an equal-work Python comparison.'},null,2));
