import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
for(const mode of ['normal','flat','fractional','failure','missing','range'])test(`native mechanical Z tilt restores all motors mode=${mode}`,async()=>{
 const t=await nativeLinearFixture(0,()=>false,false,undefined,true,false,false,undefined,undefined,undefined,false,undefined,undefined,2),s=new AbortController().signal;
 const motors=[{id:'z',x:0,y:0},{id:'z1',x:100,y:0},{id:'z2',x:0,y:100}];
 const samples=mode==='fractional'?[[0,0,0],[100,0,.006],[0,100,.012]]:mode==='flat'?[[0,0,.25],[100,0,.25],[0,100,.25]]:[[0,0,0],[100,0,.2],[0,100,.4]];
 try{
  t.kinematics.markHomed([0,1,2]);await t.port.forcePosition([50,0,1,2],s);
  const steps=(oid:number)=>t.f.fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===oid).reduce((n,m)=>n+Number(m.parameters.count),0);
  const before=[steps(2),steps(10),steps(11)];
  if(mode==='missing'||mode==='range'){await assert.rejects(t.port.adjustZTilt(samples,mode==='missing'?motors.slice(0,2):motors,mode==='range'?.1:1,2,s));assert.deepEqual([steps(2),steps(10),steps(11)],before);assert(t.port.status.failed);return;}
  if(mode==='failure'){
   const abort=new AbortController(),timer=setInterval(()=>{if(steps(11)>before[2])abort.abort(new Error('cancel mechanical adjustment'));},1);
   try{await assert.rejects(t.port.adjustZTilt(samples,motors,1,1,abort.signal));}finally{clearInterval(timer);}
   assert(t.port.status.failed);assert.equal(t.kinematics.status.homedAxes,'');assert.equal(t.f.options.group.status.state,'stopped');assert.throws(()=>t.port.move([50,0,2,2],1),/stopped/);return;
  }
  const pending=t.port.adjustZTilt(samples,motors,1,2,s);assert.throws(()=>t.port.move([50,0,2,2],1),/busy/);const result=await pending;
  assert.deepEqual([steps(2)-before[0],steps(10)-before[1],steps(11)-before[2]],mode==='flat'?[0,0,0]:mode==='fractional'?[0,1,2]:[0,20,40]);
  assert.equal(t.port.homingPosition()[2],result.finalZ);assert.equal(t.port.status.failed,false);
  const at=[steps(2),steps(10),steps(11)],target=[...t.port.position()];target[2]+=.1;t.port.move(target,2);await t.port.drain(s);
  assert.deepEqual([steps(2)-at[0],steps(10)-at[1],steps(11)-at[2]],[10,10,10]);
 }finally{await t.close();}
});
