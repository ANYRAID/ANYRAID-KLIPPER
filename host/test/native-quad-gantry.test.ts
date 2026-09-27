import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
for(const mode of ['twisted','flat','cancelled','limit'])test(`native four Z gantry executes and restores common motion mode=${mode}`,async()=>{
 const t=await nativeLinearFixture(0,()=>false,false,undefined,true,false,false,undefined,undefined,undefined,false,undefined,undefined,3),s=new AbortController().signal;
 const points=[[0,0],[0,100],[100,100],[100,0]].map(([x,y],i)=>[x,y,mode==='flat'?.88:[0,.1,.4,.2][i]]),ids=['z','z1','z2','z3'];
 try{
  t.kinematics.markHomed([0,1,2]);await t.port.forcePosition([50,0,1,2],s);
  const counts=()=>[2,10,11,12].map(oid=>t.f.fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===oid).reduce((sum,m)=>sum+Number(m.parameters.count),0));
  if(mode==='cancelled'){
   const abort=new AbortController(),timer=setInterval(()=>{if(counts()[2])abort.abort(new Error('cancel gantry'));},1);
   try{await assert.rejects(t.port.adjustQuadGantry(points,[[0,0],[100,100]],ids,1,1,abort.signal));}finally{clearInterval(timer);}
   assert(t.port.status.failed);assert.equal(t.kinematics.status.homedAxes,'');assert.equal(t.port.quadGantryStatus.applied,false);return;
  }
  if(mode==='limit'){await assert.rejects(t.port.adjustQuadGantry(points,[[0,0],[100,100]],ids,.3,2,s),/travel limit/);assert.deepEqual(counts(),[0,0,0,0]);return;}
  const pending=t.port.adjustQuadGantry(points,[[0,0],[100,100]],ids,1,2,s);assert.throws(()=>t.port.move([50,0,2,2],2),/busy/);const plan=await pending;
  assert.deepEqual(counts(),mode==='flat'?[0,0,0,0]:[0,10,40,20]);assert.equal(t.port.homingPosition()[2],plan.finalZ);assert.equal(t.port.quadGantryStatus.applied,true);assert.equal(t.port.zTiltStatus.applied,false);
  const before=counts(),target=[...t.port.position()];target[2]+=.1;t.port.move(target,2);await t.port.drain(s);assert.deepEqual(counts().map((v,i)=>v-before[i]),[10,10,10,10]);
  await t.port.releaseMotors(s);assert.equal(t.port.quadGantryStatus.applied,false);
 }finally{await t.close();}
});
