import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {NativeLinearHomingPort} from '../src/homing/native-linear-port.ts';
import {createGuardedBedMeshPort} from '../src/motion/guarded-bed-mesh-port.ts';
import {LinearKinematics} from '../src/kinematics/linear.ts';
import {ExtrusionGuard} from '../src/motion/extrusion.ts';
import {motionLimits} from '../src/motion/lookahead.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {rebuiltFixture} from '../test/helpers/rebuilt-motion.ts';
assert.equal(typeof global.gc,'function','Run with --expose-gc to isolate initialization garbage from admission CPU');
const elapsed:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let round=0;round<14;round++)for(const managed of round%2?[1,0]:[0,1]){
 const f=await rebuiltFixture(false,true);let port:NativeLinearHomingPort|undefined;
 try{
  const generation=await bindRebuiltMotion(f.options),kinematics=new LinearKinematics({kind:'cartesian',ranges:[[0,200],[0,200],[0,200]],maxVelocity:100,maxAccel:1000,maxZVelocity:5,maxZAccel:100});kinematics.markHomed([0,1,2]);
  const shared={kinematics,limits:motionLimits(100,1000),extrusion:new ExtrusionGuard({nozzleDiameter:.4,filamentDiameter:1.75,maxCrossSection:1,maxVelocity:30,maxAccel:100,maxDistance:50,instantCornerVelocity:1}),canExtrude:()=>true};
  const groups=[{members:[{physicalMember:0,trigger:f.options.members[0].trigger,emitters:f.emitters.map(e=>e.id)}],primary:0,endstop:f.endstop,expireTimeout:.25}];
  const direct=createGuardedBedMeshPort({...shared,mesh:null,physicalPosition:f.options.position});
  if(managed)port=new NativeLinearHomingPort({...shared,generation,emitters:f.emitters,kinematicIds:['x','y','z'],groupsByAxis:[groups,groups,groups]});
  global.gc!();
  const target=port??direct,before=f.fw.motion.length,used=process.cpuUsage(),start=performance.now();
  for(let i=0;i<10000;i++)target.move([i%2?50:51,0,0,2],30);
  const ms=performance.now()-start,usage=process.cpuUsage(used);
  assert.deepEqual(target.position(),[50,0,0,2]);assert.equal(port?port.status.pendingMoves:direct.pending,10000);assert.equal(f.fw.motion.length,before);assert.equal(f.stops,0);
  if(round>=3){elapsed[managed].push(ms);cpu[managed].push((usage.user+usage.system)/1000);}
  direct.shutdown();
 }finally{if(port)await port.dispose();await f.close();}
}
for(const s of [...elapsed,...cpu])s.sort((a,b)=>a-b);const stats=(s:number[])=>({medianMs:s[5],p95Ms:s[10]});
console.log(JSON.stringify({node:process.version,samples:11,moves:10000,direct:{elapsed:stats(elapsed[0]),cpu:stats(cpu[0])},nativePort:{elapsed:stats(elapsed[1]),cpu:stats(cpu[1])},scope:'guarded motion admission and native port health checks; explicit GC before each sample; setup, trajectory generation, transport and MCU-time waiting excluded; no hardware'}));
assert(elapsed[1][5]<=elapsed[0][5]*1.5+2,'Native port admission median overhead exceeds 50% plus 2ms');assert(cpu[1][5]<=cpu[0][5]*1.5+2,'Native port admission CPU overhead exceeds 50% plus 2ms');
