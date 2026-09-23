import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {rebuiltFixture} from '../test/helpers/rebuilt-motion.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {NativeLinearHomingPort} from '../src/homing/native-linear-port.ts';
import {LinearKinematics} from '../src/kinematics/linear.ts';
import {ExtrusionGuard} from '../src/motion/extrusion.ts';
import {motionLimits} from '../src/motion/lookahead.ts';
import {NativePauseParking} from '../src/operations/native-pause-parking.ts';
import {inputShaper} from '../src/motion/shaper.ts';
const park=process.argv.includes('--park');
const pauseMs:number[]=[],pauseCpu:number[]=[],resumeMs:number[]=[],resumeCpu:number[]=[];
for(let i=0;i<14;i++){
 const f=await rebuiltFixture(false,true),cancel=new AbortController(),cause=new Error('native pause benchmark complete');let port:NativeLinearHomingPort|undefined,running:Promise<void>|undefined;
 try{
  const g=await bindRebuiltMotion(f.options);g.motion.bindings[0].stepper.configureShapers({x:inputShaper('mzv',40,.1)});g.motion.bindings.find(b=>b.id==='e')?.stepper.configurePressureAdvance(.05,.04);
  const kinematics=new LinearKinematics({kind:'cartesian',ranges:[[0,200],[0,200],[0,200]],maxVelocity:100,maxAccel:100,maxZVelocity:5,maxZAccel:100});kinematics.markHomed([0,1,2]);
  port=new NativeLinearHomingPort({generation:g,kinematics,emitters:f.emitters,kinematicIds:['x','y','z'],groupsByAxis:[[],[],[]],limits:motionLimits(100,100,5,0),extrusion:new ExtrusionGuard({nozzleDiameter:.4,filamentDiameter:1.75,maxCrossSection:1,maxVelocity:30,maxAccel:100,maxDistance:50,instantCornerVelocity:1}),canExtrude:()=>true});
  const parking=park?new NativePauseParking(port,{parkXY:[51,.2],retract:.1,lift:.2,travelSpeed:30,liftSpeed:5,retractSpeed:10}):undefined;
  port.move([150,0,0,12],10);running=assert.rejects(port.drain(cancel.signal),error=>error===cause);
  const deadline=performance.now()+3000;while(!f.fw.motion.some(m=>m.name==='queue_step')){assert(performance.now()<deadline);await delay(2);}
  let used=process.cpuUsage(),start=performance.now();if(parking)await parking.pause(cancel.signal);else await port.pauseStream(cancel.signal);const stopped={position:port.status.pausePosition!},paused=performance.now()-start,pc=process.cpuUsage(used);
  assert(stopped.position[0]>50&&stopped.position[0]<150);assert.equal(f.stops,0);
  const x=g.motion.bindings.find(b=>b.id==='x')!,e=g.motion.bindings.find(b=>b.id==='e')!;
  const actual=g.source.status.position;assert.equal(x.history.status.lastPlannedPosition,100n+BigInt(Math.round((actual[0]-50)/.01)));assert.equal(e.history.status.lastPlannedPosition,20n+BigInt(Math.round((actual[3]-2)/.01)));
  used=process.cpuUsage();start=performance.now();if(parking)await parking.resume(cancel.signal);else await port.resumeStream(cancel.signal);const resumed=performance.now()-start,rc=process.cpuUsage(used);
  if(i>=3){pauseMs.push(paused);pauseCpu.push((pc.user+pc.system)/1000);resumeMs.push(resumed);resumeCpu.push((rc.user+rc.system)/1000);}
 }finally{cancel.abort(cause);try{await running;}finally{await port?.dispose();await f.close();}}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};
console.log(JSON.stringify({node:process.version,samples:11,parking:park,pause:stats(pauseMs),pauseCpu:stats(pauseCpu),resumeAck:stats(resumeMs),resumeCpu:stats(resumeCpu),scope:(park?'Includes configured retract/lift/parking and drained return before resumption. ':'')+'Native port pause through sampled MCU drain; live guard and fresh lead resume acknowledgement, not suffix completion. MZV and pressure advance, protocol emulator, no physical printer.'}));
assert(pauseMs[5]<(park?3000:1200)&&pauseCpu[5]<30,'Native port pause exceeds desktop median budget');assert(resumeMs[5]<(park?3000:100)&&resumeCpu[5]<30,'Native resume acknowledgement exceeds desktop median budget');
