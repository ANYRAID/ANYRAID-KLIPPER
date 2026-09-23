import test from 'node:test';
import assert from 'node:assert/strict';
import {ScheduledCoolingFan,type FanOutput} from '../src/outputs/fan.ts';
import {FanBoundaryTimeline} from '../src/outputs/fan-boundaries.ts';
const signal=()=>new AbortController().signal;
async function fixture(kick=0){const writes:number[][]=[];let resets=0,stops=0;const output:FanOutput={configuration:{initialPower:0,defaultPower:0,maximumDuration:0},reset:async()=>{resets++;},setPWM:async(t,v)=>{writes.push([t,v]);},stop:async()=>{stops++;}};const fan=new ScheduledCoolingFan(output,{kickStartTime:kick,minimumScheduleTime:.01});await fan.start(signal());const timeline=new FanBoundaryTimeline(fan,4);return {timeline,fan,output,writes,get resets(){return resets;},get stops(){return stops;}};}
test('fan timeline delivers each resolved marker once and reclaims only after a clock fence',async()=>{
 const f=await fixture(),a=f.timeline.register(.25),b=f.timeline.register(.5),plan=[{id:a,time:1},{id:b,time:2}];
 try{await f.timeline.deliver(plan,1,signal());assert.deepEqual(f.writes,[[1,.25]]);f.timeline.retireThrough(.9);assert.equal(f.timeline.status.pending,2);f.timeline.retireThrough(1);assert.equal(f.timeline.status.pending,1);
  await f.timeline.deliver(plan,2,signal());await f.timeline.deliver([{id:b,time:2}],2.5,signal());assert.deepEqual(f.writes,[[1,.25],[2,.5]]);f.timeline.retireThrough(2.5);assert.equal(f.timeline.status.pending,0);assert(f.timeline.register(0)>b);
 }finally{await f.timeline.stop();}
});
test('kick repeat delays the conservative retirement fence beyond the requested endpoint',async()=>{
 const f=await fixture(.1),id=f.timeline.register(.5);try{await f.timeline.deliver([{id,time:1}],1,signal());f.timeline.retireThrough(1);assert.equal(f.timeline.status.pending,1);assert.equal(f.timeline.status.nextTime,1.1);
  await f.timeline.deliver([],1.1,signal());f.timeline.retireThrough(1.05);assert.equal(f.timeline.status.pending,1);f.timeline.retireThrough(1.1);assert.equal(f.timeline.status.pending,0);assert.deepEqual(f.writes,[[1,1],[1.1,.5]]);
 }finally{await f.timeline.stop();}
});
test('unknown late batch marker is rejected before any prefix writes',async()=>{
 const f=await fixture(),id=f.timeline.register(.25);await assert.rejects(f.timeline.deliver([{id,time:1},{id:999,time:2}],2,signal()),/Unknown/);assert.deepEqual(f.writes,[]);assert.equal(f.stops,1);assert.equal(f.timeline.status.stopped,true);
});
test('retiming submitted markers without generation reset fails closed',async()=>{
 const f=await fixture(),id=f.timeline.register(.25);await f.timeline.deliver([{id,time:1}],1,signal());await assert.rejects(f.timeline.deliver([{id,time:2}],2,signal()),/without reset/);assert.deepEqual(f.writes,[[1,.25]]);assert.equal(f.stops,1);
});
test('replacement waits for reset ACK, owns the retained ids and accepts fresh endpoint times',async()=>{
 const f=await fixture(),a=f.timeline.register(.25),b=f.timeline.register(.5);await f.timeline.deliver([{id:a,time:1},{id:b,time:4}],1,signal());f.timeline.retireThrough(1);
 const gate=Promise.withResolvers<void>();f.output.reset=()=>gate.promise;const retained=[b],replacing=f.timeline.replace(retained,signal());retained[0]=99;assert.throws(()=>f.timeline.register(0),/busy/);assert.equal(f.timeline.status.pending,1);gate.resolve();await replacing;
 await f.timeline.deliver([{id:b,time:10}],10,signal());assert.deepEqual(f.writes,[[1,.25],[10,.5]]);f.timeline.retireThrough(10);assert.equal(f.timeline.status.pending,0);await f.timeline.stop();
});
test('unsubmitted output whose timestamp has passed cannot be emitted late',async()=>{
 const f=await fixture(),id=f.timeline.register(.5);await f.timeline.deliver([{id,time:1}],0,signal());f.timeline.retireThrough(2);await assert.rejects(f.timeline.deliver([],3,signal()),/late/);assert.deepEqual(f.writes,[]);assert.equal(f.stops,1);
});
test('stop during reset cannot resurrect retained requests on late success',async()=>{
 const f=await fixture(),id=f.timeline.register(.5),gate=Promise.withResolvers<void>();f.output.reset=()=>gate.promise;const pending=f.timeline.replace([id],signal()),failed=assert.rejects(pending);await f.timeline.stop(new Error('cancel'));gate.resolve();await failed;assert.equal(f.timeline.status.pending,0);assert.throws(()=>f.timeline.register(.5),/stopped/);
});
test('timeline rejects duplicate owners, capacity overflow and sparse retained sets',async()=>{
 const f=await fixture();try{assert.throws(()=>new FanBoundaryTimeline(f.fan),/ownership/);for(let i=0;i<4;i++)f.timeline.register(i/4);assert.throws(()=>f.timeline.register(1),/capacity/);await assert.rejects(f.timeline.replace(new Array(1),signal()),/retained/);assert.equal(f.resets,1);}finally{await f.timeline.stop();}
});
