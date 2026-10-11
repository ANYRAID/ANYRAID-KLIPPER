import test from 'node:test';
import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {sampleTrapMotion,liveMotionStatus} from '../src/motion/live-status.ts';
test('configured live queues report zero requested velocity before their first motion phase',()=>{
 using xyz=new TrapQueue();using e=new TrapQueue();
 const routes=[{queue:xyz},{queue:e,extrusionAxis:3}];
 assert.deepEqual(liveMotionStatus(routes,9,3),{live_position:null,live_velocity:0,live_extruder_velocity:0});
 xyz.appendRaw(new Float64Array([10,1,1,1,2,3,4,.6,.8,0,0,10,10]));
 e.appendRaw(new Float64Array([10,1,1,1,7,0,0,1,0,0,0,-2,-2]));
 const before=routes.map(route=>route.queue.extract(20,0,100));
 assert.deepEqual(liveMotionStatus(routes,9,3),{live_position:null,live_velocity:0,live_extruder_velocity:0});
 // Mainsail's speed/flow getters require numbers, even before execution.
 const status=liveMotionStatus(routes,9,3);
 assert.equal(Math.abs(Number(status.live_velocity!.toFixed(0))),0);
 assert.equal(((1.75/2)**2*Math.PI*status.live_extruder_velocity!).toFixed(1),'0.0');
 assert.deepEqual(routes.map(route=>route.queue.extract(20,0,100)),before);
 assert.deepEqual(liveMotionStatus([],9,3),{live_position:null,live_velocity:null,live_extruder_velocity:null});
 assert.equal(liveMotionStatus(routes,9,4).live_extruder_velocity,null);
});
test('live motion samples acceleration, cruise, deceleration and idle from native phases',t=>{
 using xyz=new TrapQueue();using e=new TrapQueue();using second=new TrapQueue();
 // 1 s acceleration 0 -> 10, 1 s cruise, 1 s deceleration: distance 20.
 xyz.appendRaw(new Float64Array([10,1,1,1,2,3,4,.6,.8,0,0,10,10]));
 e.appendRaw(new Float64Array([10,1,1,1,7,0,0,1,0,0,0,-2,-2]));
 second.appendRaw(new Float64Array([10,1,1,1,9,0,0,1,0,0,0,4,4]));
 const routes=[{queue:xyz},{queue:e,extrusionAxis:3},{queue:second,extrusionAxis:4}];
 assert.equal(sampleTrapMotion(xyz,9),null);
 for(const [time,distance,velocity] of [[10.5,1.25,5],[11.5,10,10],[12.5,18.75,5],[14,20,0]]){
  const status=liveMotionStatus(routes,time,3);
  assert.deepEqual(status.live_position,[2+.6*distance,3+.8*distance,4,7-.2*distance]);
  assert.equal(status.live_velocity,velocity);assert.equal(status.live_extruder_velocity,velocity===0?0:-.2*velocity);
 }
 assert.equal(liveMotionStatus(routes,11.5,4).live_extruder_velocity,4);
 assert.equal(liveMotionStatus(routes,11.5,5).live_extruder_velocity,null);
 assert.throws(()=>sampleTrapMotion(xyz,NaN),/observation/);
 const before=xyz.extract(20,0,100);const start=performance.now();for(let i=0;i<10000;i++)liveMotionStatus(routes,11.5,3);
 t.diagnostic(JSON.stringify({sampleMeanUs:(performance.now()-start)*1000/10000,queries:10000,scope:'desktop native XYZ and active extruder read'}));
 assert.deepEqual(xyz.extract(20,0,100),before);
});
